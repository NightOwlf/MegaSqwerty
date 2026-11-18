"""Live tuning: someone at the car connects the ECU to a page in Chrome (Web Serial, no install), and a tuner
anywhere opens a link on a phone or computer to watch it run and change the tables, sent to the ECU in moments.

The server only relays. The car page holds the ECU connection and is the only thing that ever writes to it:
it checks every change the tuner asks for against the driver's setting (off / ask each time / allow), size
limits and the value's range, writes it to the ECU's working memory (RAM), reads it back, and reports what
the ECU now holds. Nothing is permanent until someone burns it. Each session also keeps a shared tune copy,
updated as changes land, so the tune page's History, backups and downloads cover the live session too.

Sessions live in memory (one server process). If the server restarts, the car page starts the session
again under the same link; tuner pages reconnect by themselves."""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
import secrets
import time

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from . import ecuini
from . import edit as editmod
from . import logs as logsmod
from .parser import MsqError, parse_msq

log = logging.getLogger("msq.live")

ID_RE = re.compile(r"^[A-Za-z0-9]{12}$")
MAX_INI = 4 * 1024 * 1024
MAX_SESSIONS = 200
SESSION_IDLE = 6 * 3600          # a session with nobody connected for this long is dropped
VIEW_MSG_PER_SEC = 12            # what a tuner may send (edits, burn, undo); the car's stream is not limited
HIST_EVERY = 0.2                 # session history kept for tuners who join later: 5 frames a second…
HIST_MAX = 5 * 3600 * 2          # …for the last two hours (older is in the session log)


def _roles(outputs: dict) -> dict:
    """Which live channel is RPM, MAP, AFR… found by its log label, the same way logs are read."""
    by_key = {}
    for name, o in outputs.items():
        by_key.setdefault(re.sub(r"[^a-z0-9]", "", (o.get("label") or name).lower()), name)
    out = {}
    for role, pats in logsmod.ROLES.items():
        for p in pats:
            hit = next((n for k, n in by_key.items() if re.search(p, k)), None)
            if hit:
                out[role] = hit
                break
    # prefer the AFR reading for mixture, like the viewer does
    for k in ("afr", "afr1", "airfuelratio"):
        if k in by_key:
            out["afr"] = by_key[k]
            break
    return out


class Session:
    def __init__(self, sid: str, car_key: str, view_key: str, layout: dict, tune: str, original: str):
        self.id, self.car_key, self.view_key = sid, car_key, view_key
        self.layout = layout
        self.layout_gz = gzip.compress(json.dumps(layout, separators=(",", ":")).encode(), 6)
        self.tune, self.original = tune, original
        self.car: WebSocket | None = None
        self.viewers: set[WebSocket] = set()
        self.state: dict = {"car": False, "ecu": False, "mode": "ask", "burn": False, "needBurn": False,
                            "signature": "", "ecuSignature": ""}
        self.tables: dict = {}
        self.och: dict | None = None
        self.frame: str | None = None    # the latest live frame, as the car sent it
        self.chs: list = []              # the channel list those frames follow
        self.wants: dict = {}            # each tuner's extra gauges
        self.changes: list = []      # what's been applied, newest last
        self.touched = time.time()
        self.rate: dict = {}
        self.logs: dict = {}             # the session's recording: part number -> {slug, rows, seconds}
        # what's been seen since the session started, for a tuner who joins later: (time, channel list id, frame)
        self.hist: list = []
        self.hist_chs: list = []
        self.hist_last = 0.0
        self.log_lock = asyncio.Lock()

    def public_state(self) -> dict:
        return dict(self.state, viewers=len(self.viewers), tune=self.tune, original=self.original,
                    logs=[dict(v, part=k) for k, v in sorted(self.logs.items())])


