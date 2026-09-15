"""SQLite (stdlib, WAL) storage for tunes, rate limits and housekeeping.

Raw .msq bytes live on the data volume as `<slug>.msq`; the filename is
derived from the random slug only, never from user input.
"""
from __future__ import annotations

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
        self.db_path = self.data_dir / "msq.db"
        self._cache: OrderedDict[str, TuneDoc] = OrderedDict()
        self._cache_lock = threading.Lock()

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
                CREATE TABLE IF NOT EXISTS uploads (
                    ip_hash TEXT NOT NULL,
                    ts INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS uploads_ip_ts ON uploads(ip_hash, ts);
                """
            )
            # Added with tune editing: the slug an edited copy was saved from.
            if "parent" not in {r["name"] for r in c.execute("PRAGMA table_info(tunes)")}:
                c.execute("ALTER TABLE tunes ADD COLUMN parent TEXT")

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

    def create_tune(self, raw: bytes, doc: TuneDoc, parent: str | None = None) -> tuple[str, str]:
        delete_key = secrets.token_urlsafe(18)
        now = int(time.time())
        parsed = json.dumps(doc.to_dict(), separators=(",", ":"))
        for _ in range(8):
            slug = "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LEN))
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
        with self.conn() as c:
            c.execute("DELETE FROM tunes WHERE slug=?", (slug,))
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
        if slugs:
            log.info("purged %d stale tunes", len(slugs))
        return len(slugs)

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
