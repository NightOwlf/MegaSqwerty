"""MSQ Viewer web app."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys
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
LOG_UPLOAD_RE = re.compile(r"^(/logs|/t/[A-Za-z0-9]{10}/log)/?$")
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
                                    for f in ("app.css", "app.js", "theme.js", "edit.js", "viewer.js", "veal.js"))).hexdigest()[:8]
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
        resp.headers.setdefault("Content-Security-Policy", CSP)
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
        try:
            new_raw, changed = await run_in_threadpool(editmod.apply_changes, raw, changes)
        except editmod.EditError as e:
            return fail(str(e))
        # Saving again to an edited copy you made (you hold its key): update it in place, so the link you
        # already sent shows the latest. Uploaded originals are never overwritten, and nobody else's copy is.
        own = str(payload.get("key") or "").strip() if isinstance(payload, dict) else ""
        meta = store.get_meta(slug)
        if own and meta is not None and meta["parent"] and store.check_delete_key(slug, own):
            try:
                doc = await run_in_threadpool(parse_msq, new_raw)
            except MsqError as e:
                return fail(str(e))
            await run_in_threadpool(store.replace_tune, slug, new_raw, doc)
            log.info("updated edited tune %s in place (%d values)", slug, changed)
            return JSONResponse({"url": f"/t/{slug}", "slug": slug, "changed": changed, "key": own,
                                 "updated": True, "file": msq_filename(doc, slug)})
        new_slug, key, err, status = await store_upload(request, new_raw, parent=slug)
        if err:
            return fail(err, status)
        log.info("saved edited tune %s from %s (%d values)", new_slug, slug, changed)
        resp = JSONResponse({"url": f"/t/{new_slug}", "slug": new_slug, "changed": changed, "key": key,
                             "updated": False, "file": msq_filename(store.get_doc(new_slug), new_slug)})
        set_key_cookie(resp, request, new_slug, key)
        return resp

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

    def ingest_log(doc: TuneDoc | None, tune_slug: str, data: bytes, filename: str) -> tuple[str, str, int]:
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
        slug, key = store.create_log(data, tune_slug, filename, report,
                                     columns=lambda path: logsmod.build_columns(parsed, path))
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

    @app.get("/l/{log_slug}/download")
    def log_viewer_download(log_slug: str):
        return send_log(any_log(log_slug))

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

    return app


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


app = create_app()
