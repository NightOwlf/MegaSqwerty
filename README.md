# MSQ Viewer

An online viewer for TunerStudio `.msq` tune files: MegaSquirt (MS1/MS2/MS3), Speeduino, rusEFI and FOME
(including vendor boards such as the Vato Tuned VTHPNP). Upload a tune from your phone and you get a
shareable link. It can also diff two tunes cell by cell.

The viewer is laid out to be familiar to a TunerStudio user: a toolbar of tuning-category menus (Fuel,
Ignition, Idle, Boost, Cam/VVT, Sensors…), Dash / Tables / Curves / Settings tabs, windows that read like
TunerStudio's dialogs, a gauge cluster of key settings, and a status bar. Tables use TunerStudio-style
blue→red cells with load up the left and RPM along the bottom, and have a 3D view. There's a dark and a
light theme. On a phone the tabs move to a bottom bar and menus open as bottom sheets.

No login, no accounts, no secrets. **Anyone with a link can see that tune.**

Stack: Python 3.12, FastAPI, Jinja2 server-rendered templates, SQLite (stdlib `sqlite3`, WAL), htmx, and
`defusedxml` for all XML parsing. No Node, no build step.

## Local development

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Or with plain pip: `python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`.

Open http://localhost:8000. Locally, tunes are stored in `./data/` (git-ignored). Set `DATA_DIR` to put
them somewhere else.

Run the tests:

```bash
.venv/bin/python -m pytest -q
```

Regenerate the synthetic fixtures: `.venv/bin/python tests/fixtures/make_fixtures.py`.

### Docker

```bash
docker build -t msq-viewer .
docker run -p 8000:8000 -v "$PWD/data:/data" msq-viewer
```

## Deploying on Railway

1. In Railway, **New Project → Deploy from GitHub repo** and pick this repo. Railway picks up
   `railway.json`, which builds from the `Dockerfile` and sets `/healthz` as the healthcheck.
   Pushes to `main` redeploy automatically.
2. **Add a volume** to the service with mount path `/data`. The SQLite DB (`/data/msq.db`) and the
   uploaded files (`/data/tunes/<slug>.msq`) live there. Without a volume, every redeploy wipes all tunes and
   every shared link: the app logs a warning at boot and `/healthz` reports `"persistent": false`.
3. **Settings → Networking → Generate Domain** gives you the public `*.up.railway.app` URL.

The app binds `0.0.0.0:$PORT`. Optional env var: `UPLOADS_PER_HOUR` (default `20`).

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | Upload page |
| `POST /upload` | Parse and store a tune, then 302 to `/t/{slug}`. The delete key is shown once on the next page |
| `GET /t/{slug}` | Viewer |
| `GET /t/{slug}.json` | Parsed tune as JSON |
| `GET /t/{slug}.msq` | Original file download |
| `DELETE /t/{slug}?key=…` | Delete with the key from upload (there's also a `POST /t/{slug}/delete` form fallback) |
| `POST /t/{slug}/save` | Save edited values as a new tune. JSON `{"changes": {name: {index: number}}}` → `{"url", "slug"}` |
| `GET /t/{slug}/boost` | Boost prep: what the tune has, and the questions |
| `POST /t/{slug}/boost` | `action=preview` shows the plan; `action=create` writes it as a new tune |
| `GET /t/{slug}/log` | Upload a datalog, and the logs already read against this tune |
| `POST /t/{slug}/log` | Parse and analyse a log, then 303 to its report |
| `GET /t/{slug}/log/{log}` | The report. `/download` gets the original log back |
| `POST /t/{slug}/log/{log}/apply` | Write the VE or timing suggestions into a new tune |
| `POST /t/{slug}/log/{log}/delete` | Delete a log with the key from its upload |
| `GET /compare`, `POST /compare` | Pick two tunes, or paste A and upload B |
| `GET /d/{a}/{b}` | Cell-by-cell diff, plus a list of settings that differ |
| `GET /healthz` | Healthcheck |

## Editing a tune and sending it back

Anyone with a tune's link can edit it and send a new link back. Press **Edit tune** (or **Edit** on a table,
curve or setting page):

