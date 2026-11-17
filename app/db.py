"""SQLite (stdlib, WAL) storage for tunes, rate limits and housekeeping.

Raw .msq bytes live on the data volume as `<slug>.msq`; the filename is
derived from the random slug only, never from user input.
"""
from __future__ import annotations

import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import string
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path

from .parser import TuneDoc

log = logging.getLogger(__name__)

SLUG_ALPHABET = string.ascii_letters + string.digits
SLUG_LEN = 10
SLUG_RE = re.compile(r"^[A-Za-z0-9]{10}$")

PURGE_AFTER_DAYS = 180
TOUCH_INTERVAL = 6 * 3600  # don't write last_viewed_at on every page view


def _pick_data_dir() -> Path:
    env = os.environ.get("DATA_DIR")
    if env:
        return Path(env)
    if Path("/data").is_dir() and os.access("/data", os.W_OK):
        return Path("/data")
    return Path(__file__).resolve().parent.parent / "data"


class Store:
    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = Path(data_dir) if data_dir else _pick_data_dir()
        self.tune_dir = self.data_dir / "tunes"
        self.log_dir = self.data_dir / "logs"
        self.db_path = self.data_dir / "msq.db"
        self._cache: OrderedDict[str, TuneDoc] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._index_cache: OrderedDict[str, tuple] = OrderedDict()
        self._rev_cache: dict[str, str] = {}

    # ------------------------------------------------------------ plumbing
    @property
    def persistent(self) -> bool:
        """True when tunes survive a redeploy: the data directory is (or sits on) a mounted volume."""
        path = self.data_dir.resolve()
        for p in (path, *path.parents):
            if p == Path(p.anchor):
                return False
            if os.path.ismount(p):
                return True
        return False

    def init(self) -> None:
        self.tune_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        if not self.persistent:
            log.warning("storing tunes in %s, which is not a mounted volume: every redeploy deletes all tunes. "
                        "On Railway, add a volume mounted at /data.", self.data_dir)
        with self.conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS tunes (
                    slug TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    last_viewed_at INTEGER NOT NULL,
                    delete_key_hash TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    signature TEXT NOT NULL,
                    family TEXT NOT NULL,
                    parsed_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS tunes_last_viewed ON tunes(last_viewed_at);
                CREATE TABLE IF NOT EXISTS logs (
                    slug TEXT PRIMARY KEY,
                    tune_slug TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_viewed_at INTEGER NOT NULL,
                    delete_key_hash TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    report_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS logs_tune ON logs(tune_slug);
                CREATE INDEX IF NOT EXISTS logs_last_viewed ON logs(last_viewed_at);
                CREATE TABLE IF NOT EXISTS uploads (
                    ip_hash TEXT NOT NULL,
                    ts INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS uploads_ip_ts ON uploads(ip_hash, ts);
                """
            )
            # Added with tune editing: the slug an edited copy was saved from.
            cols = {r["name"] for r in c.execute("PRAGMA table_info(tunes)")}
            if "parent" not in cols:
                c.execute("ALTER TABLE tunes ADD COLUMN parent TEXT")
            # Added with editing together: shared notes, and a key that lets friends edit (but not delete).
            if "notes" not in cols:
                c.execute("ALTER TABLE tunes ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
            if "edit_key_hash" not in cols:
                c.execute("ALTER TABLE tunes ADD COLUMN edit_key_hash TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def conn(self):
        c = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=15000")
        c.execute("PRAGMA synchronous=NORMAL")
        try:
            yield c
        finally:
            c.close()

    def raw_path(self, slug: str) -> Path:
        if not SLUG_RE.match(slug):
            raise ValueError("bad slug")
        return self.tune_dir / f"{slug}.msq"

    # --------------------------------------------------------------- tunes
    @staticmethod
    def _hash_key(key: str) -> str:
        return hashlib.sha256(key.encode()).hexdigest()

    def create_tune(self, raw: bytes, doc: TuneDoc, parent: str | None = None,
                    slug: str | None = None) -> tuple[str, str]:
        """Store a tune under a new slug (or `slug`, when restoring a link that existed before)."""
        delete_key = secrets.token_urlsafe(18)
        now = int(time.time())
        parsed = json.dumps(doc.to_dict(), separators=(",", ":"))
        wanted = slug
        if wanted is not None and not SLUG_RE.match(wanted):
            raise ValueError("bad slug")
        for _ in range(1 if wanted else 8):
            slug = wanted or "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LEN))
            path = self.raw_path(slug)
            if path.exists():
                continue
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, path)
            try:
                with self.conn() as c:
                    c.execute(
                        "INSERT INTO tunes (slug, created_at, last_viewed_at, delete_key_hash, sha256, size, "
                        "signature, family, parsed_json, parent) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (slug, now, now, self._hash_key(delete_key), hashlib.sha256(raw).hexdigest(),
                         len(raw), doc.signature, doc.family, parsed, parent),
                    )
            except sqlite3.IntegrityError:
                path.unlink(missing_ok=True)
                continue
            except Exception:
                path.unlink(missing_ok=True)
                raise
            return slug, delete_key
        raise RuntimeError("could not allocate slug")

    def edit_key(self, slug: str) -> str:
        """A fresh key that lets whoever holds it edit this tune in place (not delete it)."""
        key = secrets.token_urlsafe(12)
        with self.conn() as c:
            c.execute("UPDATE tunes SET edit_key_hash=? WHERE slug=?", (self._hash_key(key), slug))
        return key

    def can_edit(self, slug: str, key: str) -> bool:
        """The delete key (the owner) or the edit key (friends editing together)."""
        if not SLUG_RE.match(slug or "") or not key:
            return False
        with self.conn() as c:
            row = c.execute("SELECT delete_key_hash, edit_key_hash FROM tunes WHERE slug=?", (slug,)).fetchone()
        if not row:
            return False
        h = self._hash_key(key)
        return hmac.compare_digest(row["delete_key_hash"], h) or bool(row["edit_key_hash"]) and hmac.compare_digest(row["edit_key_hash"], h)

    def rev(self, slug: str) -> str | None:
        """Changes whenever the tune's values or notes change: what open pages poll to stay current. Kept in
        memory (one process), so a poll costs no disk read."""
        if not SLUG_RE.match(slug or ""):
            return None
        hit = self._rev_cache.get(slug)
        if hit is not None:
            return hit
        with self.conn() as c:
            row = c.execute("SELECT sha256, notes FROM tunes WHERE slug=?", (slug,)).fetchone()
        if not row:
            return None
        rev = row["sha256"][:16] + hashlib.sha256((row["notes"] or "").encode()).hexdigest()[:8]
        if len(self._rev_cache) > 2000:
            self._rev_cache.clear()
        self._rev_cache[slug] = rev
        return rev

    def notes(self, slug: str) -> str:
        with self.conn() as c:
            row = c.execute("SELECT notes FROM tunes WHERE slug=?", (slug,)).fetchone()
        return (row["notes"] or "") if row else ""

    def set_notes(self, slug: str, text: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE tunes SET notes=? WHERE slug=?", (text, slug))
        self._rev_cache.pop(slug, None)

    def replace_tune(self, slug: str, raw: bytes, doc: TuneDoc) -> None:
        """Overwrite an edited copy in place (its owner saving again), so its link shows the latest edits."""
        path = self.raw_path(slug)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, path)
        with self.conn() as c:
            c.execute(
                "UPDATE tunes SET sha256=?, size=?, signature=?, family=?, parsed_json=?, last_viewed_at=? WHERE slug=?",
                (hashlib.sha256(raw).hexdigest(), len(raw), doc.signature, doc.family,
                 json.dumps(doc.to_dict(), separators=(",", ":")), int(time.time()), slug),
            )
        with self._cache_lock:
            self._cache.pop(slug, None)
        self._rev_cache.pop(slug, None)

    def get_meta(self, slug: str) -> sqlite3.Row | None:
        if not SLUG_RE.match(slug or ""):
            return None
        with self.conn() as c:
            return c.execute(
                "SELECT slug, created_at, last_viewed_at, size, signature, family, parent FROM tunes WHERE slug=?",
                (slug,),
            ).fetchone()

    def get_doc(self, slug: str) -> TuneDoc | None:
        if not SLUG_RE.match(slug or ""):
            return None
        with self._cache_lock:
            if slug in self._cache:
                self._cache.move_to_end(slug)
                return self._cache[slug]
        with self.conn() as c:
            row = c.execute("SELECT parsed_json FROM tunes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            return None
        doc = TuneDoc.from_dict(json.loads(row["parsed_json"]))
        with self._cache_lock:
            self._cache[slug] = doc
            while len(self._cache) > 24:
                self._cache.popitem(last=False)
        return doc

    def touch(self, slug: str) -> None:
        now = int(time.time())
        with self.conn() as c:
            c.execute(
                "UPDATE tunes SET last_viewed_at=? WHERE slug=? AND last_viewed_at < ?",
                (now, slug, now - TOUCH_INTERVAL),
            )

    def read_raw(self, slug: str) -> bytes | None:
        try:
            return self.raw_path(slug).read_bytes()
        except (OSError, ValueError):
            return None

    def check_delete_key(self, slug: str, key: str) -> bool:
        if not SLUG_RE.match(slug or "") or not key:
            return False
        with self.conn() as c:
            row = c.execute("SELECT delete_key_hash FROM tunes WHERE slug=?", (slug,)).fetchone()
        return bool(row) and hmac.compare_digest(row["delete_key_hash"], self._hash_key(key))

    def delete_tune(self, slug: str) -> None:
        self._rev_cache.pop(slug, None)
        with self.conn() as c:
            gone = [r["slug"] for r in c.execute("SELECT slug FROM logs WHERE tune_slug=?", (slug,))]
            c.execute("DELETE FROM tunes WHERE slug=?", (slug,))
        for log_slug in gone:
            self.delete_log(log_slug)
        with self._cache_lock:
            self._cache.pop(slug, None)
        try:
            self.raw_path(slug).unlink(missing_ok=True)
        except (OSError, ValueError):
            log.exception("failed removing file for %s", slug)

    def purge_stale(self, days: int = PURGE_AFTER_DAYS) -> int:
        cutoff = int(time.time()) - days * 86400
        with self.conn() as c:
            slugs = [r["slug"] for r in c.execute("SELECT slug FROM tunes WHERE last_viewed_at < ?", (cutoff,))]
            c.execute("DELETE FROM uploads WHERE ts < ?", (int(time.time()) - 86400,))
        for s in slugs:
            self.delete_tune(s)
        # Orphaned files (e.g. crash between write and insert).
        with self.conn() as c:
            known = {r["slug"] for r in c.execute("SELECT slug FROM tunes")}
        for p in self.tune_dir.glob("*.msq"):
            if p.stem not in known and p.stat().st_mtime < time.time() - 3600:
                p.unlink(missing_ok=True)
        with self.conn() as c:
            stale_logs = [r["slug"] for r in c.execute(
                "SELECT slug FROM logs WHERE last_viewed_at < ? OR (tune_slug != '' AND tune_slug NOT IN "
                "(SELECT slug FROM tunes))",
                (cutoff,))]
            known_logs = {r["slug"] for r in c.execute("SELECT slug FROM logs")}
        for s in stale_logs:
            self.delete_log(s)
        for p in self.log_dir.iterdir():
            if p.name.split(".")[0] not in known_logs and p.stat().st_mtime < time.time() - 3600:
                p.unlink(missing_ok=True)
        if slugs:
            log.info("purged %d stale tunes", len(slugs))
        return len(slugs)

    # ---------------------------------------------------------------- logs
    def log_path(self, slug: str) -> Path:
        if not SLUG_RE.match(slug):
            raise ValueError("bad slug")
        return self.log_dir / f"{slug}.log"

    def col_path(self, slug: str) -> Path:
        """The log as a column store, which the viewer loads channels from."""
        return self.log_path(slug).with_suffix(".col")

    def create_log(self, raw: bytes, tune_slug: str, name: str, report: dict, columns=None,
                   slug: str | None = None) -> tuple[str, str]:
        """Store a log. `tune_slug` is "" for a log uploaded on its own. `columns(path)` writes its column store.
        `slug` keeps the link of a log being restored."""
        delete_key = secrets.token_urlsafe(18)
        now = int(time.time())
        payload = json.dumps(report, separators=(",", ":"))
        wanted = slug
        if wanted is not None and not SLUG_RE.match(wanted):
            raise ValueError("bad slug")
        for _ in range(1 if wanted else 8):
            slug = wanted or "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LEN))
            path = self.log_path(slug).with_suffix(".log.gz")  # logs are big and squash well
            if path.exists() or self.log_path(slug).exists():
                continue
            tmp = path.with_suffix(".tmp")
            with gzip.open(tmp, "wb", compresslevel=4) as f:
                f.write(raw)
            os.replace(tmp, path)
            try:
                with self.conn() as c:
                    c.execute(
                        "INSERT INTO logs (slug, tune_slug, created_at, last_viewed_at, delete_key_hash, size, "
                        "name, report_json) VALUES (?,?,?,?,?,?,?,?)",
                        (slug, tune_slug, now, now, self._hash_key(delete_key), len(raw), name[:120], payload),
                    )
            except sqlite3.IntegrityError:
                path.unlink(missing_ok=True)
                continue
            except Exception:
                path.unlink(missing_ok=True)
                raise
            if columns is not None:
                try:
                    columns(self.col_path(slug))
                except Exception:
                    log.exception("failed writing the column store for log %s", slug)  # rebuilt on first view
            return slug, delete_key
        raise RuntimeError("could not allocate slug")

    def get_log(self, slug: str) -> dict | None:
        if not SLUG_RE.match(slug or ""):
            return None
        with self.conn() as c:
            row = c.execute("SELECT slug, tune_slug, created_at, size, name, report_json FROM logs WHERE slug=?",
                            (slug,)).fetchone()
        if row is None:
            return None
        try:
            report = json.loads(row["report_json"])
        except ValueError:
            return None
        return {"slug": row["slug"], "tune_slug": row["tune_slug"], "created_at": row["created_at"],
                "size": row["size"], "name": row["name"], "report": report}

    def logs_for(self, tune_slug: str) -> list[dict]:
        if not SLUG_RE.match(tune_slug or ""):
            return []
        with self.conn() as c:
            rows = c.execute("SELECT slug, name, created_at, report_json FROM logs WHERE tune_slug=? "
                             "ORDER BY created_at DESC LIMIT 50", (tune_slug,)).fetchall()
        out = []
        for r in rows:
            try:
                report = json.loads(r["report_json"])
            except ValueError:
                continue
            out.append({"slug": r["slug"], "name": r["name"], "created_at": r["created_at"],
                        "summary": report.get("summary", {}), "seconds": report.get("seconds", 0)})
        return out

    def read_log_raw(self, slug: str) -> bytes | None:
        try:
            path = self.log_path(slug)
            if path.exists():
                return path.read_bytes()
            with gzip.open(path.with_suffix(".log.gz"), "rb") as f:
                return f.read()
        except (OSError, ValueError, EOFError):
            return None

    def log_index(self, slug: str, build=None) -> tuple[dict, int] | None:
        """-> (the column store's index, where its blocks start), building the store with `build(raw, path)`
        if this log was stored before there was one."""
        with self._cache_lock:
            if slug in self._index_cache:
                self._index_cache.move_to_end(slug)
                return self._index_cache[slug]
        from .logfile import LogError, read_index
        path = self.col_path(slug)
        try:
            if not path.exists():
                raw = self.read_log_raw(slug)
                if raw is None or build is None:
                    return None
                tmp = path.with_suffix(".coltmp")
                build(raw, tmp)
                os.replace(tmp, path)
            found = read_index(path)
        except (OSError, ValueError, LogError):
            log.exception("no column store for log %s", slug)
            return None
        with self._cache_lock:
            self._index_cache[slug] = found
            while len(self._index_cache) > 32:
                self._index_cache.popitem(last=False)
        return found

    def touch_log(self, slug: str) -> None:
        now = int(time.time())
        with self.conn() as c:
            c.execute("UPDATE logs SET last_viewed_at=? WHERE slug=? AND last_viewed_at < ?",
                      (now, slug, now - TOUCH_INTERVAL))

    def check_log_key(self, slug: str, key: str) -> bool:
        if not SLUG_RE.match(slug or "") or not key:
            return False
        with self.conn() as c:
            row = c.execute("SELECT delete_key_hash FROM logs WHERE slug=?", (slug,)).fetchone()
        return bool(row) and hmac.compare_digest(row["delete_key_hash"], self._hash_key(key))

    def delete_log(self, slug: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM logs WHERE slug=?", (slug,))
        with self._cache_lock:
            self._index_cache.pop(slug, None)
        try:
            for suffix in (".log", ".log.gz", ".col"):
                self.log_path(slug).with_suffix(suffix).unlink(missing_ok=True)
        except (OSError, ValueError):
            log.exception("failed removing log file for %s", slug)

    # ---------------------------------------------------------- rate limit
    @staticmethod
    def _ip_hash(ip: str) -> str:
        # Raw IPs are never stored.
        return hashlib.sha256(("msq-viewer:" + (ip or "?")).encode()).hexdigest()[:32]

    def over_limit(self, ip: str, limit: int) -> bool:
        with self.conn() as c:
            n = c.execute("SELECT COUNT(*) FROM uploads WHERE ip_hash=? AND ts > ?",
                          (self._ip_hash(ip), int(time.time()) - 3600)).fetchone()[0]
        return n >= limit

    def record_upload(self, ip: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO uploads VALUES (?,?)", (self._ip_hash(ip), int(time.time())))
