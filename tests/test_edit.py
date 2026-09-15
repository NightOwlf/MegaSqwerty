"""Editing a tune: only the edited numbers change in the file, and saving makes a new tune."""
import re
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.db import Store
from app.edit import EditError, apply_changes, edit_digits
from app.main import create_app
from app.parser import parse_msq

JSON = {"accept": "application/json"}


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, uploads_per_hour=10)
    with TestClient(app, follow_redirects=False) as c:
        yield c


def upload(client, data):
    r = client.post("/upload", files={"file": ("tune.msq", data, "application/octet-stream")})
    return re.fullmatch(r"/t/([A-Za-z0-9]{10})", r.headers["location"]).group(1)


def test_only_the_edited_numbers_change(fx):
    raw = fx("ms3_basic.msq")
    new, n = apply_changes(raw, {"veTable1": {"0": 40.04, "17": 55}, "reqFuel": {"0": 11.26}, "nCylinders": {"0": 6}})
    assert n == 4
    before, after = parse_msq(raw), parse_msq(new)
    ve = after.get("veTable1").values
    assert ve[0] == 40.0 and ve[17] == 55.0  # written with the file's digits="1"
    assert after.get("reqFuel").value == 11.3 and after.get("nCylinders").value == 6.0
    for name, c in before.constants.items():
        if name not in ("veTable1", "reqFuel", "nCylinders"):
            assert after.get(name).values == c.values
    # Everything else is byte-for-byte identical: putting the four old numbers back restores the original.
    restored = (new.replace(b"\n         40.0 38.5 ", b"\n         38.4 38.5 ", 1)
                .replace(b"\n         40.9 55.0 41.3 ", b"\n         40.9 41.1 41.3 ", 1)
                .replace(b">11.3</constant>", b">12.3</constant>", 1)
                .replace(b'name="nCylinders">6</constant>', b'name="nCylinders">4</constant>', 1))
    assert restored == raw


def test_values_keep_the_files_precision(fx):
    raw = fx("ms3_basic.msq")
    new, _ = apply_changes(raw, {"injOpen1": {"0": 1.2}, "wueBins": {"9": 101.6}})
    assert b">1.200</constant>" in new  # digits="3"
    assert parse_msq(new).get("wueBins").values[9] == 102.0  # digits="0"
    assert edit_digits(parse_msq(raw).get("injOpen1")) == 3


@pytest.mark.parametrize("changes,expect", [
    ({}, "no changes"),
    ({"algorithm": {"0": 1}}, "can't be edited"),
    ({"doesNotExist": {"0": 1}}, "isn't in this tune"),
    ({"veTable1": {"256": 1}}, "out of range"),
    ({"veTable1": {"x": 1}}, "isn't a value position"),
    ({"veTable1": {"0": "12"}}, "isn't a usable number"),
    ({"veTable1": {"0": float("nan")}}, "isn't a usable number"),
    ({"veTable1": {"0": True}}, "isn't a usable number"),
    ({"veTable1": {"0": 1e12}}, "isn't a usable number"),
    ({"veTable1": {"0": 38.4}}, "Nothing changed"),
    ({"veTable1": []}, "No values"),
])
def test_bad_edits_are_refused(fx, changes, expect):
    with pytest.raises(EditError, match=re.escape(expect) if expect[0].isupper() else expect):
        apply_changes(fx("ms3_basic.msq"), changes)


def test_duplicate_constant_is_refused(fx):
    raw = fx("ms3_basic.msq").replace(b"</msq>", b'<pcVariables><pcVariable name="reqFuel">1.0</pcVariable></pcVariables></msq>')
    with pytest.raises(EditError, match="appears 2 times"):
        apply_changes(raw, {"reqFuel": {"0": 9.9}})


def test_save_creates_an_edited_copy(client, fx):
    raw = fx("fome_vthpnp.msq")
    slug = upload(client, raw)

    page = client.get(f"/t/{slug}").text
    assert f'data-slug="{slug}"' in page and "data-edit-toggle" in page and "data-editbar" in page
    assert 'data-edit-name="veTable"' in page and 'data-edit-name="rpmHardLimit"' in page
    assert 'data-edit-name="fuelAlgorithm"' not in page  # options stay read-only
    curve = client.get(f"/t/{slug}/c/cltFuelCorr").text
    assert 'data-edit-name="cltFuelCorr"' in curve and 'data-edit-chart="cltFuelCorr"' in curve
    assert "data-edit-toggle" not in client.get(f"/t/{slug}/c/fuelAlgorithm").text

    r = client.post(f"/t/{slug}/save", headers=JSON,
                    json={"changes": {"rpmHardLimit": {"0": 7400}, "veTable": {"5": 61.3}}})
    assert r.status_code == 200, r.text
    body = r.json()
    new = body["slug"]
    assert body["url"] == f"/t/{new}" and new != slug and body["changed"] == 2
    assert f"dk_{new}" in r.cookies

    assert client.get(f"/t/{slug}.msq").content == raw  # the original is never modified
    edited = parse_msq(client.get(f"/t/{new}.msq").content)
    assert edited.get("rpmHardLimit").value == 7400.0 and edited.get("veTable").values[5] == 61.3

    html = client.get(f"/t/{new}").text
    assert "Edited copy" in html and f'href="/d/{slug}/{new}"' in html and 'id="dkey"' in html
    assert client.get(f"/t/{new}.json").json()["parent"] == slug
    assert client.get(f"/t/{slug}.json").json()["parent"] is None
    diff = client.get(f"/d/{slug}/{new}")
    assert diff.status_code == 200 and "rpmHardLimit" in diff.text and "1 of 256 cells changed" in diff.text


def test_save_errors_are_json(client, fx):
    slug = upload(client, fx("fome_vthpnp.msq"))
    bad = client.post(f"/t/{slug}/save", headers=JSON, json={"changes": {"fuelAlgorithm": {"0": 2}}})
    assert bad.status_code == 400 and "can't be edited" in bad.json()["error"]
    garbage = client.post(f"/t/{slug}/save", content=b"not json",
                          headers={**JSON, "content-type": "application/json"})
    assert garbage.status_code == 400 and garbage.json()["error"]
    missing = client.post("/t/aaaaaaaaaa/save", headers=JSON, json={"changes": {"x": {"0": 1}}})
    assert missing.status_code == 404 and missing.json()["error"]


def test_old_databases_gain_the_parent_column(tmp_path):
    con = sqlite3.connect(tmp_path / "msq.db")
    con.execute("CREATE TABLE tunes (slug TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_viewed_at INTEGER NOT NULL,"
                " delete_key_hash TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL,"
                " family TEXT NOT NULL, parsed_json TEXT NOT NULL)")
    con.close()
    store = Store(tmp_path)
    store.init()
    with store.conn() as c:
        assert "parent" in {r["name"] for r in c.execute("PRAGMA table_info(tunes)")}