def register(app, store, templates, deps) -> None:
    sessions: dict[str, Session] = {}
    client_ip = deps["client_ip"]

    def get(sid: str) -> Session:
        s = sessions.get(sid) if ID_RE.match(sid or "") else None
        if s is None:
            raise HTTPException(404)
        return s

    def prune() -> None:
        now = time.time()
        for sid, s in list(sessions.items()):
            if s.car is None and not s.viewers and now - s.touched > SESSION_IDLE:
                sessions.pop(sid, None)
        while len(sessions) > MAX_SESSIONS:
            oldest = min(sessions.values(), key=lambda x: x.touched)
            sessions.pop(oldest.id, None)

    async def send(ws: WebSocket | None, msg: dict) -> None:
        if ws is None:
            return
        try:
            await ws.send_text(json.dumps(msg, separators=(",", ":")))
        except Exception:
            pass

    async def to_viewers(s: Session, msg: dict) -> None:
        if s.viewers:
            text = json.dumps(msg, separators=(",", ":"))
            for v in list(s.viewers):
                try:
                    await v.send_text(text)
                except Exception:
                    s.viewers.discard(v)

    async def announce(s: Session) -> None:
        st = {"t": "state", "state": s.public_state()}
        await to_viewers(s, st)
        await send(s.car, st)

    # ------------------------------------------------- shared playback in the log viewer
    # Everyone looking at the same log link in "Live view" sees the same thing: whoever plays, pauses, scrubs or
    # zooms sends it, and the others follow. The server just passes it on (and says how many are here).
    rooms: dict[str, set] = {}

    @app.websocket("/l/{log_slug}/together")
    async def log_together(ws: WebSocket, log_slug: str):
        await ws.accept()
        if not re.match(r"^[A-Za-z0-9]{10}$", log_slug or "") or store.get_log(log_slug) is None:
            await ws.close(code=4404)
            return
        room = rooms.setdefault(log_slug, set())
        room.add(ws)

        async def count():
            msg = json.dumps({"t": "here", "n": len(room)})
            for o in list(room):
                try:
                    await o.send_text(msg)
                except Exception:
                    room.discard(o)
        await count()
        try:
            while True:
                text = await ws.receive_text()
                if len(text) > 4000:
                    continue
                for o in list(room):
                    if o is not ws:
                        try:
                            await o.send_text(text)
                        except Exception:
                            room.discard(o)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("log together socket error")
        finally:
            room.discard(ws)
            if not room:
                rooms.pop(log_slug, None)
            else:
                try:
                    await count()
                except Exception:
                    pass

    # ---------------------------------------------------------------- pages
    @app.get("/live", response_class=HTMLResponse)
    def live_start_page(request: Request):
        return templates.TemplateResponse(request, "live.html", {"role": "car", "sid": "", "key": ""})

    @app.get("/live/{sid}", response_class=HTMLResponse)
    def live_view_page(request: Request, sid: str, k: str = ""):
        if ID_RE.match(sid or "") and sid not in sessions and len(k) >= 12:
            # the server restarted moments ago and the car hasn't brought the session back yet: wait for it
            return HTMLResponse(
                '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<meta http-equiv="refresh" content="4"><title>Live tuning · waiting for the car</title>'
                '<body style="font:16px system-ui;padding:24px;background:#16181c;color:#e8eaed">'
                "<h2>Waiting for the car…</h2><p>This live session will be back in a moment: the car's laptop reconnects "
                "by itself. This page keeps checking.</p></body>", status_code=503, headers={"Retry-After": "4"})
        s = get(sid)
        role = "car" if secrets.compare_digest(k, s.car_key) else "view" if secrets.compare_digest(k, s.view_key) else None
        if role is None:
            raise HTTPException(404)
        return deps["live_page"](request, s, role, k)  # the log viewer, running live

    @app.get("/live/{sid}/index.json")
    def live_index_json(sid: str, k: str = ""):
        s = get(sid)
        if not (secrets.compare_digest(k, s.car_key) or secrets.compare_digest(k, s.view_key)):
            raise HTTPException(404)
        return JSONResponse(deps["live_index"](s), headers={"Cache-Control": "private, no-cache"})

    @app.post("/live/start")
    async def live_start(request: Request):
        """The car side starts (or, after a server restart, restarts) a session: the ECU definition (.ini) and
        the tune from the TunerStudio project."""
        prune()
        try:
            form = await request.form(max_files=2, max_fields=6)
        except Exception:
            return JSONResponse({"error": "That upload didn't come through. Try again."}, status_code=400)
        ini_f, msq_f = form.get("ini"), form.get("msq")
        if not isinstance(ini_f, UploadFile):
            return JSONResponse({"error": "Choose the TunerStudio project folder (it has projectCfg/mainController.ini)."}, status_code=400)
        ini_raw = await ini_f.read(MAX_INI + 1)
        msq_raw = await msq_f.read(16 * 1024 * 1024) if isinstance(msq_f, UploadFile) else b""
        if len(ini_raw) > MAX_INI:
            return JSONResponse({"error": "That .ini is too big to be an ECU definition."}, status_code=400)
        text = ini_raw.decode("latin-1")
        msq_text = msq_raw.decode("latin-1") if msq_raw else ""
        try:
            ini = await run_in_threadpool(ecuini.parse, text, ecuini.msq_settings(msq_text), ecuini.msq_values(msq_text))
        except ecuini.IniError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        comms = ini["comms"]
        if comms.get("messageEnvelopeFormat", "").strip('"') != "msEnvelope_1.0":
            return JSONResponse({"error": "This ECU uses TunerStudio's older serial protocol; live tuning needs one "
                                          "that uses msEnvelope_1.0 (FOME, rusEFI, MS3, Speeduino do)."}, status_code=400)
        layout = ecuini.layout_for_live(ini)
        layout["roles"] = _roles(layout["outputs"])

        # resume: same session id and car key (the car page keeps them); else a new one
        sid, car_key = str(form.get("sid") or ""), str(form.get("car_key") or "")
        old = sessions.get(sid) if ID_RE.match(sid) else None
        if old is not None and not secrets.compare_digest(car_key, old.car_key):
            return JSONResponse({"error": "That session belongs to someone else."}, status_code=403)
        tune, original = (str(form.get("tune") or ""), "")
        if msq_raw and not (tune and store.get_meta(tune) is not None):
            try:
                doc = await run_in_threadpool(parse_msq, msq_raw)
            except MsqError as e:
                return JSONResponse({"error": f"The tune in the project can't be read: {e}"}, status_code=400)
            original, _ = await run_in_threadpool(store.create_tune, msq_raw, doc)
            tune, _ = await run_in_threadpool(store.create_tune, msq_raw, doc, original)
            store.set_notes(tune, "Live tuning session " + time.strftime("%d %b %Y %H:%M UTC", time.gmtime()))
            store.record_upload(client_ip(request))
        if not ID_RE.match(sid) or (old is None and sid in sessions):
            sid = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") for _ in range(12))
        if old is not None:
            s = old
            s.layout = layout
            s.layout_gz = Session(sid, "", "", layout, "", "").layout_gz
        else:
            car_key = car_key if len(car_key) >= 16 else secrets.token_urlsafe(18)
            view_key = str(form.get("view_key") or "")
            view_key = view_key if len(view_key) >= 12 else secrets.token_urlsafe(12)
            s = Session(sid, car_key, view_key, layout, tune, original)
            sessions[sid] = s
        log.info("live session %s started (%s)", sid, comms.get("signature", "")[:60])
        return JSONResponse({"id": sid, "car_key": s.car_key, "view_key": s.view_key, "tune": s.tune,
                             "view_url": f"/live/{sid}?k={s.view_key}", "car_url": f"/live/{sid}?k={s.car_key}"})

    @app.get("/live/{sid}/layout")
    def live_layout(sid: str, k: str = ""):
        s = get(sid)
        if not (secrets.compare_digest(k, s.car_key) or secrets.compare_digest(k, s.view_key)):
            raise HTTPException(404)
        return Response(s.layout_gz, media_type="application/json",
                        headers={"Content-Encoding": "gzip", "Cache-Control": "private, no-cache"})

    # ---------------------------------------------------------------- the session's log
    LOG_PART_MAX = 24 * 1024 * 1024

    @app.post("/live/{sid}/log")
    async def live_log(request: Request, sid: str, k: str = "", part: int = 1, slug: str = "", secs: float = 0, t0: float = 0):
        """The car page records the session (like TunerStudio's datalog) and sends what's new every couple of
        minutes: rows of a .msl log, the first time with its header. They're added to the part's log, which is
        stored like any uploaded log against the session's tune copy, so it opens in the log viewer with the
        changes made live (and VE Analyze can use it). The link stays the same as it grows."""
        s = get(sid)
        if not secrets.compare_digest(k, s.car_key):
            raise HTTPException(404)
        body = await request.body()
        if not body or len(body) > LOG_PART_MAX:
            return JSONResponse({"error": "empty or too big"}, status_code=400)
        part = max(1, min(int(part), 999))
        ingest = deps["ingest_log"]
        async with s.log_lock:
            have = s.logs.get(part, {}).get("slug") or ""
            if not have and slug and logsmod_slug_ok(slug):
                row = store.get_log(slug)  # the server restarted mid-session: carry on with the same log
                if row is not None and s.tune and row["tune_slug"] == s.tune:
                    have = slug
            raw = (store.read_log_raw(have) or b"") if have else b""
            if have and len(raw) + len(body) > 4 * LOG_PART_MAX:
                return JSONResponse({"error": "full", "next": part + 1}, status_code=409)
            if raw and not raw.endswith(b"\n"):
                raw += b"\n"
            if raw:
                body = continue_time(raw, body, t0)
            data = raw + body
            doc = store.get_doc(s.tune) if s.tune else None
            name = f"Live session {time.strftime('%d %b %Y %H:%M', time.gmtime(s.touched))} UTC" + (f" part {part}" if part > 1 else "") + ".msl"
            try:  # the log grows in place: replaced, never deleted first, so a restart can't lose it
                new, _key, rows = await run_in_threadpool(ingest, doc, s.tune if doc else "", data, name, have or None, bool(have))
            except Exception as e:  # noqa: BLE001 - a log that can't be read: keep the session going
                log.warning("live log for %s not stored: %s", sid, e, exc_info=True)
                return JSONResponse({"error": "That log couldn't be read."}, status_code=400)
            s.logs[part] = {"slug": new, "rows": rows, "seconds": round(max(0.0, min(secs, 86400.0)), 1), "at": int(time.time())}
        await announce(s)
        return JSONResponse({"slug": new, "rows": rows, "url": f"/l/{new}?tune={s.tune}" if s.tune else f"/l/{new}"})

    def continue_time(raw: bytes, body: bytes, t0: float) -> bytes:
        """Rows added to a log must carry on its clock. A car page that was reloaded starts counting from 0
        again: shift its rows by when it started (t0, epoch ms) against when the log did (its first line), or at
        least to just after the last row."""
        import datetime as _dt
        tail = raw[-4000:].decode("latin-1").strip().split("\n")
        try:
            last = float(tail[-1].split("\t", 1)[0])
        except (ValueError, IndexError):
            return body
        lines = body.decode("latin-1").split("\n")
        first_i = next((i for i, ln in enumerate(lines) if ln[:1].isdigit() or ln[:1] == "-"), None)
        if first_i is None:
            return body
        try:
            first = float(lines[first_i].split("\t", 1)[0])
        except ValueError:
            return body
        shift = 0.0
        head = raw[:200].decode("latin-1")
        m = re.search(r"(\d{4}-\d\d-\d\dT[\d:.]+)Z", head)
        if m and t0 > 0:
            log_t0 = _dt.datetime.fromisoformat(m.group(1)).replace(tzinfo=_dt.timezone.utc).timestamp() * 1000
            shift = max(0.0, (t0 - log_t0) / 1000)
        if first + shift <= last:
            shift = last - first + 0.05
        if shift < 0.0005:
            return body
        out = []
        for ln in lines:
            if ln[:1].isdigit() or ln[:1] == "-":
                tab = ln.find("\t")
                try:
                    ln = f"{float(ln[:tab]) + shift:.3f}{ln[tab:]}"
                except ValueError:
                    pass
            out.append(ln)
        return "\n".join(out).encode("latin-1")

    @app.get("/live/{sid}/session.msl")
    async def live_session_msl(sid: str, k: str = "", e: str = ""):
        """The whole session's log as one .msl, or with `e=` just the chosen stretches (epoch seconds)."""
        s = get(sid)
        if not (secrets.compare_digest(k, s.car_key) or secrets.compare_digest(k, s.view_key)):
            raise HTTPException(404)
        text, start = await run_in_threadpool(app.state.session_msl, s, app.state.parse_ranges(e))
        if not text:
            return JSONResponse({"error": "Nothing recorded yet: the first save is a minute after the ECU connects."}, status_code=404)
        fname = "Live-session-" + re.sub(r"[^0-9T-]", "-", start or "now") + ("-section" if e else "") + ".msl"
        return Response(text.encode("latin-1", "replace"), media_type="text/plain; charset=iso-8859-1",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    def logsmod_slug_ok(slug: str) -> bool:
        return bool(re.match(r"^[A-Za-z0-9]{10}$", slug or ""))

    # ---------------------------------------------------------------- the relay
    def apply_to_copy(s: Session, table: str, cells: dict, label: str | None = None) -> None:
        """Keep the session's tune copy in step with what the ECU now holds (cells: {index: value})."""
        if not s.tune or not cells:
            return
        raw = store.read_raw(s.tune)
        if raw is None:
            return
        try:
            new_raw, _ = editmod.apply_changes(raw, {table: {str(k): v for k, v in cells.items()}})
            doc = parse_msq(new_raw)
        except (editmod.EditError, MsqError):
            return  # a constant the tune file doesn't have, or can't hold: the ECU still has it
        if label:
            store.add_version(s.tune, raw, label)
        elif time.time() - store.last_version_at(s.tune) > 600:
            store.add_version(s.tune, raw, "Auto-save")
        store.replace_tune(s.tune, new_raw, doc)

    def sync_copy(s: Session, tables: dict) -> None:
        """Make the session's tune copy hold what the ECU read back (only what differs, one backup first)."""
        if not s.tune or not tables:
            return
        doc = store.get_doc(s.tune)
        if doc is None:
            return
        changes = {}
        for name, vals in tables.items():
            have = doc.get(name)
            if have is None or not isinstance(vals, list):
                continue
            old = list(have.values) if have.values is not None else []
            diff = {}
            for i, v in enumerate(vals):
                try:
                    o = float(str(old[i]).strip('"')) if i < len(old) else None
                except ValueError:
                    o = None
                if isinstance(v, (int, float)) and (o is None or abs(o - v) > 1e-6 * max(1.0, abs(v))):
                    diff[str(i)] = v
            if diff:
                changes[name] = diff
        if not changes:
            return
        raw = store.read_raw(s.tune)
        try:
            new_raw, _ = editmod.apply_changes(raw, changes)
            new_doc = parse_msq(new_raw)
        except (editmod.EditError, MsqError):
            return
        store.add_version(s.tune, raw, "Before syncing with the ECU")
        store.replace_tune(s.tune, new_raw, new_doc)

    @app.websocket("/live/{sid}/ws")
    async def live_ws(ws: WebSocket, sid: str, k: str = ""):
        s = sessions.get(sid) if ID_RE.match(sid or "") else None
        role = None
        if s is not None:
            role = "car" if secrets.compare_digest(k, s.car_key) else "view" if secrets.compare_digest(k, s.view_key) else None
        await ws.accept()
        if role is None:  # accepted first, so the page reads 4404 (a refusal before accepting reaches it as 1006)
            await ws.close(code=4404)
            return
        s.touched = time.time()
        if role == "car":
            if s.car is not None:
                await send(s.car, {"t": "replaced"})
                try:
                    await s.car.close(code=4000)
                except Exception:
                    pass
            s.car = ws
            s.state["car"] = True
        else:
            s.viewers.add(ws)
        och = None
        if s.frame and s.chs:
            try:
                vals = json.loads(s.frame).get("v") or []
                och = {n: v for n, v in zip(s.chs, vals) if v is not None}
            except ValueError:
                och = None
        await send(ws, {"t": "hello", "v": templates.env.globals.get("asset_v", ""), "role": role, "state": s.public_state(), "tables": s.tables, "och": och,
                        "chs": s.chs, "changes": s.changes[-200:], "want": sorted({n for w in s.wants.values() for n in w})})
        if role == "view" and s.hist:  # everything seen so far, so the graph starts where the session did
            try:
                parts = ",".join(f"[{t:.2f},{cid},{text}]" for t, cid, text in s.hist)
                await ws.send_text('{"t":"hist","chs":' + json.dumps(s.hist_chs, separators=(",", ":")) + ',"f":[' + parts + "]}")
            except Exception:
                pass
        await announce(s)
        try:
            while True:
                text = await ws.receive_text()
                if len(text) > 2_000_000:
                    continue
                if role == "car" and text.startswith('{"t":"o"'):  # a live frame: pass it on untouched, at once
                    s.frame = text
                    now = time.time()
                    if now - s.hist_last >= HIST_EVERY and s.chs:
                        s.hist_last = now
                        if not s.hist_chs or s.hist_chs[-1] is not s.chs:
                            s.hist_chs.append(s.chs)
                        s.hist.append((now, len(s.hist_chs) - 1, text))
                        if len(s.hist) > HIST_MAX:
                            del s.hist[: len(s.hist) - HIST_MAX]
                    if s.viewers:
                        for v in list(s.viewers):
                            try:
                                await v.send_text(text)
                            except Exception:
                                s.viewers.discard(v)
                    continue
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                s.touched = time.time()
                t = msg.get("t")
                if role == "car":
                    if t == "o":  # a live frame formatted some other way: same as the fast path
                        s.frame = json.dumps(msg, separators=(",", ":"))
                        await to_viewers(s, msg)
                    elif t == "chs":
                        s.chs = [str(n) for n in (msg.get("n") or [])][:2000]
                        await to_viewers(s, {"t": "chs", "n": s.chs})
                    elif t == "state":
                        for key in ("ecu", "mode", "burn", "needBurn", "ecuSignature", "signature"):
                            if key in msg:
                                s.state[key] = msg[key]
                        if s.state.get("mode") not in ("off", "ask", "auto"):
                            s.state["mode"] = "off"
                        await announce(s)
                    elif t == "tables":
                        s.tables.update(msg.get("tables") or {})
                        await to_viewers(s, {"t": "tables", "tables": msg.get("tables") or {}})
                        # the tune copy follows what the ECU really has (it may differ from the project's file)
                        await run_in_threadpool(sync_copy, s, msg.get("tables") or {})
                    elif t == "applied":
                        table, cells = msg.get("table"), msg.get("cells") or {}
                        if table in s.tables and isinstance(s.tables[table], list):
                            for kk, v in cells.items():
                                if str(kk).isdigit() and int(kk) < len(s.tables[table]):
                                    s.tables[table][int(kk)] = v
                        was = msg.get("was") if isinstance(msg.get("was"), dict) else {}
                        entry = {"id": msg.get("id"), "table": table, "cells": cells, "was": was, "by": msg.get("by", "tuner"),
                                 "at": int(time.time()), "note": msg.get("note", "")}
                        s.changes.append(entry)
                        del s.changes[:-200]
                        await run_in_threadpool(apply_to_copy, s, table, cells)  # the copy first: then it's current
                        await to_viewers(s, dict(entry, t="applied"))
                    elif t in ("rejected", "burned", "undone", "notice"):
                        if t == "burned":
                            s.state["needBurn"] = False
                            raw = store.read_raw(s.tune) if s.tune else None
                            if raw:
                                store.add_version(s.tune, raw, "Burned to the ECU " + time.strftime("%d %b %H:%M UTC", time.gmtime()))
                        await to_viewers(s, msg)
                        if t == "burned":
                            await announce(s)
                else:  # a tuner: may only ask; the car decides
                    now = int(time.time())
                    n = s.rate.get((id(ws), now), 0) + 1
                    s.rate = {key: val for key, val in s.rate.items() if key[1] >= now - 1}
                    s.rate[(id(ws), now)] = n
                    if n > VIEW_MSG_PER_SEC:
                        continue
                    if t in ("set", "undo", "burn"):
                        if s.car is None or not s.state.get("ecu"):
                            await send(ws, {"t": "rejected", "id": msg.get("id"), "why": "The car isn't connected right now."})
                        elif s.state.get("mode") == "off" and t != "burn":
                            await send(ws, {"t": "rejected", "id": msg.get("id"), "why": "The driver has remote changes turned off."})
                        elif t == "burn" and not s.state.get("burn"):
                            await send(ws, {"t": "rejected", "id": msg.get("id"), "why": "Only the driver can burn right now (ask them, or they can allow it)."})
                        else:
                            fwd = {key: msg.get(key) for key in ("t", "id", "table", "cells", "note")}
                            await send(s.car, fwd)
                    elif t == "ping":
                        await send(ws, {"t": "pong", "at": msg.get("at")})
                    elif t == "want":  # gauges this tuner added: the car streams them too
                        s.wants[id(ws)] = [str(n) for n in (msg.get("n") or [])][:60]
                        await send(s.car, {"t": "want", "n": sorted({n for w in s.wants.values() for n in w})})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("live socket error")
        finally:
            if role == "car" and s.car is ws:
                s.car = None
                s.state["car"] = False
                s.state["ecu"] = False
            s.viewers.discard(ws)
            s.wants.pop(id(ws), None)
            s.touched = time.time()
            try:
                await announce(s)
            except Exception:
                pass
