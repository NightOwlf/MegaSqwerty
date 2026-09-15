"""MSQ Viewer web app."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
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

from . import diff as diffmod
from . import edit as editmod
from . import views
from .db import SLUG_RE, Store
from .parser import MAX_BYTES, MsqError, TuneDoc, fmt_value, parse_msq
from .render import axis_labels, build_grid
from .tablemaps import TableView, all_tables, meta_digits, meta_units, resolve_map, summary_fields

log = logging.getLogger("msq")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

HERE = Path(__file__).resolve().parent
MAX_MB = MAX_BYTES // (1024 * 1024)
BODY_LIMIT = MAX_BYTES + 256 * 1024  # multipart framing + form fields

CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")

MESSAGES = {
    400: "That request didn't make sense.",
    403: "Not allowed.",
    404: "Nothing here. The tune may have been deleted, or it expired after 180 days without views.",
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
        declared = None
        for k, v in scope["headers"]:
            if k == b"content-length":
                try:
                    declared = int(v)
                except ValueError:
                    declared = self.limit + 1
        if declared is not None and declared > self.limit:
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
                if seen > self.limit:
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
                                    for f in ("app.css", "app.js", "theme.js", "edit.js"))).hexdigest()[:8]
    templates.env.globals.update(asset_v=asset_v, max_mb=MAX_MB, max_bytes=MAX_BYTES, icons=views.ICONS,
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
        if request.url.path.startswith(("/t/", "/d/")):
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

    async def read_upload(form, field: str = "file", required: bool = True):
        """-> (bytes | None, error message | None, status)."""
        f = form.get(field)
        if not isinstance(f, UploadFile) or not f.filename:
            return None, ("Choose a .msq file first." if required else None), 400
        try:
            data = await f.read(MAX_BYTES + 1)
        finally:
            await f.close()
        if len(data) > MAX_BYTES:
            return None, MESSAGES[413], 413
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
        return build_grid(v.id, v.label, v.z, v.x, v.y, v.palette, v.units, v.x_label, v.y_label,
                          digits=meta_digits(tmap, v.z))

    def summary_rows(doc: TuneDoc, tmap: dict):
        return [(label, views.display_value(c, tmap), meta_units(tmap, c)) for label, c in summary_fields(doc, tmap)]

    def og_for(doc: TuneDoc, summary) -> tuple[str, str]:
        title = f"{views.family_label(doc)} {doc.version}".strip() + " tune"
        if doc.tune_comment:
            title += f" · {doc.tune_comment[:80]}"
        bits = [f"{label} {val}{(' ' + units) if units else ''}" for label, val, units in summary[:6]]
        desc = " · ".join(bits) or "TunerStudio .msq tune"
        return title, f"{desc}. Signature: {doc.signature or 'none'}"[:300]

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
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def home(request: Request):
        return templates.TemplateResponse(request, "home.html", {"deleted": request.query_params.get("deleted"),
                                                                 "demo": demo})

    def home_error(request: Request, message: str, status: int):
        return templates.TemplateResponse(request, "home.html", {"error": message, "demo": demo},
                                          status_code=status)

    @app.post("/upload")
    async def upload(request: Request):
        if request.state._state.get("body_too_large"):
            return home_error(request, MESSAGES[413], 413)
        if store.over_limit(client_ip(request), limit):
            return home_error(request, MESSAGES[429], 429)
        try:
            form = await request.form(max_files=1, max_fields=8)
        except BodyTooLarge:
            raise
        except Exception:
            return home_error(request, "The upload didn't come through. Try again.", 400)
        data, err, status = await read_upload(form)
        if err:
            return home_error(request, err, status)
        slug, key, err, status = await store_upload(request, data)
        if err:
            return home_error(request, err, status)
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
        return Response(raw, media_type="application/xml",
                        headers={"Content-Disposition": f'attachment; filename="{slug}.msq"'})

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
        new_slug, key, err, status = await store_upload(request, new_raw, parent=slug)
        if err:
            return fail(err, status)
        log.info("saved edited tune %s from %s (%d values)", new_slug, slug, changed)
        resp = JSONResponse({"url": f"/t/{new_slug}", "slug": new_slug, "changed": changed})
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
        dials, readouts = views.gauges(summary)
        og_title, og_desc = og_for(doc, summary)
        delete_key = pop_delete_key(request, slug)
        resp = templates.TemplateResponse(request, "tune.html", {
            "slug": slug, "doc": doc, "tmap": tmap, "m": model, "fgrids": fgrids, "summary": summary,
            "dials": dials, "readouts": readouts, "parent": edited_from(slug),
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
                       x_label=cv.x_label if cv else "", y_label=cv.y_label if cv else "",
                       chart=views.build_chart(c.values, xs, cv.x_label if cv else "",
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
        extra = f" · {doc.tune_comment[:60]}" if doc.tune_comment else ""
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
        resp = templates.TemplateResponse(request, "diff.html", {
            "a": a, "b": b, "da": da, "db": db_, "dm": dm, "delete_key": delete_key,
            "a_label": views.tune_label(da), "b_label": views.tune_label(db_), "og_url": page_url(request),
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