- **Tables** work like TunerStudio's table editor. Select cells by clicking, dragging or shift-clicking (on
  a phone, tap a cell, or tap **Range** and then the far corner). Then type a value and **Set**, **Add**,
  **± %**, step **▲ / ▼**, **Interpolate** across the selection, or **Undo**. Keyboard: arrows move,
  Shift+arrows extend, typing a number starts a value, Enter sets, + / − step, Ctrl/Cmd+Z undoes.
- **Curves, axis bins and numeric settings**: tap the number and type.
- Edits stay in the browser until **Save as new tune**. Saving never changes the original. It creates a new
  tune with its own link and delete key, marked **Edited copy**, with a **See what changed** diff. Send that
  link back; the other person downloads the `.msq` and loads it in TunerStudio.
- The saved file is the original `.msq` with only the edited numbers rewritten, using the file's own digits.
  Everything else is byte-for-byte identical. The server re-parses the result and refuses the save if any
  other value would change (`app/edit.py`).
- Option settings (quoted choices like `"Speed Density"`) can't be edited, because a `.msq` doesn't record
  which choices are valid; that lives in the firmware's ini. A `.msq` has no min/max limits either, so
  TunerStudio's own limits apply when the file is loaded.
- Saving counts toward the upload rate limit.

### The Dash follows your edits

Pending edits update everything derived from them straight away: other places the same setting appears,
the gauge cluster readouts, the limit dials, table Min/Max/Mean, axis headers (with their boost readings
and the boost line), and the **Checks** panel.

- The rev-limit dial's needle is the rev limit (`hardRevLim`, `rpmHardLimit`, …). Its scale and zones come
  from the tune's TunerStudio gauge settings when present: `rpmhigh` is the tach maximum, `rpmwarn` starts the
  yellow zone and `rpmdang` the red. A boost-cut dial uses `maphigh`/`mapwarn`/`mapdang`. These are gauge
  settings, not engine limits, and the settings list says so.

### Tune Health

The Dash's **Tune Health** panel (`app/checks.py`) checks the tune whenever it loads and again on every edit, and
gives a verdict: **Not ready to start**, **No blocking problems, but N things look off**, or **No problems found**.

