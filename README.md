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
| `GET /logs`, `POST /logs` | Open a datalog on its own (optionally with a tune link), then 303 to the viewer |
| `GET /l/{log}` | The log viewer. `/download` gets the original file, `POST /delete` removes it with its key |
| `GET /l/{log}/index.json` | Channels (name, units, range), which channel plays which role, and the tune's tables |
| `GET /l/{log}/ch/{n}` | One channel as little-endian float32 (`t` for the time of each record) |
| `GET /compare`, `POST /compare` | Pick two tunes, or paste A and upload B |
| `GET /d/{a}/{b}` | Cell-by-cell diff, plus a list of settings that differ |
| `GET /healthz` | Healthcheck |

## Editing a tune and sending it back

Anyone with a tune's link can edit it and send a new link back. Press **Edit tune** (or **Edit** on a table,
curve or setting page):

- **Tables** work like TunerStudio's table editor. Select cells by clicking, dragging or shift-clicking (on
  a phone, tap a cell, or tap **Range** and then the far corner). Then type a value and **Set**, **Add**,
  **± %** (by the value typed, e.g. -7.5), **−N% / +N%** (type a whole-number percent in the box between
  them, e.g. 5, and each press takes 5% off or adds 5%), step **▲ / ▼**, **Interpolate** across the
  selection, **Smooth**, or **Undo**. Keyboard: arrows move, Shift+arrows extend, typing a number starts a
  value, Enter sets, + / − step, [ / ] take off / add the percent step, I interpolates, S smooths,
  Ctrl/Cmd+Z undoes. The percent step is remembered and shared with the log viewer's tables.
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
  an unset table, a boost control duty table still at the firmware's default (duty following the throttle, so
  full throttle holds the wastegate shut), a closed-loop boost target left below atmospheric.
