import re

import pytest
from fastapi.testclient import TestClient

from app import parser
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, uploads_per_hour=5)
    with TestClient(app, follow_redirects=False) as c:
        yield c


def upload(client, data, name="tune.msq"):
    return client.post("/upload", files={"file": (name, data, "application/octet-stream")})


def slug_of(resp):
    m = re.fullmatch(r"/t/([A-Za-z0-9]{10})", resp.headers["location"])
    assert m, resp.headers.get("location")
    return m.group(1)


def assert_no_leaks(text):
    for bad in ("Traceback", "/Users/", "/srv/", "site-packages", "File \""):
        assert bad not in text


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_home_has_warning(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "ANYONE WITH THE LINK CAN SEE THIS TUNE." in r.text


def test_upload_view_json_download_delete(client, fx):
    raw = fx("fome_vthpnp.msq")
    r = upload(client, raw)
    assert r.status_code == 302
    slug = slug_of(r)
    assert f"dk_{slug}" in r.cookies

    page = client.get(f"/t/{slug}")
    assert page.status_code == 200
    html = page.text
    assert "rusEFI (FOME) Vthpnp.2026.03.19.vthpnp.3616320453" in html
    assert 'property="og:title"' in html and "FOME 2026.03.19 tune" in html
    assert 'data-tab="ve"' in html and 'data-tab="other"' in html and 'data-tab="all"' in html
    assert 'data-fuel="lambda"' in html
    key = re.search(r'<code id="dkey" class="mono">([^<]+)</code>', html).group(1)
    assert page.headers["x-robots-tag"] == "noindex"

    # Key is shown once only.
    assert 'id="dkey"' not in client.get(f"/t/{slug}").text

    j = client.get(f"/t/{slug}.json").json()
    assert j["slug"] == slug and j["family"] == "FOME" and j["tablemap"] == "FOME"
    assert any(c["name"] == "veTable" for c in j["constants"])

    dl = client.get(f"/t/{slug}.msq")
    assert dl.content == raw and "attachment" in dl.headers["content-disposition"]

    part = client.get(f"/t/{slug}/table", params={"name": "luaScratchTable"})
    assert part.status_code == 200 and "luaScratchTable" in part.text and "<table" in part.text
    arr = client.get(f"/t/{slug}/const", params={"name": "cltFuelCorr"})
    assert arr.status_code == 200 and "<ol" in arr.text

    assert client.delete(f"/t/{slug}", params={"key": "wrong"}).status_code == 403
    assert client.delete(f"/t/{slug}", params={"key": key}).json() == {"deleted": True}
    gone = client.get(f"/t/{slug}")
    assert gone.status_code == 404 and "deleted" in gone.text
    assert client.get(f"/t/{slug}.json").json()["error"]


def test_generic_fallback_page(client, fx):
    slug = slug_of(upload(client, fx("unknown_firmware.msq")))
    html = client.get(f"/t/{slug}").text
    assert "Unknown firmware" in html and "AcmeECU build 7" in html and "fooMap" in html


@pytest.mark.parametrize("name,expect", [
    ("malformed.msq", "invalid XML"),
    ("not_xml.msq", "not XML"),
    ("xxe.msq", "DTD"),
])
def test_bad_uploads_are_friendly(client, fx, name, expect):
    r = upload(client, fx(name))
    assert r.status_code == 400
    assert expect in r.text
    assert "root:" not in r.text
    assert_no_leaks(r.text)


def test_oversized_upload_rejected_before_reading(client):
    big = b"<msq>" + b" " * (parser.MAX_BYTES + 300 * 1024) + b"</msq>"
    r = upload(client, big)
    assert r.status_code == 413
    assert "too large" in r.text


def test_rate_limit(client, fx):
    data = fx("speeduino_basic.msq")
    for _ in range(5):
        assert upload(client, data).status_code == 302
    r = upload(client, data)
    assert r.status_code == 429 and "Too many uploads" in r.text


def test_failed_uploads_do_not_count(client, fx):
    for _ in range(8):
        assert upload(client, fx("malformed.msq")).status_code == 400
    assert upload(client, fx("speeduino_basic.msq")).status_code == 302


def test_diff_page_mismatched_dims(client, fx):
    a = slug_of(upload(client, fx("ms3_basic.msq")))
    b = slug_of(upload(client, fx("ms3_resized.msq")))
    r = client.get(f"/d/{a}/{b}")
    assert r.status_code == 200
    assert "Table dimensions differ (16×16 vs 12×12)" in r.text


def test_compare_with_uploaded_b(client, fx):
    a = slug_of(upload(client, fx("ms3_basic.msq")))
    r = client.post("/compare", data={"a": f"https://example.up.railway.app/t/{a}", "b": ""},
                    files={"file": ("b.msq", fx("ms3_modified.msq"), "application/octet-stream")})
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith(f"/d/{a}/")
    page = client.get(loc)
    assert page.status_code == 200 and "21" in page.text and 'id="dkey"' in page.text
    b = loc.rsplit("/", 1)[1]
    part = client.get(f"/d/{a}/{b}/table", params={"name": "mysteryTable"})
    assert part.status_code == 200


def test_compare_errors(client):
    r = client.post("/compare", data={"a": "nope", "b": "nope"})
    assert r.status_code == 400 and "Tune A wasn&#39;t found" in r.text
    assert client.get("/compare/check", params={"a": "zzzzzzzzzz"}).text.startswith('<span class="bad">')


def test_not_found_and_bad_slugs(client):
    for path in ("/t/aaaaaaaaaa", "/t/../../etc/passwd", "/t/short", "/d/aaaaaaaaaa/bbbbbbbbbb", "/nope"):
        r = client.get(path)
        assert r.status_code == 404
        assert_no_leaks(r.text)


def test_server_error_is_generic(tmp_path, fx, monkeypatch):
    app = create_app(tmp_path)
    with TestClient(app, follow_redirects=False, raise_server_exceptions=False) as c:
        slug = slug_of(c.post("/upload", files={"file": ("t.msq", fx("ms3_basic.msq"))}))

        def boom(*a, **k):
            raise RuntimeError("secret /srv/app/internal path")

        monkeypatch.setattr(app.state.store, "get_doc", boom)
        r = c.get(f"/t/{slug}")
        assert r.status_code == 500
        assert "secret" not in r.text
        assert_no_leaks(r.text)


def test_purge_removes_stale(tmp_path, fx):
    app = create_app(tmp_path)
    with TestClient(app, follow_redirects=False) as c:
        slug = slug_of(c.post("/upload", files={"file": ("t.msq", fx("ms3_basic.msq"))}))
        store = app.state.store
        with store.conn() as conn:
            conn.execute("UPDATE tunes SET last_viewed_at = last_viewed_at - 181 * 86400 WHERE slug=?", (slug,))
        assert store.purge_stale() == 1
        assert not store.raw_path(slug).exists()
        assert c.get(f"/t/{slug}").status_code == 404