- **Fix** (don't start the engine): required fuel of 0, a rev limit that is unset or a placeholder, a main
  table that was never set up, axis bins out of order, backwards MAP sensor calibration, rusEFI injector flow,
  displacement or cylinder count of 0.
- **Check** (looks off): unusual required fuel or injector open time, stoich outside 6–16, VE cells at 0 or
  above 200%, sharp VE or ignition spikes, advance outside −20° to 55° or above 35° in boost, AFR/λ targets
  outside λ 0.65–1.20, lean full-load (λ > 0.95) or boost (λ > 0.86) targets, soft/launch limits out of order,
  RPM bins short of the rev limit, load bins or boost cut past the MAP sensor's range, boost control on with
  an unset table.
- **Note** (worth knowing): a boost-capable MAP sensor with tables that stop at atmospheric, boost rows with
  boost cut off, TunerStudio gauge settings that don't cover the rev limit, and other tables still holding
  placeholder values.

Rules are data, so the same rule runs on the server and in the browser (`evaluateCheck` in `edit.js`). They
catch common setup mistakes and can't prove a tune is safe.

## Adding a new firmware

The app has no firmware-specific code for table layouts. Everything comes from `tablemaps/*.json`, so
adding a firmware means adding one JSON file.

### Generate a map from the TunerStudio ini (recommended)

```bash
.venv/bin/python tools/ini_to_tablemap.py path/to/firmware.ini --family FOME -o tablemaps/FOME.json
```

- Reads `[TableEditor]` for each table's z constant, x/y bins, title and axis labels; `[Constants]` for units
  and digits; `[CurveEditor]` for 1D curves; and the ini's `signature`.
- Features the main VE, ignition and target AFR/lambda tables on the Dash. Every other table is written with
  `"featured": false`; it still shows up, labelled, under **Tables** and in its category menu.
- `#if NAME` blocks take their first branch by default. Use `--else LAMBDA` (repeatable) to take the `#else`
  branch instead.
- `--no-signature` leaves out the ini's exact signature, for a map meant to cover a whole family.

Commit the JSON and you're done. `tablemaps/FOME.json` and `tablemaps/rusEFI.json` were generated from a FOME
VTHPNP ini (`rusEFI.json` with `--family rusEFI --no-signature`, since the two share table names). If you
have a rusEFI or MS3 ini, run the generator on it and commit the result. `MS1/MS2/MS3/Speeduino.json` are
hand-written for now.

### Map format

```json
{
  "family": "MS3",
  "name": "MegaSquirt-III",
  "signatures": ["MS3 Format 0435.14P"],
  "signature_patterns": ["^MS3"],
  "tables": [
    {"id": "ve", "label": "VE Table 1", "z": ["veTable1"], "x": ["frpm_table1", "rpmBins"],
     "y": ["fmap_table1"], "x_label": "RPM", "y_label": "kPa", "units": "%", "palette": "ve"},
    {"id": "vvt", "label": "Intake VVT", "z": "vvtTable1", "featured": false}
  ],
  "curves": [{"id": "wue", "label": "Warmup", "x": "wueBins", "y": "warmup", "x_label": "°C", "y_label": "%"}],
  "summary_fields": [{"name": ["reqFuel"], "label": "Req fuel"}, "nCylinders"],
  "constant_meta": {"veTable1": {"units": "%", "digits": 1}}
}
```

- Any constant reference (`z`, `x`, `y`, a summary `name`) can be a string or a list of candidates. The first
  one present in the tune wins.
- `palette`: `ve`, `spark` and `default` use a TunerStudio-style blue→green→yellow→red ramp (low→high); `afr` runs
  it the other way, so rich is red and lean is blue. The palette also sets the legend words (low/high,
  retard/advance, rich/lean).
- Axis names and units (`app/axes.py`): the `x_label`/`y_label` plus the bins' units give names like
  **Load (kPa)**. Generic, blank or unit-only labels are tidied: `"L"` and a units slot of `"Load"` become
  Load, `"%"` moves to the units, and a blank label is named from the bins (`fuelTrimLoadBins` → Load).
- What load measures: for `ve`, `ve2` and `spark` tables the viewer reads the tune's algorithm setting
  (`algorithm`/`fuelAlgorithm`, `algorithm2`, `IgnAlgorithm`/`ignAlgorithm`) and shows e.g. **Load is MAP
  (kPa) · algorithm = “Speed Density”**. Speed Density/MAP → MAP, Alpha-N/TPS → TPS, Percent Baro, IMAP/EMAP,
  MAF and ITB are recognised; anything else is shown as the tune spells it. Set `"load_from": ["settingName"]`
  on any table to name the setting that decides its load. Values are never converted.
- Boost and vacuum: on a MAP load axis in kPa (absolute pressure), each load bin shows what a boost gauge
  reads at sea level (hover the bin, or tap a cell): 150 kPa ≈ 7.1 psi boost, 80 kPa ≈ 6.3 inHg vacuum, using
  psi = (kPa − 101.3) × 0.145. An orange line marks where boost starts. A table whose bins stop at about
  atmospheric says it has no boost rows, which is normal for a naturally aspirated engine.
- Tables with no map entry get axis bins matched by name when it's unambiguous (`sparkMap` with
  `sparkMapRpmBins` and `sparkMapLoadBins`), and the page says the axes were matched by name.
- Tables with `afr` palette or lambda/AFR units get the **λ / AFR toggle**. Lambda is shown by default when
  the table is stored as lambda (units say lambda, or values fall in 0.6–1.3), and AFR is computed from a
  selectable stoich (14.7 gasoline, 9.76 E85, …). The page always says which one it is showing.

Resolution order for an uploaded tune:

1. A map whose `signatures` contains the exact signature string.
2. A map whose `family` equals the detected family (a case-insensitive substring match on
   rusefi / fome / speeduino / ms3 / ms2 / ms1).
