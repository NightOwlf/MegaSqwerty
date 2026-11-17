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

    def public_state(self) -> dict:
        return dict(self.state, viewers=len(self.viewers), tune=self.tune, original=self.original)


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

    # ---------------------------------------------------------------- pages
    @app.get("/live", response_class=HTMLResponse)
    def live_start_page(request: Request):
        return templates.TemplateResponse(request, "live.html", {"role": "car", "sid": "", "key": ""})

    @app.get("/live/{sid}", response_class=HTMLResponse)
    def live_view_page(request: Request, sid: str, k: str = ""):
        s = get(sid)
        role = "car" if secrets.compare_digest(k, s.car_key) else "view" if secrets.compare_digest(k, s.view_key) else None
        if role is None:
            raise HTTPException(404)
        return templates.TemplateResponse(request, "live.html", {"role": role, "sid": sid, "key": k})

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
            ini = await run_in_threadpool(ecuini.parse, text, ecuini.msq_settings(msq_text))
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

    @app.websocket("/live/{sid}/ws")
    async def live_ws(ws: WebSocket, sid: str, k: str = ""):
        s = sessions.get(sid) if ID_RE.match(sid or "") else None
        role = None
        if s is not None:
            role = "car" if secrets.compare_digest(k, s.car_key) else "view" if secrets.compare_digest(k, s.view_key) else None
        if role is None:
            await ws.close(code=4404)
            return
        await ws.accept()
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
        await send(ws, {"t": "hello", "role": role, "state": s.public_state(), "tables": s.tables, "och": och,
                        "chs": s.chs, "changes": s.changes[-30:], "want": sorted({n for w in s.wants.values() for n in w})})
        await announce(s)
        try:
            while True:
                text = await ws.receive_text()
                if len(text) > 2_000_000:
                    continue
                if role == "car" and text.startswith('{"t":"o"'):  # a live frame: pass it on untouched, at once
                    s.frame = text
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
                    elif t == "applied":
                        table, cells = msg.get("table"), msg.get("cells") or {}
                        if table in s.tables and isinstance(s.tables[table], list):
                            for kk, v in cells.items():
                                if str(kk).isdigit() and int(kk) < len(s.tables[table]):
                                    s.tables[table][int(kk)] = v
                        entry = {"id": msg.get("id"), "table": table, "cells": cells, "by": msg.get("by", "tuner"),
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
