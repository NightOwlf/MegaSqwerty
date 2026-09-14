from app import diff
from app.parser import parse_msq
from app.tablemaps import resolve_map


def _docs(fx, a, b):
    da, db = parse_msq(fx(a)), parse_msq(fx(b))
    return da, db, resolve_map(da)


def test_diff_with_mismatched_dimensions(fx):
    da, db, tmap = _docs(fx, "ms3_basic.msq", "ms3_resized.msq")
    tds = {t.name: t for t in diff.diff_tables(da, db, tmap)}
    ve = tds["veTable1"]
    assert ve.status == "dims"
    assert "16×16" in ve.message and "12×12" in ve.message
    assert diff.grid_for(ve) is None  # nothing to draw, and no exception
    assert tds["advanceTable1"].status == "same"
    # 1D bins with different lengths show up as a settings difference, not a crash.
    s = {x.name: x for x in diff.diff_settings(da, db)}
    assert s["frpm_table1"].detail == ["Different number of values."]


def test_diff_counts_changed_cells(fx):
    da, db, tmap = _docs(fx, "ms3_basic.msq", "ms3_modified.msq")
    tds = {t.name: t for t in diff.diff_tables(da, db, tmap)}
    ve = tds["veTable1"]
    assert ve.status == "changed" and ve.changed == 4 * 5 + 1 and ve.total == 256
    g = diff.grid_for(ve)
    classes = [c.cls for row in g.rows for c in row.cells]
    assert classes.count("up") == 20 and classes.count("down") == 1 and classes.count("same") == 235
    up = next(c for row in g.rows for c in row.cells if c.cls == "up")
    assert up.delta == "+4.0"
    settings = {s.name: s for s in diff.diff_settings(da, db)}
    assert (settings["reqFuel"].a, settings["reqFuel"].b) == ("12.3", "13.1")
    assert "nCylinders" not in settings


def test_diff_across_families_does_not_crash(fx):
    da, db, tmap = _docs(fx, "ms3_basic.msq", "fome_vthpnp.msq")
    tds = diff.diff_tables(da, db, tmap)
    statuses = {t.name: t.status for t in tds}
    assert statuses["veTable1"] == "only_a"
    assert statuses["vvtTable1"] == "only_b"
    assert diff.diff_settings(da, db)


def test_table_vs_scalar_same_name():
    da = parse_msq(b"<msq><page><constant name='x' rows='2' cols='2'>1 2 3 4</constant></page></msq>")
    db = parse_msq(b"<msq><page><constant name='x'>5</constant></page></msq>")
    (td,) = diff.diff_tables(da, db, resolve_map(da))
    assert td.status == "kind"