3. A map whose `signature_patterns` regex matches. This is how a brand-new firmware gets matched with no code
   change.
4. The generic fallback: every 2D table rendered with its raw name and index axes.

Constants the map doesn't mention are never dropped. Every 2D constant is listed under **Tables** and in a
category menu, and every constant is listed under **Settings**.

### Categories

`app/nav.py` sorts every table, curve and setting into a TunerStudio-style category from its name and its
label in the tablemap: Engine, Fuel, AFR/Lambda, Ignition, Cranking & Warmup, Accel Enrichment, Idle,
Boost, Cam/VVT, Knock & Protection, Sensors, I/O, Logging, Scripting, and Other for anything unmatched.
Matching is an ordered keyword scan (the first category that matches wins, so `idleVeTable` is Idle rather
than Fuel), and nothing is ever dropped. Categories drive the toolbar menus and the Tables, Curves and
Settings filters. To move something, add a keyword to `CATEGORIES`; to change the order, edit
`CATEGORY_ORDER`.

## Prep a tune for boost

**Prep for boost** on the Dash (`/t/{slug}/boost`, `app/boost.py`) takes a naturally aspirated basemap, or a
tune already running boost, and writes a conservative starting point: load bins that reach into boost, fuel
and timing for those rows, a boost target, and failsafes. It asks a few questions (wastegate spring, fuel,
internals, intercooler, fuel pump, injectors, engine power, wideband), then says how much boost it will allow
and **why**, before writing anything. The original tune is never changed: creating gives a new tune with its
own link, delete key and diff, like any other edit.

### How much boost it allows

The target is the smallest of: the engine and fuel ceiling (stock or built internals × pump 91 / 93 / E30 /
E85 / race), no intercooler, a stock or unknown fuel pump, what the injectors can fuel (injector size ×
cylinders at 80% duty against engine power, assuming power rises with pressure ratio, and E85 needing ~40%
more fuel), what the MAP sensor can read, and how far boost may rise in one step. Every limit is listed with
what it allows and why, and the binding one is highlighted. Asking for more than it allows caps the target
and says so; it never silently obeys.

- **Stage 1** is the wastegate spring alone: boost targets at spring pressure, open-loop duty 0% and, where
  the tune has it, max duty 0%, so the solenoid can't add boost. Extra timing out and extra fuel for the
  first drive.
- **Stage 2** is 3 psi over the spring, and **Custom** is anything up to the limits. Both need the previous
  stage logged first, and neither can go more than 4 psi above what the tune already runs.

### What it writes, and what it refuses

Fuel, timing and targets in boost are built from the tune's own full-throttle (atmospheric) row, so they
follow the engine that's already tuned:

- **Load bins** are rescaled to reach the boost cut, keeping the tune's vacuum resolution, and every table
  sharing those bins is resampled with them.
- **VE** in boost starts just above the full-throttle row and never drops below it. **Timing** comes out per
  psi (1.5°/psi on 91 down to 0.7°/psi on E85, more without an intercooler) and never exceeds the fuel's
  ceiling. **AFR/λ targets** reach the fuel's boost target by 3 psi and never get leaner than the tune is now.
- **Boost cut** goes a few psi above the target and inside what the MAP sensor can read, and the MAP gauge
  zones follow it. Hidden duty and target adders (rusEFI blend tables, gear-based duty adders) are zeroed.
- The rev limit is never touched.

Then `verify` re-reads the written file and refuses it unless every one of those rules holds and Tune Health
still finds nothing to fix. A plan that fails its own check is never saved.

It can't switch an option — a `.msq` doesn't record which choices a setting allows — so turning on boost
control, boost cut or engine protection becomes a **required checklist for TunerStudio**, listed with the
plan along with a first-drive logging procedure. Anything it can't confirm from the tune (a table whose units
don't say whether it holds duty or a pressure, a by-gear mode it doesn't recognise) is reported and left
alone rather than guessed at.

