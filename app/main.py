"""MSQ Viewer web app."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware

from . import boost as boostmod
from . import checks as checksmod
from . import logs as logsmod
from . import diff as diffmod
from .axes import axis_text, stoich_of
from . import edit as editmod
from . import live as livemod
from . import views
from .db import SLUG_RE, Store
from .parser import MAX_BYTES, MsqError, TuneDoc, fmt_value, parse_msq
from .render import axis_labels, build_grid
from .tablemaps import TableView, all_tables, meta_digits, meta_units, resolve_map, summary_fields

log = logging.getLogger("msq")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


class _BelowWarning(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno < logging.WARNING


class _QuietPolls(logging.Filter):
    """Drop the access-log line for each live-update check (they'd be most of the log)."""
    def filter(self, record):
        args = record.args if isinstance(record.args, tuple) else ()
        return not (len(args) >= 3 and isinstance(args[2], str) and args[2].endswith("/rev"))


def split_log_streams(*names: str) -> None:
    """Send INFO to stdout and WARNING+ to stderr. Railway shows everything on stderr as an error, and uvicorn
    writes its normal startup and request lines there."""
    for name in names:
        logger = logging.getLogger(name)
        for h in list(logger.handlers):
            if getattr(h, "_msq_split", False) or not isinstance(h, logging.StreamHandler):
                continue
            if h.stream not in (sys.stderr, sys.stdout):
                continue  # e.g. pytest's capture
            out, err = logging.StreamHandler(sys.stdout), logging.StreamHandler(sys.stderr)
            for new in (out, err):
                new.setFormatter(h.formatter)
                new._msq_split = True
            out.setLevel(h.level)
            out.addFilter(_BelowWarning())
            err.setLevel(max(h.level, logging.WARNING))
            logger.removeHandler(h)
            logger.addHandler(out)
            logger.addHandler(err)

HERE = Path(__file__).resolve().parent
MAX_MB = MAX_BYTES // (1024 * 1024)
BODY_LIMIT = MAX_BYTES + 256 * 1024  # multipart framing + form fields
LOG_MAX_BYTES = logsmod.MAX_BYTES     # datalogs are far bigger than tunes
LOG_MAX_MB = LOG_MAX_BYTES // (1024 * 1024)
LOG_MAX_FILES = 6
LOG_BODY_LIMIT = int(os.environ.get("LOG_BODY_MB", "420")) * 1024 * 1024  # several logs in one upload
LOG_TOO_LARGE = f"That upload is too large. Each log can be up to {LOG_MAX_MB} MB."
LOG_UPLOAD_RE = re.compile(r"^(/logs|/t/[A-Za-z0-9]{10}/log|/admin/restore/log|/live/[A-Za-z0-9]{12}/log)/?$")
TUNE_JSON_RE = re.compile(r"^/upload/?$")

CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")

MESSAGES = {
    400: "That request didn't make sense.",
    403: "Not allowed.",
    404: "Nothing here. The tune or log may have been deleted, or it expired after 180 days without views.",
    405: "That action isn't supported here.",
    413: f"That file is too large. The limit is {MAX_MB} MB.",
    429: "Too many uploads from your connection. Try again in an hour.",
    500: "Something went wrong on our end. Try again in a moment.",
}


class BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    """Refuse oversized request bodies before reading them.

    A declared Content-Length over the limit never reaches the app's body
    parser: the request is marked `body_too_large` and handed an empty body.
    Undeclared (chunked) bodies are counted as they stream and abort at the
    limit.
    """

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = LOG_BODY_LIMIT if LOG_UPLOAD_RE.match(scope.get("path", "")) else self.limit
        declared = None
        for k, v in scope["headers"]:
            if k == b"content-length":
                try:
                    declared = int(v)
                except ValueError:
                    declared = limit + 1
        if declared is not None and declared > limit:
            scope.setdefault("state", {})["body_too_large"] = True

            async def empty():
                return {"type": "http.request", "body": b"", "more_body": False}

            return await self.app(scope, empty, send)

        seen = 0

        async def counted():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise BodyTooLarge()
            return msg

        return await self.app(scope, counted, send)


def client_ip(request: Request) -> str:
    h = request.headers
    if h.get("x-real-ip"):
        return h["x-real-ip"].strip()
    if h.get("x-forwarded-for"):
        return h["x-forwarded-for"].split(",")[-1].strip()
    return request.client.host if request.client else "?"


def slug_from(text: str | None) -> str | None:
    s = (text or "").strip()
    m = re.search(r"/t/([A-Za-z0-9]{10})(?![A-Za-z0-9])", s)
    if m:
        return m.group(1)
    return s if SLUG_RE.match(s) else None


def create_app(data_dir: str | Path | None = None, uploads_per_hour: int | None = None) -> FastAPI:
    store = Store(data_dir)
    limit = uploads_per_hour if uploads_per_hour is not None else int(os.environ.get("UPLOADS_PER_HOUR", "20"))

    templates = Jinja2Templates(directory=HERE / "templates")
    asset_v = hashlib.sha1(b"".join((HERE / "static" / f).read_bytes()
                                    for f in ("app.css", "app.js", "theme.js", "edit.js", "viewer.js", "veal.js", "ecu.js", "live.js", "codes.js", "tunediff.js"))).hexdigest()[:8]
    templates.env.globals.update(asset_v=asset_v, max_mb=MAX_MB, max_bytes=MAX_BYTES, icons=views.ICONS,
                                 log_max_mb=LOG_MAX_MB, log_max_bytes=LOG_MAX_BYTES,
                                 tab_names=views.TAB_NAMES, cat_labels=views.CATEGORY_LABELS,
                                 cat_icons=views.CAT_ICONS)
    demo = views.demo_grid()

    async def purge_loop():
        while True:
            try:
                await asyncio.to_thread(store.purge_stale)
            except Exception:
                log.exception("purge failed")
            await asyncio.sleep(86400)

    @asynccontextmanager
    async def lifespan(app):
        split_log_streams("", "uvicorn", "uvicorn.error", "uvicorn.access")
        logging.getLogger("uvicorn.access").addFilter(_QuietPolls())
        store.init()
        task = asyncio.create_task(purge_loop())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store = store
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(BodyLimitMiddleware, limit=BODY_LIMIT)
    app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        csp = CSP
        if request.url.path.startswith(("/live", "/l/")):
            # the live page's WebSocket (and the log viewer's shared playback): name it, since older Safari (a tuner's iPhone) doesn't count wss: as 'self'
            host = re.sub(r"[^A-Za-z0-9.:\-]", "", request.headers.get("host", ""))
            if host:
                csp = csp.replace("connect-src 'self'", f"connect-src 'self' wss://{host} ws://{host}")
        resp.headers.setdefault("Content-Security-Policy", csp)
        if request.url.path.startswith("/live"):
            resp.headers["Permissions-Policy"] = "serial=(self), screen-wake-lock=(self)"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith(("/t/", "/d/", "/l/")):
            resp.headers["X-Robots-Tag"] = "noindex"
        if request.url.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    # ------------------------------------------------------------ errors
    def error_response(request: Request, status: int, message: str | None = None):
        msg = message or MESSAGES.get(status, MESSAGES[500])
        path = request.url.path
        if path.endswith(".json") or "application/json" in request.headers.get("accept", "").split(",")[0]:
            return JSONResponse({"error": msg}, status_code=status)
        if request.headers.get("hx-request"):
            return HTMLResponse(f'<p class="flash err">{_esc(msg)}</p>', status_code=status)
        return templates.TemplateResponse(request, "error.html", {"status": status, "message": msg},
                                          status_code=status)

    @app.exception_handler(HTTPException)
    async def _http_exc(request, exc):
        return error_response(request, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(request, exc):
        return error_response(request, 400)

    @app.exception_handler(BodyTooLarge)
    async def _too_large(request, exc):
        return error_response(request, 413)

    @app.exception_handler(Exception)
    async def _unhandled(request, exc):
        log.exception("unhandled error on %s", request.url.path)
        return error_response(request, 500)

    # ----------------------------------------------------------- helpers
    def load_doc(slug: str) -> TuneDoc:
        doc = store.get_doc(slug) if SLUG_RE.match(slug or "") else None
        if doc is None:
            raise HTTPException(404)
        return doc

    def pop_delete_key(request: Request, slug: str) -> str | None:
        key = request.cookies.get(f"dk_{slug}")
        return key if key and store.check_delete_key(slug, key) else None

    def set_key_cookie(resp: Response, request: Request, slug: str, key: str) -> None:
        resp.set_cookie(f"dk_{slug}", key, max_age=900, httponly=True, samesite="lax", path="/",
                        secure=request.url.scheme == "https")

    async def read_upload(form, field: str = "file", required: bool = True, max_bytes: int = MAX_BYTES,
                          what: str = "a .msq file"):
        """-> (bytes | None, error message | None, status)."""
        f = form.get(field)
        if not isinstance(f, UploadFile) or not f.filename:
            return None, (f"Choose {what} first." if required else None), 400
        try:
            data = await f.read(max_bytes + 1)
        finally:
            await f.close()
        if len(data) > max_bytes:
            return None, (MESSAGES[413] if max_bytes == MAX_BYTES else LOG_TOO_LARGE), 413
        return data, None, 200

    async def store_upload(request: Request, data: bytes,
                           parent: str | None = None) -> tuple[str | None, str | None, str | None, int]:
        """Parse + persist. -> (slug, delete_key, error, status)."""
        try:
            doc = await run_in_threadpool(parse_msq, data)
        except MsqError as e:
            return None, None, str(e), 400
        slug, key = await run_in_threadpool(store.create_tune, data, doc, parent)
        store.record_upload(client_ip(request))
        log.info("stored tune %s family=%s size=%d", slug, doc.family, len(data))
        return slug, key, None, 200

    def grid_for_view(v: TableView, tmap: dict):
        g = build_grid(v.id, v.label, v.z, v.x, v.y, v.palette, v.units, v.x_label, v.y_label,
                       digits=meta_digits(tmap, v.z), x_units=v.x_units, y_units=v.y_units, load=v.load,
                       pressure_note=v.featured)
        g.axes_note = diffmod.axes_note(v)
        return g

    def summary_rows(doc: TuneDoc, tmap: dict):
        return [(label, views.display_value(c, tmap), meta_units(tmap, c), c) for label, c in summary_fields(doc, tmap)]

    def og_for(doc: TuneDoc, summary, edited: bool = False) -> tuple[str, str]:
        title = ("Edited copy · " if edited else "") + f"{views.family_label(doc)} {doc.version}".strip() + " tune"
        if doc.tune_comment:
            title += f" · {views.tune_label(doc)[:80]}"
        bits = [f"{label} {val}{(' ' + units) if units else ''}" for label, val, units, _ in summary[:6]]
        desc = " · ".join(bits) or "TunerStudio .msq tune"
        return title, f"{desc}. Signature: {doc.signature or 'none'}"[:300]

    def msq_filename(doc: TuneDoc | None, slug: str) -> str:
        """A readable name for the downloads folder; the slug keeps copies of the same tune apart."""
        label = re.sub(r"<[^>]*>", " ", views.tune_label(doc) if doc else "")  # some comments carry HTML
        base = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-._")[:60].strip("-._")
        return f"{base}-{slug}.msq" if base else f"{slug}.msq"

    def edited_from(slug: str) -> dict | None:
        meta = store.get_meta(slug)
        parent = meta["parent"] if meta is not None else None
        if not parent:
            return None
        pdoc = store.get_doc(parent)
        return {"slug": parent, "label": views.tune_label(pdoc) if pdoc else "", "exists": pdoc is not None}

    def page_url(request: Request) -> str:
        return str(request.url.replace(query="", fragment=""))

    # ------------------------------------------------------------- pages
    @app.get("/healthz")
    def healthz():
        # persistent=false means tunes live in the container and every redeploy deletes them.
        return {"ok": True, "persistent": store.persistent}

    @app.get("/", response_class=HTMLResponse)
    def home(request: Request):
        return templates.TemplateResponse(request, "home.html", {"deleted": request.query_params.get("deleted"),
                                                                 "demo": demo})

    def home_error(request: Request, message: str, status: int):
        return templates.TemplateResponse(request, "home.html", {"error": message, "demo": demo},
                                          status_code=status)

    @app.post("/upload")
    async def upload(request: Request):
        def fail(message: str, status: int):
            if request.headers.get("x-upload"):
                return JSONResponse({"error": message}, status_code=status)
            return home_error(request, message, status)

        if request.state._state.get("body_too_large"):
            return fail(MESSAGES[413], 413)
        if store.over_limit(client_ip(request), limit):
            return fail(MESSAGES[429], 429)
        try:
            form = await request.form(max_files=1, max_fields=8)
        except BodyTooLarge:
            raise
        except Exception:
            return fail("The upload didn't come through. Try again.", 400)
        data, err, status = await read_upload(form)
        if err:
            return fail(err, status)
        slug, key, err, status = await store_upload(request, data)
        if err:
            if request.headers.get("x-upload"):
                return JSONResponse({"error": err}, status_code=status)
            return home_error(request, err, status)
        if request.headers.get("x-upload"):  # the log viewer adding a tune: it stays where it is
            resp = JSONResponse({"url": f"/t/{slug}", "slug": slug})
            set_key_cookie(resp, request, slug, key)
            return resp
        resp = RedirectResponse(f"/t/{slug}", status_code=302)
        set_key_cookie(resp, request, slug, key)
        return resp

    @app.get("/t/{slug}.json")
    def tune_json(slug: str):
        doc = load_doc(slug)
        tmap = resolve_map(doc)
        meta = store.get_meta(slug)
        payload = {"slug": slug, "tablemap": tmap.get("family"), "parent": meta["parent"] if meta else None,
                   **doc.to_dict()}
        return JSONResponse(payload, headers={"Access-Control-Allow-Origin": "*"})

    @app.get("/t/{slug}.msq")
    def tune_download(slug: str):
        load_doc(slug)
        raw = store.read_raw(slug)
        if raw is None:
            raise HTTPException(404)
        # octet-stream, not XML: phones keep the .msq name (iOS would otherwise save it as .xml or show it as text)
        return Response(raw, media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{msq_filename(store.get_doc(slug), slug)}"',
                                 "Cache-Control": "no-cache"})

    @app.delete("/t/{slug}")
    def tune_delete(request: Request, slug: str, key: str = ""):
        load_doc(slug)
        if not store.check_delete_key(slug, key.strip()):
            return error_response(request, 403, "That delete key doesn't match this tune.")
        store.delete_tune(slug)
        if request.headers.get("hx-request"):
            return Response(status_code=200, headers={"HX-Redirect": "/?deleted=1"})
        return JSONResponse({"deleted": True})

    @app.post("/t/{slug}/delete")
    async def tune_delete_form(request: Request, slug: str):
        load_doc(slug)
        form = await request.form(max_files=0, max_fields=4)
        key = str(form.get("key") or "").strip()
        if not store.check_delete_key(slug, key):
            return error_response(request, 403, "That delete key doesn't match this tune.")
        store.delete_tune(slug)
        return RedirectResponse("/?deleted=1", status_code=302)

    @app.post("/t/{slug}/save")
    async def tune_save(request: Request, slug: str):
        """Save edited values as a new tune with its own link. The original is never modified."""
        load_doc(slug)

        def fail(message: str, status: int = 400):
            return JSONResponse({"error": message}, status_code=status)

        if request.state._state.get("body_too_large"):
            return fail(MESSAGES[413], 413)
        if store.over_limit(client_ip(request), limit):
            return fail(MESSAGES[429], 429)
        try:
            payload = await request.json()
        except BodyTooLarge:
            raise
        except Exception:
            return fail("Those changes didn't come through. Try again.")
        raw = store.read_raw(slug)
        if raw is None:
            raise HTTPException(404)
        changes = payload.get("changes") if isinstance(payload, dict) else None
        fork = isinstance(payload, dict) and payload.get("fork") is True  # a separate copy, with or without changes
        try:
            new_raw, changed = (raw, 0) if fork and not changes else await run_in_threadpool(editmod.apply_changes, raw, changes)
        except editmod.EditError as e:
            return fail(str(e))
        # An edited copy is the shared tune of everyone who has its link: saving to it updates it in place, so
        # every page open on that link shows the change. An uploaded original is never overwritten: the first
        # edit makes the shared copy. {"fork": true} makes a separate copy on purpose.
        own = str(payload.get("key") or "").strip() if isinstance(payload, dict) else ""
        meta = store.get_meta(slug)
        if not fork and meta is not None and meta["parent"]:
            try:
                doc = await run_in_threadpool(parse_msq, new_raw)
            except MsqError as e:
                return fail(str(e))
            # Back up what's being replaced: always before a named change (VE Analyze applied), and every
            # 10 minutes while it's being edited.
            label = str(payload.get("checkpoint") or "").strip()[:80]
            if label:
                store.add_version(slug, raw, label)
            elif time.time() - store.last_version_at(slug) > 600:
                store.add_version(slug, raw, "Auto-save")
            await run_in_threadpool(store.replace_tune, slug, new_raw, doc)
            log.info("updated edited tune %s in place (%d values)", slug, changed)
            return JSONResponse({"url": f"/t/{slug}", "slug": slug, "changed": changed, "key": own,
                                 "updated": True, "file": msq_filename(doc, slug), "rev": store.rev(slug)})
        new_slug, key, err, status = await store_upload(request, new_raw, parent=slug)
        if err:
            return fail(err, status)
        log.info("saved edited tune %s from %s (%d values)", new_slug, slug, changed)
        store.set_notes(new_slug, store.notes(slug))  # a copy carries the notes it was made from
        edit_key = store.edit_key(new_slug)
        resp = JSONResponse({"url": f"/t/{new_slug}", "slug": new_slug, "changed": changed, "key": key,
                             "edit_key": edit_key, "updated": False,
                             "file": msq_filename(store.get_doc(new_slug), new_slug), "rev": store.rev(new_slug)})
        set_key_cookie(resp, request, new_slug, key)
        return resp

    # ------------------------------------------------------------ restore
    # Puts tunes and logs back under the links they had, after moving to persistent storage. Needs the restore
    # token, whose sha256 is below (the token itself isn't in the repository). It never overwrites anything.
    RESTORE_SHA = "2cdb402e6c0a60e8081197838dbc3fcf5f4888fd62fa92a01ca7092bdb429ee3"

    def restore_ok(request: Request) -> bool:
        tok = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return bool(tok) and hmac.compare_digest(hashlib.sha256(tok.encode()).hexdigest(), RESTORE_SHA)

    @app.post("/admin/restore/tune")
    async def restore_tune(request: Request):
        if not restore_ok(request):
            raise HTTPException(404)
        form = await request.form(max_files=1, max_fields=6)
        slug, parent, notes = str(form.get("slug") or ""), str(form.get("parent") or "") or None, str(form.get("notes") or "")
        data, err, status = await read_upload(form)
        if err:
            return JSONResponse({"error": err}, status_code=status)
        if not SLUG_RE.match(slug) or store.get_meta(slug) is not None:
            return JSONResponse({"error": "slug taken or invalid"}, status_code=409)
        doc = await run_in_threadpool(parse_msq, data)
        _, key = await run_in_threadpool(store.create_tune, data, doc, parent, slug)
        store.set_notes(slug, notes)
        return JSONResponse({"slug": slug, "key": key, "edit_key": store.edit_key(slug) if parent else None})

    @app.post("/admin/restore/log")
    async def restore_log(request: Request):
        if not restore_ok(request):
            raise HTTPException(404)
        form = await request.form(max_files=1, max_fields=6)
        slug, tune_slug = str(form.get("slug") or ""), str(form.get("tune") or "")
        f = form.get("file")
        if not isinstance(f, UploadFile):
            return JSONResponse({"error": "no file"}, status_code=400)
        data = await f.read(LOG_MAX_BYTES + 1)
        if not SLUG_RE.match(slug) or store.get_log(slug) is not None:
            return JSONResponse({"error": "slug taken or invalid"}, status_code=409)
        doc = store.get_doc(tune_slug) if tune_slug else None
        s, key, rows = await run_in_threadpool(ingest_log, doc, tune_slug if doc else "", data, f.filename or "log.mlg", slug)
        return JSONResponse({"slug": s, "key": key, "rows": rows})

    @app.get("/t/{slug}/rev")
    def tune_rev(slug: str):
        """What open viewers poll (every few seconds) to pick up edits and notes made somewhere else."""
        rev = store.rev(slug)
        if rev is None:
            raise HTTPException(404)
        return JSONResponse({"rev": rev}, headers={"Cache-Control": "no-store"})

    def shared_copy(slug: str):
        """-> (meta) of an edited copy, or a JSON error: originals never change, so they have no history."""
        load_doc(slug)
        meta = store.get_meta(slug)
        return meta if meta is not None and meta["parent"] else None

    @app.get("/t/{slug}/versions")
    def tune_versions(slug: str):
        """The backups of a shared tune, newest first, plus what it was made from."""
        meta = shared_copy(slug)
        parent = None
        if meta is not None:
            pdoc = store.get_doc(meta["parent"])
            parent = {"slug": meta["parent"], "label": views.tune_label(pdoc) if pdoc else "", "exists": pdoc is not None}
        return JSONResponse({"versions": store.versions(slug) if meta is not None else [], "parent": parent,
                             "editable": meta is not None}, headers={"Cache-Control": "no-store"})

    @app.post("/t/{slug}/versions")
    async def tune_checkpoint(request: Request, slug: str):
        """Back up the tune as it is now, with a name ("Before VE Analyze", "Before the 3rd-gear pulls"…)."""
        if shared_copy(slug) is None:
            return JSONResponse({"error": "The original upload never changes, so it doesn't need a backup."}, status_code=400)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        label = str(payload.get("label") or "").strip()[:80] if isinstance(payload, dict) else ""
        vid = store.add_version(slug, store.read_raw(slug) or b"", label or "Backup")
        return JSONResponse({"id": vid, "versions": store.versions(slug)})

    @app.post("/t/{slug}/restore")
    async def tune_restore(request: Request, slug: str):
        """Put a shared tune back to a backup (or to the tune it was made from). What it was just before is
        backed up first, so a restore can itself be undone."""
        meta = shared_copy(slug)
        if meta is None:
            return JSONResponse({"error": "The original upload never changes: there's nothing to restore."}, status_code=400)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        payload = payload if isinstance(payload, dict) else {}
        if payload.get("parent"):
            src = store.read_raw(meta["parent"])
            what = "the original it was made from"
        else:
            got = store.version_raw(slug, int(payload.get("id") or 0))
            src, what = (got[0], f"“{got[1]['label']}”") if got else (None, "")
        if not src:
            return JSONResponse({"error": "That backup isn't there any more."}, status_code=404)
        try:
            doc = await run_in_threadpool(parse_msq, src)
        except MsqError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        store.add_version(slug, store.read_raw(slug) or b"", f"Before restoring {what}"[:120])
        await run_in_threadpool(store.replace_tune, slug, src, doc)
        log.info("restored tune %s to %s", slug, what)
        return JSONResponse({"ok": True, "rev": store.rev(slug), "versions": store.versions(slug)})

    @app.get("/t/{slug}/versions/{vid}.msq")
    def tune_version_download(slug: str, vid: int):
        load_doc(slug)
        got = store.version_raw(slug, vid)
        if got is None:
            raise HTTPException(404)
        stamp = time.strftime("%Y%m%d-%H%M", time.gmtime(got[1]["at"]))
        name = msq_filename(store.get_doc(slug), slug).removesuffix(".msq") + f"-backup-{stamp}.msq"
        return Response(got[0], media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-cache"})

    @app.post("/t/{slug}/editkey")
    async def tune_edit_key(request: Request, slug: str):
        """The owner of an edited copy asks for a key to share, so a friend can edit the same tune live."""
        load_doc(slug)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        key = str(payload.get("key") or "").strip() if isinstance(payload, dict) else ""
        meta = store.get_meta(slug)
        if not (meta and meta["parent"] and store.check_delete_key(slug, key)):
            return JSONResponse({"error": "Only the person who made this copy can share it for editing."}, status_code=403)
        return JSONResponse({"edit_key": store.edit_key(slug)})

    @app.post("/t/{slug}/notes")
    async def tune_notes(request: Request, slug: str):
        """Shared notes on a tune, for friends tuning it together. Needs the tune's delete or edit key."""
        load_doc(slug)
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"error": "Those notes didn't come through. Try again."}, status_code=400)
        text = str(payload.get("notes") or "") if isinstance(payload, dict) else ""
        key = str(payload.get("key") or "").strip() if isinstance(payload, dict) else ""
        if len(text) > 8000:
            return JSONResponse({"error": "Notes can be up to 8,000 characters."}, status_code=400)
        meta = store.get_meta(slug)
        if not (meta is not None and meta["parent"]) and not store.can_edit(slug, key):
            return JSONResponse({"error": "Edit a cell first: that makes the shared copy notes go on."}, status_code=403)
        store.set_notes(slug, text.replace("\r\n", "\n"))
        return JSONResponse({"ok": True, "rev": store.rev(slug)})

    @app.get("/t/{slug}", response_class=HTMLResponse)
    def tune_view(request: Request, slug: str):
        doc = load_doc(slug)
        store.touch(slug)
        tmap = resolve_map(doc)
        model = views.tune_model(slug, doc, tmap)
        fgrids = []
        for v in model.featured:
            g = grid_for_view(v, tmap)
            g.url = views.c_url(slug, v.z.name)
            fgrids.append(g)
        summary = summary_rows(doc, tmap)
        dials, readouts = views.gauges(summary, doc)
        health = checksmod.run(doc, model.table_views)
        boost_card = boostmod.card(boostmod.assess(doc, model.table_views, tmap, health))
        tune_logs = store.logs_for(slug)[:5]
        parent = edited_from(slug)
        og_title, og_desc = og_for(doc, summary, edited=parent is not None)
        delete_key = pop_delete_key(request, slug)
        resp = templates.TemplateResponse(request, "tune.html", {
            "slug": slug, "doc": doc, "tmap": tmap, "m": model, "fgrids": fgrids, "summary": summary,
            "dials": dials, "readouts": readouts, "parent": parent, "health": health, "boost_card": boost_card, "tune_logs": tune_logs,
            "health_summary": checksmod.summary(health), "live_values": views.live_values(doc, dials, health),
            "load": next((v.load for v in model.featured if v.load is not None), None),
            "family": views.family_label(doc), "tune_label": views.tune_label(doc), "delete_key": delete_key,
            "og_title": og_title, "og_desc": og_desc, "og_url": page_url(request),
        })
        if delete_key:
            resp.delete_cookie(f"dk_{slug}", path="/")
        return resp

    @app.get("/t/{slug}/c/{name}", response_class=HTMLResponse)
    def constant_view(request: Request, slug: str, name: str):
        doc = load_doc(slug)
        c = doc.get(name)
        if c is None:
            raise HTTPException(404)
        tmap = resolve_map(doc)
        featured, other = all_tables(doc, tmap)
        tviews = featured + other
        digits = meta_digits(tmap, c)
        ctx = {"slug": slug, "doc": doc, "c": c, "tune_label": views.tune_label(doc), "kind": views.kind_of(c),
               "units": meta_units(tmap, c), "st": None, "dims": "", "nav_groups": None, "prev": None,
               "editable": editmod.is_editable(c), "edit_digits": editmod.edit_digits(c),
               "hint": views.SETTING_HINTS.get(name, ""),
               "next": None, "og_url": page_url(request)}
        if c.is_table:
            idx = next(i for i, v in enumerate(tviews) if v.z.name == name)
            v = tviews[idx]
            items, groups = views.table_nav(slug, tviews)
            ctx.update(label=v.label, cat=items[idx]["cat"], g=grid_for_view(v, tmap), units=v.units,
                       dims=f"{c.rows}×{c.cols}", st=views.stats(c.values, digits), nav_groups=groups,
                       prev=items[idx - 1] if idx > 0 else None,
                       next=items[idx + 1] if idx + 1 < len(items) else None, back="tables")
        elif c.is_array:
            cvs = views.curve_views(doc, tmap, tviews)
            cv = next((x for x in cvs if x.y.name == name), None)
            xs = cv.x.values if cv and cv.x else None
            label = cv.label if cv else name
            x_text = axis_labels(xs, len(c.values)) if xs else None
            used_by = [{"label": t.label, "url": views.c_url(slug, t.z.name)} for t in tviews
                       if name in ((t.x.name if t.x else None), (t.y.name if t.y else None))]
            used_by += [{"label": x.label, "url": views.c_url(slug, x.y.name)} for x in cvs
                        if x.x is not None and x.x.name == name]
            ctx.update(label=label, cat=views.categorize(label, name), dims=f"{len(c.values)} values",
                       st=views.stats(c.values, digits), used_by=used_by, has_x=bool(xs),
                       x_label=axis_text(cv.x_label, cv.x_units) if cv else "", y_label=cv.y_label if cv else "",
                       chart=views.build_chart(c.values, xs, axis_text(cv.x_label, cv.x_units) if cv else "",
                                               cv.y_label if cv else "", digits),
                       rows=[(i, x_text[i] if x_text else "", fmt_value(val, digits))
                             for i, val in enumerate(c.values)],
                       back="curves" if cv else "settings")
            if cv:
                items = [{"name": x.y.name, "label": x.label, "url": views.c_url(slug, x.y.name)} for x in cvs]
                j = cvs.index(cv)
                ctx.update(nav_groups=[("Curves", items)], prev=items[j - 1] if j > 0 else None,
                           next=items[j + 1] if j + 1 < len(items) else None)
        else:
            ctx.update(label=name, cat=views.categorize(name), value=views.display_value(c, tmap), back="settings")
        ctx["cat_label"] = views.CATEGORY_LABELS[ctx["cat"]]
        ctx["kind_label"] = views.KIND_LABEL[ctx["kind"]]
        return templates.TemplateResponse(request, "constant.html", ctx)

    # -------------------------------------------------------------- boost
    def boost_inputs(slug: str):
        doc = load_doc(slug)
        tmap = resolve_map(doc)
        featured, other = all_tables(doc, tmap)
        tviews = featured + other
        return doc, tmap, tviews, boostmod.assess(doc, tviews, tmap)

    def boost_page(request: Request, slug: str, doc: TuneDoc, a, ans, plan=None, flash: str | None = None,
                   status: int = 200):
        return templates.TemplateResponse(request, "boost.html", {
            "slug": slug, "doc": doc, "a": a, "ans": ans, "plan": plan, "flash": flash,
            "tune_label": views.tune_label(doc), "family": views.family_label(doc),
            "fuels": boostmod.FUELS, "goals": boostmod.GOALS, "gears": boostmod.GEARS,
            "speed_rows": boostmod.SPEED_ROWS, "step_psi": boostmod.STEP_PSI,
            "unverified_cap": boostmod.UNVERIFIED_FUEL_CAP, "psi_of": boostmod.psi_of,
            "og_url": page_url(request),
        }, status_code=status)

    @app.get("/t/{slug}/boost", response_class=HTMLResponse)
    def boost_view(request: Request, slug: str):
        doc, tmap, tviews, a = boost_inputs(slug)
        store.touch(slug)
        return boost_page(request, slug, doc, a, boostmod.Answers(injector_cc=a.injector_cc))

    @app.post("/t/{slug}/boost", response_class=HTMLResponse)
    async def boost_submit(request: Request, slug: str):
        """Preview a boost plan, or write it into a new tune. The tune being read is never modified."""
        doc, tmap, tviews, a = boost_inputs(slug)
        if request.state._state.get("body_too_large"):
            return error_response(request, 413)
        try:
            form = await request.form(max_files=0, max_fields=80)
        except BodyTooLarge:
            raise
        except Exception:
            return error_response(request, 400)
        ans, errors = boostmod.parse_answers(form)
        plan = await run_in_threadpool(boostmod.build_plan, doc, tviews, tmap, ans, errors, a)

        def again(message: str, status: int):
            return boost_page(request, slug, doc, a, ans, plan, flash=message, status=status)

        if str(form.get("action") or "") != "create":
            return boost_page(request, slug, doc, a, ans, plan)
        if not plan.ok:
            return again("This plan needs fixing before it can be created: see below.", 400)
        if str(form.get("plan_sig") or "") != ans.signature():
            return again("Your answers changed since the preview. Check the plan below, then create it again.", 409)
        if str(form.get("acknowledge") or "") != "yes":
            return again("Tick the box to confirm you'll do the required steps and log the first drive.", 400)
        if store.over_limit(client_ip(request), limit):
            return again(MESSAGES[429], 429)
        raw = store.read_raw(slug)
        if raw is None:
            raise HTTPException(404)
        try:
            new_raw, changed = await run_in_threadpool(boostmod.create, raw, doc, tmap, plan)
        except boostmod.BoostError as e:
            log.warning("boost plan refused for %s: %s", slug, e)
            return again(str(e), 400)
        new_slug, key, err, status = await store_upload(request, new_raw, parent=slug)
        if err:
            return again(err, status)
        log.info("boost tune %s from %s (%.2f psi, %d values)", new_slug, slug, plan.target_psi, changed)
        resp = RedirectResponse(f"/t/{new_slug}", status_code=303)
        set_key_cookie(resp, request, new_slug, key)
        return resp

    # --------------------------------------------------------------- logs
    def log_list_page(request: Request, slug: str, doc: TuneDoc, error: str | None = None, status: int = 200):
        return templates.TemplateResponse(request, "log.html", {
            "slug": slug, "doc": doc, "tune_label": views.tune_label(doc), "family": views.family_label(doc),
            "logs": store.logs_for(slug), "error": error, "og_url": page_url(request),
        }, status_code=status)

    def load_log(slug: str, log_slug: str) -> dict:
        row = store.get_log(log_slug) if SLUG_RE.match(log_slug or "") else None
        if row is None or row["tune_slug"] != slug or not slug:
            raise HTTPException(404)
        return row

    def report_page(request: Request, slug: str, row: dict, delete_key: str | None = None,
                    flash: str | None = None, status: int = 200):
        doc = store.get_doc(slug)
        return templates.TemplateResponse(request, "log_report.html", {
            "slug": slug, "log_slug": row["slug"], "name": row["name"], "r": row["report"], "doc": doc,
            "tune_label": views.tune_label(doc) if doc else "", "delete_key": delete_key, "flash": flash,
            "og_url": page_url(request),
        }, status_code=status)

    def tune_views(doc: TuneDoc):
        tmap = resolve_map(doc)
        featured, other = all_tables(doc, tmap)
        return tmap, featured + other

    def ingest_log(doc: TuneDoc | None, tune_slug: str, data: bytes, filename: str,
                   slug: str | None = None, replace: bool = False) -> tuple[str, str, int]:
        """Parse a log, compare it to its tune if it has one, and store it. -> (log slug, delete key, rows).

        Boost cut, MAP sensor range and rev limit for the report come from the tune."""
        parsed = logsmod.parse_log(data, filename)
        if doc is not None:
            tmap, tviews = tune_views(doc)
            a = boostmod.assess(doc, tviews, tmap)
            r = logsmod.analyze(parsed, doc, tviews, cut_kpa=a.cut.value if a.cut is not None else None,
                                map_max=a.map_kpa, rev=a.rev[1] if a.rev else None)
            report = logsmod.to_dict(r)
        else:
            t, _ = logsmod._timebase(parsed, logsmod.resolve(parsed))
            report = {"standalone": True, "rows": parsed.rows,
                      "seconds": round(t[-1] - t[0], 1) if len(t) > 1 else 0.0,
                      "summary": {"tone": "info", "short": "Log", "verdict": ""}}
        if replace and slug:
            store.replace_log(slug, data, report, columns=lambda path: logsmod.build_columns(parsed, path), name=filename)
            return slug, "", parsed.rows
        slug, key = store.create_log(data, tune_slug, filename, report,
                                     columns=lambda path: logsmod.build_columns(parsed, path), slug=slug)
        return slug, key, parsed.rows

    def rebuild_columns(raw: bytes, path) -> None:
        logsmod.build_columns(logsmod.parse_log(raw), path)

    def log_index(log_slug: str) -> tuple[dict, int]:
        found = store.log_index(log_slug, rebuild_columns)
        if found is None:
            raise HTTPException(404)
        return found

    async def take_log(request: Request, doc: TuneDoc | None, tune_slug: str):
        """Read the uploaded logs (up to LOG_MAX_FILES) from the request and store each one.

        -> ([(log slug, delete key), ...], error, status, form). If one file can't be read nothing more is
        stored, and the error names it."""
        if request.state._state.get("body_too_large"):
            return [], LOG_TOO_LARGE, 413, None
        if store.over_limit(client_ip(request), limit):
            return [], MESSAGES[429], 429, None
        try:
            form = await request.form(max_files=LOG_MAX_FILES, max_fields=8)
        except BodyTooLarge:
            raise
        except Exception:
            return [], "The upload didn't come through. Try again.", 400, None
        files = [f for f in form.getlist("file") if isinstance(f, UploadFile) and f.filename]
        if not files:
            return [], "Choose a log file first.", 400, form
        if doc is None and str(form.get("tune") or "").strip():
            tune_slug = slug_from(str(form.get("tune"))) or ""
            doc = store.get_doc(tune_slug) if tune_slug else None
            if doc is None:
                return [], "That tune link wasn't found. Paste a tune link, or leave it empty.", 400, form
        done = []
        for f in files:
            name = f.filename or "log"
            try:
                data = await f.read(LOG_MAX_BYTES + 1)
            finally:
                await f.close()
            if len(data) > LOG_MAX_BYTES:
                return done, f"{name} is too large. Each log can be up to {LOG_MAX_MB} MB.", 413, form
            if done and store.over_limit(client_ip(request), limit):
                return done, MESSAGES[429], 429, form
            try:
                log_slug, key, rows = await run_in_threadpool(ingest_log, doc, tune_slug if doc else "", data, name)
            except logsmod.LogError as e:
                return done, (f"{name}: {e}" if len(files) > 1 else str(e)), 400, form
            except Exception:
                log.exception("failed reading log %r", name)
                return done, f"{name} couldn't be read.", 400, form
            finally:
                del data
            store.record_upload(client_ip(request))
            log.info("stored log %s tune=%s rows=%d", log_slug, tune_slug or "-", rows)
            done.append((log_slug, key))
        return done, None, 200, form

    def upload_error(request: Request, message: str, status: int):
        """The page's own uploader (which shows progress) wants JSON back; a plain form post gets the page."""
        if request.headers.get("x-upload"):
            return JSONResponse({"error": message}, status_code=status)
        return None

    def partial_upload(request: Request, err: str, url: str, done: list, page):
        """Some logs went up and one didn't: say which, and offer the ones that worked."""
        msg = f"{err} The {'log' if len(done) == 1 else f'{len(done)} logs'} before it uploaded fine."
        resp = (JSONResponse({"error": msg, "url": url, "partial": True}, status_code=200)
                if request.headers.get("x-upload") else page(msg + f" Open {'it' if len(done) == 1 else 'them'}: {url}"))
        for log_slug, key in done:
            set_key_cookie(resp, request, log_slug, key)
        return resp

    def viewer_url(done: list, tune: str) -> str:
        """The viewer for the first log, with any others uploaded alongside it ready for VE Analyze."""
        url = f"/l/{done[0][0]}"
        if len(done) > 1:
            url += "?also=" + ",".join(s for s, _ in done[1:])
        return url

    def upload_done(request: Request, url: str, done: list):
        resp = (JSONResponse({"url": url}) if request.headers.get("x-upload")
                else RedirectResponse(url, status_code=303))
        for log_slug, key in done:
            set_key_cookie(resp, request, log_slug, key)
        return resp

    @app.get("/t/{slug}/log", response_class=HTMLResponse)
    def log_list(request: Request, slug: str):
        doc = load_doc(slug)
        store.touch(slug)
        return log_list_page(request, slug, doc)

    @app.post("/t/{slug}/log")
    async def log_upload(request: Request, slug: str):
        doc = load_doc(slug)
        done, err, status, _ = await take_log(request, doc, slug)
        if err and not done:
            return upload_error(request, err, status) or log_list_page(request, slug, doc, err, status)
        if err:
            return partial_upload(request, err, viewer_url(done, ""), done,
                                  lambda msg: log_list_page(request, slug, doc, msg, 400))
        if len(done) > 1:
            return upload_done(request, viewer_url(done, ""), done)
        return upload_done(request, f"/t/{slug}/log/{done[0][0]}", done)

    @app.get("/t/{slug}/log/{log_slug}", response_class=HTMLResponse)
    def log_report(request: Request, slug: str, log_slug: str):
        load_doc(slug)
        row = load_log(slug, log_slug)
        store.touch_log(log_slug)
        cookie = request.cookies.get(f"dk_{log_slug}")
        delete_key = cookie if cookie and store.check_log_key(log_slug, cookie) else None
        resp = report_page(request, slug, row, delete_key)
        if delete_key:
            resp.delete_cookie(f"dk_{log_slug}", path="/")
        return resp

    @app.get("/t/{slug}/log/{log_slug}/download")
    def log_download(slug: str, log_slug: str):
        return send_log(load_log(slug, log_slug))

    def send_log(row: dict):
        raw = store.read_log_raw(row["slug"])
        if raw is None:
            raise HTTPException(404)
        base = re.sub(r"[^A-Za-z0-9._-]+", "-", row["name"]).strip("-._")[:60] or f"{row['slug']}.log"
        binary = raw[:5] == b"MLVLG"
        if not binary:
            raw = for_log_tools(raw, log_signature(row))
        return Response(raw, media_type="application/octet-stream" if binary else "text/plain; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{base}"'})

    @app.post("/t/{slug}/log/{log_slug}/apply")
    async def log_apply(request: Request, slug: str, log_slug: str):
        """Write a suggestion from the report into a new tune. The tune it came from is never modified."""
        doc = load_doc(slug)
        row = load_log(slug, log_slug)
        try:
            form = await request.form(max_files=0, max_fields=8)
        except Exception:
            return error_response(request, 400)
        kind = str(form.get("kind") or "")
        suggestion = row["report"].get(kind) if kind in ("ve", "timing") else None
        if not suggestion:
            return report_page(request, slug, row, flash="That suggestion isn't part of this report.", status=400)
        if str(form.get("acknowledge") or "") != "yes":
            return report_page(request, slug, row, flash="Tick the box to confirm you've read the changes.",
                               status=400)
        if store.over_limit(client_ip(request), limit):
            return report_page(request, slug, row, flash=MESSAGES[429], status=429)
        raw = store.read_raw(slug)
        if raw is None:
            raise HTTPException(404)
        try:
            new_raw, changed = await run_in_threadpool(logsmod.apply_suggestion, raw, doc, resolve_map(doc),
                                                       suggestion)
        except logsmod.LogError as e:
            return report_page(request, slug, row, flash=str(e), status=400)
        new_slug, key, err, status = await store_upload(request, new_raw, parent=slug)
        if err:
            return report_page(request, slug, row, flash=err, status=status)
        log.info("applied %s corrections from log %s: tune %s (%d values)", kind, log_slug, new_slug, changed)
        resp = RedirectResponse(f"/t/{new_slug}", status_code=303)
        set_key_cookie(resp, request, new_slug, key)
        return resp

    @app.post("/t/{slug}/log/{log_slug}/delete")
    async def log_delete(request: Request, slug: str, log_slug: str):
        load_log(slug, log_slug)
        try:
            form = await request.form(max_files=0, max_fields=4)
        except Exception:
            return error_response(request, 400)
        if not store.check_log_key(log_slug, str(form.get("key") or "").strip()):
            return error_response(request, 403, "That delete key doesn't match this log.")
        store.delete_log(log_slug)
        return RedirectResponse(f"/t/{slug}/log", status_code=303)

    # --------------------------------------------------------- log viewer
    def logs_page(request: Request, error: str | None = None, status: int = 200, tune: str = ""):
        return templates.TemplateResponse(request, "logs.html", {"error": error, "tune": tune,
                                                                 "og_url": page_url(request)}, status_code=status)

    @app.get("/logs", response_class=HTMLResponse)
    def logs_home(request: Request, tune: str = ""):
        return logs_page(request, tune=tune if slug_from(tune) else "")

    @app.post("/logs")
    async def logs_upload(request: Request):
        done, err, status, form = await take_log(request, None, "")
        if err and not done:
            return upload_error(request, err, status) or logs_page(
                request, err, status, str(form.get("tune") or "") if form is not None else "")
        if err:
            return partial_upload(request, err, viewer_url(done, ""), done, lambda msg: logs_page(request, msg, 400))
        return upload_done(request, viewer_url(done, ""), done)

    def any_log(log_slug: str) -> dict:
        row = store.get_log(log_slug) if SLUG_RE.match(log_slug or "") else None
        if row is None:
            raise HTTPException(404)
        return row

    def viewer_tune(request: Request, row: dict) -> tuple[str, TuneDoc | None]:
        """The tune the viewer reads a log with: `?tune=` (a slug or a tune link) if given, else the log's own."""
        if (request.query_params.get("tune") or "").strip().lower() == "none":
            return "", None
        asked = slug_from(request.query_params.get("tune"))
        for slug in (asked, row["tune_slug"]):
            doc = store.get_doc(slug) if slug else None
            if doc is not None:
                return slug, doc
        return "", None

    def also_logs(request: Request, log_slug: str) -> list[str]:
        out = []
        for s in (request.query_params.get("also") or "").split(",")[:LOG_MAX_FILES]:
            s = s.strip()
            if SLUG_RE.match(s) and s != log_slug and s not in out and store.get_log(s) is not None:
                out.append(s)
        return out

    @app.get("/l/{log_slug}", response_class=HTMLResponse)
    def log_viewer(request: Request, log_slug: str):
        row = any_log(log_slug)
        index, _ = log_index(log_slug)
        store.touch_log(log_slug)
        tune_slug, doc = viewer_tune(request, row)
        if doc is not None:
            store.touch(tune_slug)
        also = also_logs(request, log_slug)
        keys = []
        for s in [log_slug] + also:
            cookie = request.cookies.get(f"dk_{s}")
            if cookie and store.check_log_key(s, cookie):
                keys.append((s, store.get_log(s)["name"], cookie))
        seconds = index.get("seconds") or 0
        length = f"{int(seconds // 60)} min {int(seconds % 60)} s" if seconds >= 60 else f"{seconds:.1f} s"
        own = doc is not None and tune_slug == row["tune_slug"]
        tune_key = None
        if doc is not None and tune_slug != row["tune_slug"]:
            cookie = request.cookies.get(f"dk_{tune_slug}")
            tune_key = cookie if cookie and store.check_delete_key(tune_slug, cookie) else None
        resp = templates.TemplateResponse(request, "viewer.html", {
            "log_slug": log_slug, "name": row["name"], "index": index, "length": length,
            "tune_slug": tune_slug, "tune_label": views.tune_label(doc) if doc is not None else "",
            "own_tune": row["tune_slug"] if row["tune_slug"] and store.get_doc(row["tune_slug"]) else "",
            "summary": row["report"].get("summary") if own else None, "also": also,
            "keys": keys, "tune_key": tune_key, "og_url": page_url(request),
            "og_title": f"Datalog · {row['name']}",
            "og_desc": f"{length} · {index['rows']:,} records · {len(index['channels'])} channels"
                       + (f" · {index['title']}" if index.get("title") else ""),
        })
        for s, _, _ in keys:
            resp.delete_cookie(f"dk_{s}", path="/")
        if tune_key:
            resp.delete_cookie(f"dk_{tune_slug}", path="/")
        return resp

    @app.get("/l/{log_slug}/index.json")
    def log_index_json(request: Request, log_slug: str):
        row = any_log(log_slug)
        index, _ = log_index(log_slug)
        tune_slug, doc = viewer_tune(request, row)
        tables, tune = [], None
        roles = index.get("roles", {})
        channels = index["channels"]
        if doc is not None:
            tmap, tviews = tune_views(doc)
            tables = logsmod.viewer_tables(tviews, index, lambda z: meta_digits(tmap, z))
            idle = doc.get("useSeparateVeForIdle")
            tune = {"slug": tune_slug, "label": views.tune_label(doc), "stoich": stoich_of(doc),
                    "file": msq_filename(doc, tune_slug), "parent": None, "changed": 0,
                    "notes": store.notes(tune_slug), "rev": store.rev(tune_slug),
                    "idle_ve": bool(idle and idle.values and str(idle.values[0]).strip('"').lower() == "true")}
            # An edited copy: send the values it was edited from, so whoever opens the link sees what changed.
            src = edited_from(tune_slug)
            pdoc = store.get_doc(src["slug"]) if src and src["exists"] else None
            if pdoc is not None:
                tune["parent"] = {"slug": src["slug"], "label": src["label"]}
                for t in tables:
                    pc = pdoc.get(t["name"])
                    pz = list(pc.values) if pc is not None and pc.values is not None else []
                    if len(pz) == len(t["z"]) and all(isinstance(v, float) for v in pz):
                        diff = sum(1 for a, b in zip(pz, t["z"]) if abs(a - b) > 1e-9)
                        if diff:
                            t["p"] = pz
                            tune["changed"] += diff
        stoich = tune["stoich"] if tune else 14.7
        lam = {r: (1.0 if logsmod.meta_is_lambda(channels[roles[r]]) else stoich)
               for r in ("lambda", "lambda_target") if r in roles}
        if request.query_params.get("lite"):  # a live update: just the tune's tables, not the log's channels
            return JSONResponse({"tables": tables, "tune": tune}, headers={"Cache-Control": "private, no-cache"})
        return JSONResponse({
            "rows": index["rows"], "seconds": index.get("seconds"), "title": index.get("title", ""),
            "note": index.get("note", ""), "truncated": index.get("truncated", False),
            "roles": roles, "tables": tables, "tune": tune, "lam": lam, "markers": index.get("markers", []),
            "channels": [{k: c.get(k) for k in ("n", "u", "d", "lo", "hi")} for c in channels],
        }, headers={"Cache-Control": "private, no-cache"})

    @app.get("/l/{log_slug}/ch/{which}")
    def log_channel(log_slug: str, which: str):
        """One channel as little-endian float32, or `t` for the time of each record."""
        any_log(log_slug)
        index, base = log_index(log_slug)
        if which == "t":
            entry = index["time"]
        elif which.isdigit() and int(which) < len(index["channels"]):
            entry = index["channels"][int(which)]
        else:
            raise HTTPException(404)
        block = logsmod.read_block(store.col_path(log_slug), base, entry)
        return Response(block, media_type="application/octet-stream",
                        headers={"Content-Encoding": "deflate", "Cache-Control": "public, max-age=31536000, immutable"})

    # ---------------------------------------------------------------- the log doctor, and data for tools
    diag_cache: dict = {}

    def tune_stoich(request: Request, row: dict) -> float:
        _, doc = viewer_tune(request, row)
        return stoich_of(doc) if doc is not None else 14.7

    @app.get("/l/{log_slug}/diagnose.json")
    async def log_diagnose(request: Request, log_slug: str):
        """Everything the log doctor finds in this log: each finding with when, the numbers then, and what to check."""
        from . import diagnose as diagmod
        row = any_log(log_slug)
        stoich = tune_stoich(request, row)
        key = (log_slug, row.get("size"), stoich)
        if key not in diag_cache:
            raw = store.read_log_raw(log_slug)
            if raw is None:
                raise HTTPException(404)
            parsed = await run_in_threadpool(logsmod.parse_log, raw, row["name"])
            diag_cache[key] = await run_in_threadpool(diagmod.diagnose, parsed, stoich)
            while len(diag_cache) > 30:
                diag_cache.pop(next(iter(diag_cache)))
        return JSONResponse(dict(diag_cache[key], log=log_slug, name=row["name"]), headers={"Cache-Control": "private, no-cache"})

    @app.get("/l/{log_slug}/data.json")
    def log_data(log_slug: str, ch: str = "", s: str = "", every: int = 1, limit: int = 20000):
        """Raw numbers for tools: the channels named in `ch` (names or roles like rpm, map, lambda), between
        `s=from-to` seconds, every Nth record. No `ch`: the list of channels and roles."""
        import zlib
        import numpy as np
        row = any_log(log_slug)
        index, base = log_index(log_slug)
        chans, roles = index["channels"], index.get("roles", {})
        if not ch:
            return JSONResponse({"name": row["name"], "rows": index["rows"], "seconds": index.get("seconds"),
                                 "roles": {r: chans[i]["n"] for r, i in roles.items() if i < len(chans)},
                                 "channels": [{k: c.get(k) for k in ("n", "u", "lo", "hi")} for c in chans]})
        path = store.col_path(log_slug)

        def col(entry):
            return np.frombuffer(zlib.decompress(logsmod.read_block(path, base, entry)), dtype="<f4")
        t = col(index["time"])
        keep = np.ones(len(t), dtype=bool)
        rng = [r for r in (s or "").split(",") if r]
        if rng:
            keep[:] = False
            for part in rng:
                m = re.match(r"^\s*(-?[\d.]+)-(-?[\d.]+)\s*$", part)
                if m:
                    keep |= (t >= float(m.group(1))) & (t <= float(m.group(2)))
        sel = np.flatnonzero(keep)[:: max(1, every)][: max(1, min(limit, 200000))]
        out, units = {}, {}
        for name in [x.strip() for x in ch.split(",") if x.strip()][:40]:
            i = roles.get(name)
            if i is None:
                i = next((k for k, c in enumerate(chans) if c["n"].lower() == name.lower()), None)
            if i is None:
                continue
            v = col(chans[i])
            out[chans[i]["n"]] = [None if x != x else round(float(x), 4) for x in v[sel]]
            units[chans[i]["n"]] = chans[i].get("u", "")
        return JSONResponse({"t": [round(float(x), 3) for x in t[sel]], "channels": out, "units": units})

    @app.get("/l/{log_slug}/download")
    async def log_viewer_download(log_slug: str, s: str = ""):
        """The log as uploaded, or with `s=from-to,from-to` (seconds, as the viewer counts them) just those
        stretches, as a .msl that TunerStudio and MegaLogViewer open."""
        row = any_log(log_slug)
        ranges = parse_ranges(s)
        if not ranges:
            return send_log(row)
        raw = store.read_log_raw(log_slug)
        if raw is None:
            raise HTTPException(404)
        text = await run_in_threadpool(log_as_msl, raw, row["name"], ranges, False, log_signature(row))
        base = re.sub(r"[^A-Za-z0-9._-]+", "-", re.sub(r"\.(msl|mlg|csv|tsv|log)$", "", row["name"], flags=re.I)).strip("-._")[:50] or log_slug
        return Response(await run_in_threadpool(with_ego_cor, text.encode("latin-1", "replace")), media_type="text/plain; charset=iso-8859-1",
                        headers={"Content-Disposition": f'attachment; filename="{base}-section.msl"'})

    @app.post("/l/{log_slug}/trim")
    async def log_trim(request: Request, log_slug: str):
        """A new log made from this one: just the chosen stretches (`keep`), or this one with them taken out
        (`cut`). It reads with the same tune; the original log is never changed."""
        row = any_log(log_slug)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "That didn't come through. Try again."}, status_code=400)
        ranges, cut = parse_ranges(str(body.get("s") or "")), body.get("mode") == "cut"
        if not ranges:
            return JSONResponse({"error": "Mark a section first: ✂ Section, then drag across a graph."}, status_code=400)
        if store.over_limit(client_ip(request), limit):
            return JSONResponse({"error": MESSAGES[429]}, status_code=429)
        raw = store.read_log_raw(log_slug)
        if raw is None:
            raise HTTPException(404)
        text = await run_in_threadpool(log_as_msl, raw, row["name"], ranges, cut, log_signature(row))
        if text.count("\n") < 5:
            return JSONResponse({"error": "That would leave the log empty."}, status_code=400)
        tune = str(body.get("tune") or row["tune_slug"] or "")
        doc = store.get_doc(tune) if tune else None
        base_name = re.sub(r"\.(msl|mlg|csv|tsv|log)$", "", row["name"], flags=re.I)
        name = f"{base_name} ({'cut' if cut else 'trimmed'}).msl"
        try:
            slug, key, rows = await run_in_threadpool(ingest_log, doc, tune if doc else "", text.encode("latin-1", "replace"), name)
        except Exception:
            return JSONResponse({"error": "The trimmed log couldn't be made."}, status_code=400)
        store.record_upload(client_ip(request))
        resp = JSONResponse({"slug": slug, "rows": rows, "url": f"/l/{slug}" + (f"?tune={tune}" if doc else "")})
        set_key_cookie(resp, request, slug, key)
        return resp

    def log_signature(row: dict) -> str:
        """The ECU signature of the tune a log is read with (for a log that didn't bring TunerStudio's header)."""
        slug = row["tune_slug"] if "tune_slug" in row.keys() else ""
        doc = store.get_doc(slug) if slug else None
        return (getattr(doc, "signature", "") or "") if doc is not None else ""

    def with_signature(raw: bytes, signature: str) -> bytes:
        """TunerStudio names a log's fields (VE Analyze's EGO and lambda among them) by the ECU signature on its
        first line; without it, it falls back to MegaSquirt's names and asks for "EGO cor1". A text log whose
        header doesn't carry the tune's signature gets it as its first line; everything else stays as it was."""
        sig = (signature or "").replace('"', "").strip()
        if not sig:
            return raw
        head = raw[:4000].decode("latin-1", "replace").split("\n")
        quoted = []
        for ln in head:
            if not ln.strip().startswith('"'):
                break
            quoted.append(ln.strip())
        if any(q.strip('"').strip() == sig for q in quoted):
            return raw
        nl = b"\r\n" if b"\r\n" in raw[:4000] else b"\n"
        return b'"' + sig.encode("latin-1", "replace") + b'"' + nl + raw

    TRIM_NAMES = ("Fuel: Trim bank 1", "fuelPidCorrection1", "Fuel: Trim bank1")

    def with_ego_cor(raw: bytes) -> bytes:
        """MegaLogViewer's VE Analyze reads the closed-loop correction from a field named "EGO cor1" (MegaSquirt's
        name, 100 = none). FOME/rusEFI log it as "Fuel: Trim bank 1", a trim around 0 (their .ini gives VE Analyze
        100 + that). A text log that has the trim and no "EGO cor1" gets it as one more column."""
        nl = "\r\n" if b"\r\n" in raw[:4000] else "\n"
        text = raw.decode("latin-1")
        lines = text.split(nl)
        ni = next((i for i, ln in enumerate(lines[:20]) if ln and not ln.startswith('"')), None)
        if ni is None or ni + 1 >= len(lines):
            return raw
        names = lines[ni].split("\t")
        if "EGO cor1" in names:
            return raw
        k = next((names.index(n) for n in TRIM_NAMES if n in names), None)
        if k is None:
            return raw
        units_row = ni + 1 < len(lines) and not re.match(r"^-?[\d.]+(\t|$)", lines[ni + 1])
        out = lines[:ni] + [lines[ni] + "\tEGO cor1"]
        first = ni + 1
        if units_row:
            out.append(lines[ni + 1] + "\t%")
            first += 1
        for ln in lines[first:]:
            if not ln:
                out.append(ln)
                continue
            cells = ln.split("\t")
            try:
                v = f"{100.0 + float(cells[k]):.2f}" if k < len(cells) and cells[k].strip() else ""
            except ValueError:
                v = ""
            out.append(ln + "\t" + v)
        return nl.join(out).encode("latin-1")

    def for_log_tools(raw: bytes, signature: str) -> bytes:
        """A downloaded text log, ready for TunerStudio and MegaLogViewer: the ECU signature first (TunerStudio
        names the fields by it) and the EGO correction under the name MegaLogViewer's VE Analyze looks for."""
        return with_ego_cor(with_signature(raw, signature))
    app.state.for_log_tools = for_log_tools

    def parse_ranges(s: str) -> list[tuple[float, float]]:
        out = []
        for part in (s or "").split(",")[:50]:
            m = re.match(r"^\s*(-?[\d.]+)-(-?[\d.]+)\s*$", part)
            if m and float(m.group(2)) > float(m.group(1)):
                out.append((float(m.group(1)), float(m.group(2))))
        return out

    def log_as_msl(raw: bytes, name: str, ranges: list[tuple[float, float]], cut: bool = False, signature: str = "") -> str:
        """Any log the viewer reads, cut to the given stretches of time (or, with cut, with them taken out),
        written as a TunerStudio .msl that reads back exactly like the original: the log's own header lines (the
        ECU signature TunerStudio picks its field names by, and the capture date), its time column, every channel
        with its name, units and number of decimals."""
        import io
        import time as _time
        import numpy as np
        parsed = logsmod.parse_log(raw, name)
        roles = logsmod.resolve(parsed)
        t, _ = logsmod._timebase(parsed, roles)
        t = np.asarray(t, dtype=float)
        keep = np.zeros(len(t), dtype=bool)
        for a, b in ranges:
            keep |= (t >= a) & (t <= b)
        if cut:
            keep = ~keep
        tc = roles.get("time")
        chans = [c for c in parsed.channels if c is not tc]
        tcol = np.asarray(tc.arr, dtype=float)[keep] if tc is not None else t[keep]
        cols = [tcol] + [np.asarray(c.arr, dtype=float)[keep] for c in chans]
        buf = io.StringIO()
        head = list(parsed.header)
        sig = (signature or "").replace('"', "").strip()
        if head and sig and not any(h.strip().strip('"').strip() == sig for h in head):
            head.insert(0, '"' + sig + '"')  # TunerStudio names the fields by it (see with_signature)
        if not head:  # a log without TunerStudio's header: give it one, from the tune's ECU signature if there is one
            if signature:
                head.append('"' + signature.replace('"', "") + '"')
            what = ("without " if cut else "") + ", ".join(f"{a:.1f} to {b:.1f} s" for a, b in ranges)
            head.append('"Capture Date: ' + _time.strftime("%a %b %d %H:%M:%S UTC %Y", _time.gmtime()) +
                        ", File author: MSQ Viewer (" + name.replace('"', "") + ", " + what + ')"')
        for ln in head:
            buf.write(ln + "\n")
        buf.write("\t".join([tc.name if tc is not None else "Time"] + [c.name for c in chans]) + "\n")
        buf.write("\t".join([(tc.units or "s") if tc is not None else "s"] + [c.units or "" for c in chans]) + "\n")
        if keep.any():
            def fmt(c, default="%.6g"):
                d = getattr(c, "digits", None)
                return f"%.{d}f" if isinstance(d, int) and 0 <= d <= 6 else default
            fmts = [fmt(tc, "%.3f") if tc is not None else "%.3f"] + [fmt(c) for c in chans]
            body = io.StringIO()
            np.savetxt(body, np.column_stack(cols), fmt=fmts, delimiter="\t")
            buf.write(re.sub(r"(?<![^\t\n])-?nan(?![^\t\n])", "", body.getvalue()))
        return buf.getvalue()

    # The live session's log, all of it: every part, in order, as one .msl (optionally just some stretches, as
    # epoch seconds, since the live viewer's clock is the wall clock).
    def session_msl(s, eranges: list[tuple[float, float]]) -> tuple[str, str]:
        """Every part of the session's log as one .msl, written like TunerStudio writes one: the ECU signature, the
        capture date, the channel names and units, then the records. Parts recorded with different channels (a car
        page that updated mid-session) go in together, each channel in its own column."""
        import datetime as _dt
        parts = sorted((r for r in store.logs_for(s.tune) if r["name"].startswith("Live session")), key=lambda r: r["created_at"])
        heads, plan = [], []
        for r in parts:
            raw = store.read_log_raw(r["slug"])
            if not raw:
                continue
            lines = raw.decode("latin-1").split("\n")
            ni = next((i for i, ln in enumerate(lines[:12]) if ln.startswith("Time\t")), None)
            if ni is None or ni + 1 >= len(lines):
                continue
            quoted = [ln for ln in lines[:ni] if ln.startswith('"')]
            m = next((re.search(r"(\d{4}-\d\d-\d\dT[\d:.]+)Z", q) for q in quoted if re.search(r"\d{4}-\d\d-\d\dT", q)), None)
            t0 = _dt.datetime.fromisoformat(m.group(1)).replace(tzinfo=_dt.timezone.utc).timestamp() if m else None
            names, units = lines[ni].split("\t"), lines[ni + 1].split("\t")
            heads.append((quoted, names, units))
            plan.append((lines, ni + 2, t0, names))
        if not heads:
            return "", ""
        # the columns: the widest part's, in its order, then anything only older parts had
        quoted, cols, units0 = max(heads, key=lambda h: len(h[1]))
        unit_of = dict(zip(cols, units0))
        for _, names, units in heads:
            for n, u in zip(names, units):
                if n not in unit_of:
                    cols.append(n)
                    unit_of[n] = u
        out = []
        for lines, body_at, t0, names in plan:
            same = names == cols
            where = None if same else [cols.index(n) for n in names[1:]]
            shift, prev = 0.0, None
            for ln in lines[body_at:]:
                if not ln.strip():
                    continue
                tab = ln.find("\t")
                try:
                    tt = float(ln[:tab])
                except ValueError:
                    continue
                if prev is not None and tt + shift < prev - 1:  # a part whose clock restarted (an old car page reload): keep file order
                    shift = prev - tt + 0.05
                prev = tt + shift
                at = (t0 or 0) + tt + shift
                if eranges and not any(a <= at <= b for a, b in eranges):
                    continue
                if not same:
                    vals, row = ln.split("\t"), [""] * len(cols)
                    for k, v in zip(where, vals[1:]):
                        row[k] = v
                    out.append((at, "\t" + "\t".join(row[1:])))
                else:
                    out.append((at, ln[tab:]))
        out.sort(key=lambda x: x[0])
        first = out[0][0] if out else 0
        body, last = [], None
        for at, rest in out:
            if last is not None and at <= last:
                continue
            last = at
            body.append(f"{at - first:.3f}{rest}")
        when = _dt.datetime.fromtimestamp(first, _dt.timezone.utc) if out else _dt.datetime.now(_dt.timezone.utc)
        start = when.strftime("%Y-%m-%dT%H:%M:%S.%fZ") if out else ""
        sig = next((q for q in quoted if not q.startswith('"Capture Date') and not q.startswith('"MSQ Viewer')), "")
        if s.layout.get("comms", {}).get("signature"):  # exactly the ECU's signature, as TunerStudio writes it
            sig = '"' + s.layout["comms"]["signature"].replace('"', "").strip() + '"'
        head = ([sig] if sig else []) + ['"Capture Date: ' + when.strftime("%a %b %d %H:%M:%S UTC %Y") +
                                         ", File author: MSQ Viewer live tuning " + start + '"']
        return "\n".join(head + ["\t".join(cols), "\t".join(unit_of[c] for c in cols)] + body) + "\n", start[:16]
    app.state.session_msl = session_msl

    def session_diagnose(s) -> dict:
        import datetime as _dt
        from . import diagnose as diagmod
        text, _ = session_msl(s, [])
        if not text:
            return {"findings": [], "rows": 0, "seconds": 0, "epoch0": None}
        m = re.search(r"(\d{4}-\d\d-\d\dT[\d:.]+)Z", text[:1000])
        epoch0 = _dt.datetime.fromisoformat(m.group(1)).replace(tzinfo=_dt.timezone.utc).timestamp() if m else None
        doc = store.get_doc(s.tune) if s.tune else None
        out = diagmod.diagnose(logsmod.parse_log(text.encode("latin-1", "replace"), "session.msl"), stoich_of(doc) if doc is not None else 14.7)
        out["epoch0"] = epoch0
        return out
    app.state.session_diagnose = session_diagnose
    app.state.parse_ranges = parse_ranges

    @app.post("/l/{log_slug}/delete")
    async def log_viewer_delete(request: Request, log_slug: str):
        row = any_log(log_slug)
        try:
            form = await request.form(max_files=0, max_fields=4)
        except Exception:
            return error_response(request, 400)
        if not store.check_log_key(log_slug, str(form.get("key") or "").strip()):
            return error_response(request, 403, "That delete key doesn't match this log.")
        store.delete_log(log_slug)
        return RedirectResponse(f"/t/{row['tune_slug']}/log" if row["tune_slug"] else "/logs?deleted=1",
                                status_code=303)

    # ------------------------------------------------------------ compare
    @app.get("/compare", response_class=HTMLResponse)
    def compare_page(request: Request, a: str = "", b: str = ""):
        return templates.TemplateResponse(request, "compare.html", {"a": a, "b": b})

    @app.get("/compare/check", response_class=HTMLResponse)
    def compare_check(request: Request):
        raw = request.query_params.get("a") or request.query_params.get("b") or ""
        if not raw.strip():
            return HTMLResponse("")
        slug = slug_from(raw)
        doc = store.get_doc(slug) if slug else None
        if doc is None:
            return HTMLResponse('<span class="bad">✗ No tune found for that link</span>')
        label = f"{doc.family} {doc.version}".strip()
        extra = f" · {views.tune_label(doc)[:60]}" if doc.tune_comment else ""
        return HTMLResponse(f'<span class="good">✓ {_esc(label)}{_esc(extra)}</span>')

    @app.post("/compare")
    async def compare_submit(request: Request):
        def again(message: str, status: int, a="", b=""):
            return templates.TemplateResponse(request, "compare.html", {"a": a, "b": b, "error": message},
                                              status_code=status)

        if request.state._state.get("body_too_large"):
            return again(MESSAGES[413], 413)
        try:
            form = await request.form(max_files=1, max_fields=8)
        except BodyTooLarge:
            raise
        except Exception:
            return again("The form didn't come through. Try again.", 400)
        a_raw, b_raw = str(form.get("a") or ""), str(form.get("b") or "")
        a = slug_from(a_raw)
        if not a or store.get_doc(a) is None:
            return again("Tune A wasn't found. Paste a tune link or its 10-character code.", 400, a_raw, b_raw)
        data, err, status = await read_upload(form, required=False)
        if err:
            return again(err, status, a_raw, b_raw)
        key = None
        if data is not None:
            if store.over_limit(client_ip(request), limit):
                return again(MESSAGES[429], 429, a_raw, b_raw)
            b, key, err, status = await store_upload(request, data)
            if err:
                return again(err, status, a_raw, b_raw)
        else:
            b = slug_from(b_raw)
            if not b or store.get_doc(b) is None:
                return again("Tune B wasn't found. Paste a link, or upload a file for B.", 400, a_raw, b_raw)
        resp = RedirectResponse(f"/d/{a}/{b}", status_code=302)
        if key:
            set_key_cookie(resp, request, b, key)
        return resp

    @app.get("/d/{a}/{b}", response_class=HTMLResponse)
    def diff_view(request: Request, a: str, b: str):
        da, db_ = load_doc(a), load_doc(b)
        store.touch(a)
        store.touch(b)
        dm = views.diff_model(a, b, da, db_, resolve_map(da))
        delete_key = pop_delete_key(request, b)
        # An edited copy has the same name as its original; say which side is which.
        a_label, b_label = views.tune_label(da), views.tune_label(db_)
        meta_a, meta_b = store.get_meta(a), store.get_meta(b)
        if meta_b is not None and meta_b["parent"] == a:
            b_label += " (edited copy)"
        elif meta_a is not None and meta_a["parent"] == b:
            a_label += " (edited copy)"
        resp = templates.TemplateResponse(request, "diff.html", {
            "a": a, "b": b, "da": da, "db": db_, "dm": dm, "delete_key": delete_key,
            "a_label": a_label, "b_label": b_label, "og_url": page_url(request),
        })
        if delete_key:
            resp.delete_cookie(f"dk_{b}", path="/")
        return resp

    @app.get("/d/{a}/{b}/c/{name}", response_class=HTMLResponse)
    def diff_constant_view(request: Request, a: str, b: str, name: str):
        da, db_ = load_doc(a), load_doc(b)
        tds = diffmod.diff_tables(da, db_, resolve_map(da))
        td = next((t for t in tds if t.name == name), None)
        if td is None:
            raise HTTPException(404)
        nav = [t for t in tds if t.status == "changed" or t is td]
        j = nav.index(td)

        def link(t):
            return {"name": t.name, "label": t.label, "url": views.d_url(a, b, t.name)}

        return templates.TemplateResponse(request, "diff_constant.html", {
            "a": a, "b": b, "da": da, "db": db_, "td": td, "g": diffmod.grid_for(td), "st": views.diff_stats(td),
            "cat": views.categorize(td.label, td.name), "nav": [link(t) for t in nav],
            "prev": link(nav[j - 1]) if j > 0 else None, "next": link(nav[j + 1]) if j + 1 < len(nav) else None,
            "og_url": page_url(request),
        })

    def live_index(s) -> dict:
        """A live session described the way a log is (index.json): its channels (every live channel the ECU
        sends, named by their datalog labels), the roles found from those names exactly as for an uploaded log,
        and the session tune's tables with the channels that move their cursors. So the log viewer runs on it
        unchanged."""
        import numpy as np
        from .logfile import Channel, LogDoc
        outs, gauges = s.layout["outputs"], s.layout.get("gauges") or {}
        gby: dict = {}
        for gname in list(s.layout.get("front") or []) + list(gauges):
            g = gauges.get(gname)
            if g and g["ch"] not in gby:
                gby[g["ch"]] = g
        keys, chans, fake = [], [], []
        for name, o in outs.items():
            label, units, g = o.get("label") or name, o.get("units", ""), gby.get(name)
            lo, hi = (g["lo"], g["hi"]) if g and g["hi"] > g["lo"] and abs(g["hi"]) < 1e6 else (None, None)
            keys.append(name)
            chans.append({"n": label, "u": units, "d": g["vd"] if g else (0 if o.get("kind") == "bits" else 2), "lo": lo, "hi": hi})
            fake.append(Channel(label, units, values=np.array([1.0])))
        found = logsmod.resolve(LogDoc(fake, rows=1))
        where = {id(c): i for i, c in enumerate(fake)}
        roles = {r: where[id(c)] for r, c in found.items()}
        index = {"roles": roles, "channels": chans}
        tables, tune = [], None
        doc = store.get_doc(s.tune) if s.tune else None
        if doc is not None:
            tmap, tviews = tune_views(doc)
            tables = logsmod.viewer_tables(tviews, index, lambda z: meta_digits(tmap, z))
            editable = s.layout.get("editable") or {}
            for t in tables:
                t["ro"] = t["name"] not in editable  # what a remote change may not touch, shown read-only
            tune = {"slug": s.tune, "label": views.tune_label(doc), "stoich": stoich_of(doc),
                    "file": msq_filename(doc, s.tune), "parent": None, "changed": 0,
                    "notes": store.notes(s.tune), "rev": store.rev(s.tune), "idle_ve": False}
        stoich = tune["stoich"] if tune else 14.7
        lam = {r: (1.0 if logsmod.meta_is_lambda(chans[roles[r]]) else stoich) for r in ("lambda", "lambda_target") if r in roles}
        return {"rows": 0, "seconds": 0, "title": "", "note": "", "truncated": False, "roles": roles, "tables": tables,
                "tune": tune, "lam": lam, "markers": [], "channels": chans, "keys": keys, "live": True}

    def live_page(request: Request, s, role: str, key: str):
        doc = store.get_doc(s.tune) if s.tune else None
        index = live_index(s)
        return templates.TemplateResponse(request, "viewer.html", {
            "live": True, "role": role, "sid": s.id, "key": key, "log_slug": "", "name": "Live tuning",
            "index": index, "length": "live", "tune_slug": s.tune if doc is not None else "",
            "tune_label": views.tune_label(doc) if doc is not None else "", "own_tune": "", "summary": None,
            "also": [], "keys": [], "tune_key": None, "og_url": page_url(request), "og_title": "Live tuning",
            "og_desc": "A live tuning session"})

    livemod.register(app, store, templates, {"client_ip": client_ip, "ingest_log": ingest_log,
                                             "live_index": live_index, "live_page": live_page})

    return app


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


app = create_app()
