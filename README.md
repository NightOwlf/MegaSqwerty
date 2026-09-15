# MSQ Viewer

An online viewer for TunerStudio `.msq` tune files: MegaSquirt (MS1/MS2/MS3), Speeduino, rusEFI and FOME
(including vendor boards such as the Vato Tuned VTHPNP). Upload a tune from your phone and you get a
shareable link. It can also diff two tunes cell by cell.

The viewer is laid out to be familiar to a TunerStudio user: a menu bar of tuning categories (Fuel,
Ignition, Idle, Boost, Cam/VVT, Sensors…), a project tree down the left, panels that read like
TunerStudio's dialogs, a status bar along the bottom, and tables in TunerStudio's blue→red scale with
load ascending up the left and RPM across the bottom.

- **Everything is filed under the menu you'd expect.** Tables, curves and settings are sorted into
  categories by name, so a tune with 84 tables and 1200 settings is still one click deep. See
  `app/nav.py`.
- **One search box for the whole tune.** It filters the tree and lists matching settings with their
  values; click a result to jump to it.
- **Tap a cell** for its RPM, load and value — as a bubble, in the table's readout, and with the axis
  headers highlighted.
- **λ / AFR toggle** on target-mixture tables, with a selectable stoichiometric ratio.
- Collapse individual tables or all of them at once, and switch to compact cells for dense tables.

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
   uploaded files (`/data/tunes/<slug>.msq`) live there. Without a volume, every redeploy wipes all tunes
   (the app logs a warning at boot).
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
| `GET /compare`, `POST /compare` | Pick two tunes, or paste A and upload B |
| `GET /d/{a}/{b}` | Cell-by-cell diff, plus a list of settings that differ |
| `GET /healthz` | Healthcheck |

## Adding a new firmware

The app has no firmware-specific code for table layouts. Everything comes from `tablemaps/*.json`, so
adding a firmware means adding one JSON file.

### Generate a map from the TunerStudio ini (recommended)

```bash
.venv/bin/python tools/ini_to_tablemap.py path/to/firmware.ini --family FOME -o tablemaps/FOME.json
```

- Reads `[TableEditor]` for each table's z constant, x/y bins, title and axis labels; `[Constants]` for units
  and digits; `[CurveEditor]` for 1D curves; and the ini's `signature`.
- Features the main VE, ignition and target AFR/lambda tables. Every other table is written with
  `"featured": false`; it still appears, labelled, under its category, but it is drawn lazily as you
  scroll to it rather than up front.
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
- `palette`: `ve`, `spark` and `default` all use TunerStudio's blue→red scale; `afr` is rich→lean.
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

Constants the map doesn't mention are never dropped. Every 2D constant is rendered, and every constant is
listed under some category.

### Categories

`app/nav.py` sorts every table, curve and setting into a TunerStudio-style category from its name and its
label in the tablemap — Engine, Fuel, AFR/Lambda, Ignition, Cranking & Warmup, Accel Enrichment, Idle,
Boost, Cam/VVT, Knock & Protection, Sensors, I/O, Logging, Scripting, and Other for anything unmatched.
Matching is an ordered keyword scan (the first category that matches wins, so `idleVeTable` is Idle rather
than Fuel), and nothing is ever dropped. To move something, add a keyword to `CATEGORIES`; to change the
order the categories appear in, edit `CATEGORY_ORDER`.

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