It refuses outright when there's no wideband, when fuel or ignition load isn't MAP (speed density), when the
MAP sensor can't read boost, when Tune Health has anything to fix, or when the wastegate spring alone makes
more than the limits allow.

### Boost by gear and by speed

Enter boost per gear, or per speed breakpoint, and each point is capped by the same limits. It writes
Speeduino's `boostByGear` settings when their mode and units say what they mean, or a rusEFI/FOME closed-loop
blend table when the tune says that blend is by gear or vehicle speed (speeds convert to km/h). Where the
blend is used, the base target is the **lowest** scheduled boost and the schedule adds to it, so a lost gear
or speed signal falls back to the least boost, not the most. When the tune has no mechanism it can write
safely, the whole target becomes the lowest point you asked for, and the plan says what to turn on.

**None of this makes a tune safe.** It's a conservative starting point for logging with a wideband.

## Read a datalog

**Read a log** on the Dash (`/t/{slug}/log`, `app/logs.py`) takes a datalog you recorded with that tune and
says what it shows. Text logs (`.msl`, `.csv`, `.tsv`) are read most reliably; binary `.mlg` logs are read to
the documented MLVLG layout, and anything that doesn't add up is refused with a message telling you to export
text from TunerStudio rather than being guessed at. Channel names differ between firmware, so channels are
matched by pattern (`AFR`, `AFR1`, `Lambda`, `O2`, `Engine Speed`…) and the report always lists which channel
it used for what, and which checks couldn't run because a channel wasn't logged. MAP in psi or bar and
temperatures in °F are converted, and the report says so.

The log is checked **against the tune it came from** — its boost cut, MAP sensor range, rev limit, AFR target
table and spark table:

- **Fix**: lean in boost against target, knock, boost hitting the cut, MAP pegged at the sensor's ceiling,
  boost overshooting its target, injectors past 90% duty, coolant or EGT past a damaging temperature, fuel
  pressure falling away in boost.
- **Check**: lean at full throttle, very rich in boost, boost falling short of target, injectors past 85%,
  full throttle before the engine is warm, low battery voltage, closed-loop fuel working hard, more timing in
  boost than the spark table asks for.
- **Good** and **Note**: what matched target, peak boost, and the rest.

It also picks out every full-throttle pull (when, how long, RPM range, peak boost, leanest λ, peak advance,
whether it knocked or went lean) and charts RPM, MAP, mixture against target, timing, knock and boost duty.

### What to change, from the log

Where the log is good enough to tell, the report suggests edits and you apply them with one button, as a new
tune with its own link and a diff (the original is never touched):

- **VE cells from the wideband.** Settled samples only: warm engine, throttle and RPM not moving fast, no
  accel enrichment, injectors not maxed out, and the mixture matched to the RPM and load from ~0.35 s earlier,
  since the sensor reads exhaust that has already left the engine. A cell needs 8 samples (12 in boost) before
  it is touched, moves at most 15% in one pass, and may only be leaned out by 5% in boost.
- **Timing where it knocked**, at least 2° out of each cell the ECU reported knock in, never more than 6°,
  and only ever downward.

Applying re-reads the written file: every cell must be inside the clamp the report promised, nothing else may
have changed, and Tune Health must still find nothing to fix, or the edit is refused.

Logs are stored like tunes — **anyone with the link can see them**, they have their own delete key, they go
when the tune goes, and they're purged after 180 days without a view.

## Abuse controls

- Uploads over 16 MB are refused based on `Content-Length`, before the body is read. Streamed bodies are cut
  off at the limit too.
- Rate limit: 20 successful uploads per IP per hour, stored in SQLite (hashed IPs, no Redis).
- XML parsing forbids DTDs and entities (no XXE, no billion-laughs). Constant count (5000) and total values
  are capped.
- Stored files are named from the random slug only, never from user input.
- Tunes not viewed in 180 days are purged at startup and then daily.
- User-facing errors never include paths, versions or tracebacks. `/docs` and `/openapi.json` are disabled.
- Tune and diff pages send `X-Robots-Tag: noindex`.