- **Note** (worth knowing): a boost-capable MAP sensor with tables that stop at atmospheric, boost rows with
  boost cut off, a default boost duty table while boost control is off, TunerStudio gauge settings that don't
  cover the rev limit, and other tables still holding placeholder values.

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
says what it shows. Text logs (`.msl`, `.csv`, `.tsv`) and binary `.mlg` logs (MLVLG format 1 and 2, read to
EFI Analytics' published layout in `app/logfile.py`) both work, up to `LOG_MAX_MB` (200 MB by default) each; an
`.mlg` that doesn't add up is refused with a message telling you to export text from TunerStudio rather than
being guessed at. Channel names differ between firmware, so channels are
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

## The log viewer

**Open log** (`/logs`, or drop a log on the home page's box) takes up to six datalogs at once, on their own or
with a tune link, and opens the first at `/l/{log}`: a link you can send to someone so they can go through the
drive. Every log read against a tune opens there too. **Add tune / Change tune** reads the log with any tune
(upload a .msq right there, or paste a link); the choice is in the link as `?tune=`, so it's shared too.
It works the way a desktop log viewer does (`app/static/viewer.js`, plain canvas, no libraries):

- **Stacked graphs**, one to four, each with up to four channels. Channels in the same units share a scale (AFR
  with target AFR, MAP with boost target); others get their own. Down the left edge, each channel's value at
  the cursor (it moves as you scrub or play) with the highest ▲ and lowest ▼ it reached, on screen or across
  the whole log. Tap a channel name to swap it: the channels that matter for tuning are listed first by plain
  name, then every channel in the log.
- **Layouts**: one tap sets up every graph for *Tuning overview*, *Fuel / VE*, *AFR & correction*, *Boost*,
  *Ignition & knock* or *Warm-up & idle*, skipping channels that never change in this log.
- **AFR correction**: the closed-loop trim the ECU logged, plus *AFR correction needed*, worked out from the
  wideband and target: the % more (+) or less (−) fuel it would take to hit target, even with closed loop off.
- **⚙ Display options**: highs and lows on screen or in the whole log, the graph scale fixed to the log or
  fitted to the screen, line and text size, values beside the cursor, and a marker at each channel's peak.
- **A cursor**: click or drag on a graph; arrow keys step one record (Shift for ten). On a phone, drag sideways
  on a graph to scrub and up or down to scroll the page.
- **Zoom and pan**: scroll wheel or pinch zooms around the pointer, Shift + wheel pans, and the strip under
  the graphs shows the whole log with the visible window to drag. `F` fits the whole log.
- **Playback** at 0.25× to 8× real time, with the view paging along (Space to play and pause).
- **The tune's tables** (when the log has a tune): VE, ignition and the rest, with the cell the engine was in
  highlighted, a dot at the exact interpolated position and the interpolated value, moving with the cursor.
  **3D** shows any of them as a surface (drag to turn, pinch or wheel to zoom, tap a point to select a cell),
  with the cursor riding on it and VE Analyze's changes animating live.
- **Phones and folding phones**: on a phone the graph stays pinned at the top while the tables scroll up under
  it. Held wide (an iPhone Duo open, a small tablet) the graphs take one half and the tables the other, so the
  fold runs between them; browsers that report the fold get the split exactly on it.
- **Scatter plot**: any channel against any other, coloured by a third, for the zoomed range or the whole log.
- **Copy link** puts the channels, zoom and cursor position in the link, so whoever opens it sees the same
  moment. Your channel layout is remembered for the next log you open.
- **Mixture as AFR**: AFR channels are shown in preference to lambda, and the report gives AFR too.
- **Markers** recorded in an `.mlg` show as red lines.
- **Edit the tables**: drag (or tap, then *Range*) across cells, then type a value and Enter, or use −/+,
  −N% / +N% (the whole-number percent in the box between them, or [ / ] on the keyboard), *Interp* (fill between the selection's corners), *Smooth* and *Revert* (back to the original tune).

### Editing together, live

A link to an edited tune is a shared workspace: **everyone who has it edits the same tune**. Every page open on
it checks for changes every 3 seconds and pulls them in without a refresh (changed cells flash, a notice says
what moved), and edits are saved cell by cell so two people changing different cells never undo each other.
An uploaded original is never changed: the first edit (or *Share*) makes the shared copy, and the link moves
to it once. **Share → Make my own copy** makes a separate version with its own link, to try something without
touching the shared one. Each tune has **Notes** everyone on the link can write and sees update live; copies
carry them. Auto-save is on whenever a page opens, and edits not yet saved when a page closes are kept in the
browser and saved on the next visit. Tunes, logs and notes live on the Railway volume at `/data`, so links
keep working through every update.

Routes: `GET /t/{slug}/rev` (what pages poll), `POST /t/{slug}/notes`, `POST /t/{slug}/save` (in place on an
edited copy; `{"fork": true}` for a separate copy), and the token-only `/admin/restore/{tune,log}` that put
links back under their old slugs when storage moved to the volume.

### Watching a log together

A log link is shared viewing by default (**● Live view**): when anyone on it plays, pauses, scrubs or zooms,
everyone else on the link follows, through a small relay per log (`/l/{log}/together`). **Private** goes
through the log alone. The connection is only open while someone is using the page (it closes after 10
idle minutes or when the page is hidden), so open tabs left alone don't keep the server awake.

**Shape** (with a table in 3D) edits the map by dragging: drag a point up or down; its neighbours follow
by a little for a smooth change, or tap cells first to move a selection together (slopes, regions).

### Live tuning (`/live`)

Tune a running car from anywhere: someone at the car connects the ECU to a page, and a tuner opens a link on
a phone or computer to watch it run and change the tables, sent to the ECU in moments.

**The live page is the log viewer, running live**: the same graphs (pick channels, stack 1–4, zoom, pan, the
cursor with every value and ▲▼ highs and lows), the same editable tables beside them with 3D and Shape, VE
Analyze, Scatter, Simulate and the Dyno, all on the car's data as it streams in (about 20 records a second;
a tuner who joins late gets the session so far). While the view is at the newest data it follows the car
(● Live); scroll back or tap a moment and it stays there. Editing a cell works exactly as in the log viewer, and
the change goes to the car, which writes it to the ECU (or asks the driver); the bar says when the ECU has it
and whether it's burned. Above the viewer: the RPM, MAP and AFR gauges (target AFR as the amber needle) and a
readout row with TPS. Tabs add **Gauges** (the project's front-page gauges and lamps) and **Settings**.

The screen works like TunerStudio's: **Tuning** (RPM, MAP and AFR gauges, the target AFR as a second amber needle
and number on the AFR gauge, a readout row with TPS, VE, EGO, timing and temperatures, the table with the
operating point and its trail, and the graph), **Gauge Cluster** (the project's own front-page gauges with its
ranges and warning zones, and its indicator lamps) and **Settings**.

- **The ECU's tune is the one shown**: the tables are read from the ECU when it connects, not from the file. If
  the project's tune (or a .msq you open with *Load a tune file into the ECU*) is different, a difference report
  lists what differs and lets the driver keep the ECU's or write the file's in (then Burn). Tables, curves and
  the settings this page handles are written; wiring, sensor and protection settings stay as the ECU has them.
  The session's tune copy follows what the ECU really holds.
- **Key on, engine off** shows MAP, temperatures, battery and 0 RPM like TunerStudio. *Calibrate TPS* (FOME /
  rusEFI) grabs the sensor voltage at closed and wide-open throttle into tpsMin/tpsMax, then Burn.
- **The session is recorded** as a log by itself (about 20 records a second, saved every minute and whenever the
  page is hidden) against the session's tune copy, including the cut codes and warning codes. A reload of the car
  page carries on the same log on the same clock; the log grows in place and is never deleted while it's saved,
  so a server restart can't lose it. *⬇ Download log* gets the whole session as one .msl.
- **Before is what the ECU had**: when the ECU's tune differs from the project's file, the session keeps what the ECU
  had at the start as its own tune and counts every change from it (Compare's *Before*). The file stays in History.
- **Burns are checked**: after every burn the car reads the whole page back from the ECU and confirms it holds every
  value (History labels the burn "read back: OK"); if anything differs it says so.
- **Most any cell may move this session** (car setting, 15 / 30 / 50%, timing +5 / +8 / +12°): measured from what
  the ECU had at the start, so a table can't drift far in many small steps. *↺ Back to how the ECU started* writes
  every table back.
- **Keep every change** (on by default at the car): the ECU burns by itself 10 seconds after changes stop, so
  nothing is lost when the key goes off. If the ECU restarts and loses unburned changes, the car page puts them back.
- **VE Analyze Live**: in the VE Analyze tab, *● Run live* corrects the VE table in the ECU every 15 seconds from
  the cells you've just driven through (same engine, filters, locks and max change as VE Analyze).
- **Updates**: a tuner's page reloads by itself onto a new version once nothing it sent is still on its way; the
  car's page says an update is ready (reload when parked).
- **A tuner who joins late sees the whole session**: the graph starts where the session did. Drag the graph to
  scroll back, pinch / wheel / − + to zoom, tap a moment to see the gauges, readouts and table dot as they were;
  *Live ▶* follows the car again.
- **Every change is listed**: tap one for each cell (RPM and load), what it was and what it is now, and *Show in
  the table*.
- **Rev limiter** can be changed remotely, approved by the driver, 500 RPM at a time, never below 1500.
- The page remembers the project folder, so next time it's one button.

- **At the car**, in Chrome or Edge on the laptop (Web Serial: no install): close TunerStudio (only one
  program can use the ECU's USB port), choose the TunerStudio project folder, and *Connect the ECU*. The
  project's own ECU definition (`projectCfg/mainController.ini`) says how to talk to it and where everything
  is, so it works with any ECU TunerStudio drives over the framed protocol (`msEnvelope_1.0`: FOME, rusEFI,
  MS3, Speeduino). The page checks the ECU's signature against the `.ini`, reads the whole tune from the ECU,
  streams live data, and gives a link to send the tuner. *Try a simulated ECU* runs everything against a
  pretend ECU and engine (same bytes, same commands) to try it without a car.
- **The tuner** gets live gauges (AFR shown as AFR), a 30-second live graph, and any table with the cell the
  engine is in outlined as it runs. Select cells, change them, and they go to the car.
- **As live as the link allows**: the car page reads the ECU as fast as it answers (up to ~60 times a
  second, like TunerStudio) and sends tuners a compact frame ~30 times a second, which the server passes on
  untouched; the tuner's screen redraws every frame and shows updates per second and the round trip
  (*Live · 30/s · 85 ms*). **＋ Gauge** adds any of the ECU's live channels, and the car streams it. Keep
  the car page open; it keeps the laptop's screen awake while the ECU is connected.
- **What the tuner can change**: every table and curve (target AFR, VE, ignition, boost, warm-up, cranking…)
  and about 300 settings (searchable by their TunerStudio names; the driver approves every settings change).
  Never remotely: what the ECU marks `requiresPowerCycle`, or what sets how the engine is wired, timed,
  measured or protected (pins, trigger, cylinders, injector flow and dead time, sensors, dwell, rev and boost
  limits, knock). The rules are `ECU.checkChange` in `ecu.js`, tested in `tests/js/ecu.test.js`.
- **Target AFR guard rails**: 10.0 to 18.0, at most 1.0 AFR per step, never leaner than 15.0 above 100 kPa.
- **On the road**: a phone hotspot works like any internet; dropouts reconnect every 2 s with the ECU kept
  connected; if the USB link drops while cranking, the page opens the ECU again by itself and re-reads the
  tune (telling the tuner if unburned changes were lost); a server restart is recovered by both pages.
- **Safety, decided at the car**: remote changes *Off*, *Ask me before each change* (the default: the
  driver taps Allow or Reject, refused after 30 s) or *Allow*. The car page is the only thing that writes to
  the ECU, and checks every change first: only the tables' values, inside the ECU's range, at most 25% per
  step on VE and +5° of timing per step. Changes go to the ECU's working memory and are read back; nothing is
  permanent until someone **burns** (the tuner only if the driver allows it), and switching the car off
  drops anything not burned. *Undo last change* puts the previous values back.
- Each session keeps a **shared tune copy**, updated as changes land and backed up when burned, so the tune
  page's History, Compare and .msq download cover the live session.

The server only relays (`app/live.py`, one WebSocket per page; sessions in memory, and the car page restarts
a session under the same link if the server restarts). The ECU side is `app/static/ecu.js` (framing, CRC32,
the `.ini`'s command templates, value scaling, the simulator), the page `app/static/live.js`, and the `.ini`
reader `app/ecuini.py`. Tested end to end against the simulator with the FOME `.ini` it was built from; it
hasn't yet been run against a real ECU, so start with the car parked.

### Backups and undo

A shared tune keeps backups for as long as it exists: one before VE Analyze is applied, one before every
restore, and one every 10 minutes while it's being edited (named ones are kept forever, automatic ones up to
400). **History** lists them with *Restore* and *Download*, plus *Back up now* and *the original* it was made
from. Restoring changes the tune for everyone on the link and backs up what was there first, so nothing is
lost. VE Analyze never changes a tune by itself: a run ends in a **suggestion** (shown in the table and in
Compare) with **Apply to tune**, which backs the tune up first, or **Discard**; after applying, **Undo VE
Analyze** puts it back in one tap. Its default limit is 15% per cell per run, so a bad stretch of log can't
wreck a cell, and running again moves it further if the data agrees.

### What changed: before and after

Whenever a table differs from the tune it came from (after VE Analyze, after editing, or when you open
someone's edited link), **Compare** in the save bar (or the *What changed* section of the VE Analyze tab)
shows it side by side: **Before**, **After** and **Change %** (red for more fuel, blue for less), as tables or as
three 3D surfaces on one height scale that turn together, with the changed cells dotted. Under them, every
changed cell, biggest first, with its RPM, load, before, after, change and (after a run) how many seconds of
the log it was built from; tap one to find it in all three. On a phone it shows one at a time.

### Diagnose: the log doctor

The **Diagnose** tab reads every record of a log (or, in live tuning, everything the session has saved) and lists
what needs a look, worst first: lean or rich under load, off target while cruising, lean on throttle tip-in, the
wideband not ready or pinned, closed-loop trim working hard, knock, fuel and spark cuts with their reasons, warning
codes, RPM dropouts and trigger errors, MAP / TPS / temperature sensor glitches, running hot, hot intake air, low or
high voltage, injectors near their limit, fuel pressure drops, boost over target, unsteady idle and gaps in the
log. Each finding says what happened, what to check, and lists every time it happened with RPM, MAP, TPS and AFR
against target; tap one to go there. They're also marked on the graphs.

For tools (and for an assistant helping you): `GET /l/<log>/diagnose.json`, `GET /l/<log>/data.json?ch=rpm,map,lambda&s=from-to&every=N`
(no `ch`: the channels and roles), `GET /live/<session>/diagnose.json?k=…` and `GET /live/<session>/status.json?k=…`
(state, live values now, recent changes, the session's logs). `tools/msq.py` wraps them for a terminal:
`diagnose`, `channels`, `slice`, `around`, `live` and `tune`, given the links the app shows. They only read.

### Cuts and warnings in a log

If fuel or spark was cut while the engine was running, the log viewer marks each one on the graphs (a red band
labelled with the reason) and lists them under the transport bar: when, how long, at what RPM, and why, using
FOME/rusEFI's cut codes (RPM limit, boost cut, launch control, lambda protection, flood clear…). Warning codes
("Warning: last") are listed too, as OBD-II P-codes with their meaning where they are standard ones. At a
standstill FOME always reports "engine sync", which is normal and isn't listed. Logs without the cut codes still
show where fuel stopped while the engine ran, with the likely reason (closed throttle: deceleration fuel cut). In
live tuning, the indicator lamps name the reason ("Fuel cut: RPM limit") and the Gauges tab shows the warning
codes the ECU holds.

### Trimming a log

Mark sections with **✂ Section** (drag across a graph, Start/End, or + On screen), then **Keep only these** for a
new log with just those stretches (the start and end trimmed off), or **Cut these out** for a new log without them.
The new log opens with the same tune; the original is never changed.

### Downloading a log, or just part of it

**Download** offers the log as uploaded, **just the ✂ sections** (mark them with ✂ Section to trim the start and
end), or **what's on screen**, as a .msl that TunerStudio and MegaLogViewer open. In live tuning it's the
session's recording, every part as one file (the car saves first, so it's up to the second); *⬇ Download log*
is also next to REC at the top.

### Dyno: horsepower and torque from a log

The **Dyno** tab (never opens by itself) finds the full-throttle pulls in a log (throttle above the line you set,
RPM climbing in one gear for 1.5 s and 1,500 RPM), picks the cleanest and longest, and draws wheel or crank
horsepower and torque against RPM with the peaks marked, plus AFR, MAP and timing along the pull. Pick another
pull or overlay one to compare. It asks for what it needs: weight with driver and fuel, drivetrain (loss), and
the gearing and tire only if the log has no working speed sensor (with one, the speed per RPM is read off the
pull). Air density from outside temperature and elevation (or the log's baro), drag (Cd, frontal area), rolling
resistance and SAE J1349 correction are under *Air, drag and rolling*. Power = (mass × acceleration + rolling
resistance + drag) × speed; acceleration is the slope of a short moving fit of RPM-based speed, so noise doesn't
become spikes. Checked against a synthetic pull with a known curve: within 1%.

### Downloading the tune

**Download** in the log viewer offers the **tune (.msq)** with every change you made (saved first, so the file
has your values) to load in TunerStudio, or the original log file.

### Simulate: this drive with the new VE table

The **Simulate** tab (it never opens by itself) replays the log with the VE table as it is now: your edits, 3D
drags, or a VE Analyze suggestion (its strip has a *See it simulated* button). The top graph is the recorded AFR
and target, the one under it the simulated AFR and target, on the same timeline, with a summary of how far each
is from target on average and how often it's within ±0.5 AFR (only in your sections, if you marked any). Fuel
follows VE, so each record's simulated AFR = recorded AFR × VE that ran ÷ VE now. It updates as you edit. It
doesn't model closed-loop trim reacting or wideband delay: a guide, not a replacement for logging again.

### Remote tuning: edits travel with the link

Nobody has to download or upload a file to send changes back and forth. With **Auto-save** on (the default),
each edit is saved a moment later into an *edited copy* of the tune (a new .msq in which only those numbers
change, byte for byte) and the page's link switches to it (`?tune=`). **Share** gives that link (or the
phone's share sheet), the .msq to download, and on phones the .msq file itself to send to Discord or
Messages. Whoever opens the link sees the log read with the edited tune, the changed cells marked in orange
with what they were. Saving again from the same browser updates that copy in place, so the link already sent
shows the latest (the browser keeps the copy's key). Anyone else who edits it gets their own copy and their
own link to send back, so nobody overwrites anybody, and an uploaded tune is never changed.
`POST /t/{slug}/save` takes `{"changes": {...}, "key": "..."}`; with the key of an edited copy it updates it.
The .msq download is `application/octet-stream`, so phones keep the `.msq` name.

### VE Analyze

The **VE Analyze** tab plays through the log (and any logs uploaded with it) and works out what every VE cell
should be from the wideband, with the cells changing on screen as it goes, then solves the table and puts the
result in the editor to adjust and save. It's in `app/static/veal.js`, with its tests in `tests/js` (run by
`tests/test_veal.py` under node). How it works:

- **From the VE that actually ran.** The VE each record needed is *VE used × measured λ ÷ target λ × closed-loop
  trim*. When the log has the ECU's VE (`Fuel: VE`, `VEcurr`…) that's what it starts from, so VE blends
  and a tune that isn't the one attached don't throw it off. It rebuilds the table that was on the car from
  those readings, limits changes relative to *that*, and says so when the attached tune is a different one.
- **The wideband's delay is measured** from the log (lining up fuel changes with the opposite λ change),
  around 150–250 ms on a typical setup, and scaled for RPM.
- **Every sample counts where it belongs.** A sample between four cells is shared between them by the same
  bilinear weights the ECU interpolates with, and the final table is the least-squares fit to every sample
  through that interpolation, lightly smoothed between neighbouring cells that both have data. A cell moves in
  proportion to how much data it has, up to the most it may change in one pass (25% by default).
- **Only steady, warm, fuelled samples**: it leaves out a cold engine, throttle or MAP moving fast and the
  moments after, fuel cut and decel, a wideband at its rail or not ready, maxed injectors, idle when a separate
  idle VE table runs it, and readings too far off to be real. It shows how much of the log went each way.

- **Tune a section, not the whole log**, the way tuners cut a log into pulls: **✂ Section** then drag across
  any graph (or mark *Start* and *End* at the cursor, or add what's on screen). Sections are shaded on every
  graph, kept in the link, and VE Analyze then uses only those stretches of this log.
- **TunerStudio's controls and more**: RPM, load and throttle windows; any number of *skip when channel <, >,
  =, ≠ value* filters on any channel; **🔒 Lock** cells so they never move (their neighbours absorb the
  difference in the fit); **Strength** to apply 25–100% of the correction for a cautious pass; minimum coolant,
  transient limits, hold-off, max change, data needed for full authority, wideband delay and smoothing. The
  samples panel says how much of the log each rule left out.
- **See why**: *AFR error %* shows the average mixture error each cell saw before the fix, *Data (s)* how much
  data stood behind it, and *VE that ran* what the ECU actually used.

Every table beside the graphs can also show what the log did in each cell instead of its values (**Cells
show**): time spent there, the most knock retard (to find where to pull timing on boost), or the average AFR
error, over the whole log or just the chosen sections.

On the two FOME logs it was developed against, holding out alternate 30 s of each log and correcting from the
rest took the error between the VE needed and the table from 13.8% to 2.5% on one and 3.7% to 2.7% on the
other (the remainder is wideband noise).

A real log is big (an hour on rusEFI/FOME is over 100 MB, with 650 channels), so a log is stored as a
column store (`{log}.col`: an index, then one zlib-compressed float32 block per channel) beside the gzipped
original, and the viewer fetches only the channels it is drawing. A 92 MB `.mlg` becomes about 4 MB of
columns, and each channel is a request of a few kilobytes that is cached for good.

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
