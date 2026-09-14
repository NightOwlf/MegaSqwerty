import pytest

from app import parser
from app.parser import MsqError, TuneDoc, parse_msq, parse_signature


def test_happy_path_ms3(fx):
    doc = parse_msq(fx("ms3_basic.msq"))
    assert doc.signature == "MS3 Format 0435.14P"
    assert (doc.family, doc.version) == ("MS3", "0435.14P")
    assert doc.tune_comment == "Synthetic MS3 test tune"
    assert doc.write_date.startswith("Mon Sep 14")
    assert doc.file_format == "5.0"

    req = doc.get("reqFuel")
    assert req.kind == "scalar" and req.value == 12.3 and req.units == "ms" and req.digits == 1 and req.page == 0

    ve = doc.get("veTable1")
    assert ve.kind == "table" and (ve.rows, ve.cols) == (16, 16) and len(ve.values) == 256
    assert ve.page == 1 and all(isinstance(v, float) for v in ve.values)
    # Row-major: row(0) is the first 16 values.
    assert ve.row(0) == ve.values[:16]

    bins = doc.get("frpm_table1")
    assert bins.kind == "array" and len(bins.values) == 16 and bins.values[0] == 500.0

    assert doc.get("algorithm").kind == "string" and doc.get("algorithm").value == "Speed Density"
    # Unknown names are preserved, including pcVariables outside pages.
    assert doc.get("someFutureFeatureFlag").value == "On"
    assert doc.get("tsCanId").value == "CAN ID 0"


def test_round_trip_to_dict(fx):
    doc = parse_msq(fx("ms3_basic.msq"))
    again = TuneDoc.from_dict(doc.to_dict())
    assert again == doc


def test_row_vector_bins_speeduino(fx):
    doc = parse_msq(fx("speeduino_basic.msq"))
    assert doc.family == "Speeduino" and doc.version == "202402"
    rpm = doc.get("rpmBins")
    assert rpm.kind == "array" and (rpm.rows, rpm.cols) == (1, 16)
    assert doc.get("veTable").is_table


def test_rusefi_float_bins_and_lambda(fx):
    doc = parse_msq(fx("rusefi_basic.msq"))
    assert doc.family == "rusEFI"
    assert (doc.version, doc.board, doc.branch, doc.build) == ("2026.02.01", "proteus_f4", "master", "1234567890")
    load = doc.get("veLoadBins")
    assert load.values[1] == pytest.approx(28.0)
    assert doc.get("lambdaTable").units == "lambda"
    assert 0.6 <= min(doc.get("lambdaTable").values) <= max(doc.get("lambdaTable").values) <= 1.3


def test_fome_signature_kept_verbatim(fx):
    doc = parse_msq(fx("fome_vthpnp.msq"))
    assert doc.signature == "rusEFI (FOME) Vthpnp.2026.03.19.vthpnp.3616320453"
    assert doc.family == "FOME" and doc.board == "vthpnp" and doc.version == "2026.03.19"


def test_malformed_xml(fx):
    with pytest.raises(MsqError) as e:
        parse_msq(fx("malformed.msq"))
    assert "invalid XML" in str(e.value)


def test_not_xml(fx):
    with pytest.raises(MsqError) as e:
        parse_msq(fx("not_xml.msq"))
    assert "not XML" in str(e.value)


def test_wrong_root():
    with pytest.raises(MsqError) as e:
        parse_msq(b"<?xml version='1.0'?><html><body/></html>")
    assert "<msq>" in str(e.value)


def test_empty():
    with pytest.raises(MsqError):
        parse_msq(b"   \n")


def test_xxe_attempt_rejected(fx):
    with pytest.raises(MsqError) as e:
        parse_msq(fx("xxe.msq"))
    msg = str(e.value)
    assert "DTD" in msg and "root:" not in msg and "passwd" not in msg


def test_billion_laughs_rejected(fx):
    with pytest.raises(MsqError):
        parse_msq(fx("billion_laughs.msq"))


def test_oversized_file():
    data = b"<msq>" + b" " * parser.MAX_BYTES + b"</msq>"
    with pytest.raises(MsqError) as e:
        parse_msq(data)
    assert "too large" in str(e.value)


def test_constant_count_cap():
    body = "".join(f'<constant name="c{i}">1</constant>' for i in range(parser.MAX_CONSTANTS + 1))
    with pytest.raises(MsqError) as e:
        parse_msq(f"<msq><page number='0'>{body}</page></msq>".encode())
    assert "too many settings" in str(e.value)


def test_value_count_cap(monkeypatch):
    monkeypatch.setattr(parser, "MAX_VALUES", 100)
    with pytest.raises(MsqError) as e:
        parse_msq(b"<msq><page><constant name='t' rows='20' cols='20'>" + b"1 " * 400 + b"</constant></page></msq>")
    assert "too many values" in str(e.value)


def test_dimension_mismatch_does_not_crash():
    doc = parse_msq(b"<msq><page><constant name='t' rows='4' cols='4'>1 2 3</constant></page></msq>")
    assert len(doc.get("t").values) == 3 and not doc.get("t").is_table


@pytest.mark.parametrize("sig,family,version", [
    ("MS3 format 0342.01", "MS3", "0342.01"),
    ("MS3 Format 0435.14P", "MS3", "0435.14P"),
    ("MS2Extra comms342hP", "MS2", "342hP"),
    ("MSII Rev 3.83000", "MS2", "3.83000"),
    ("MS1/Extra format 029y3 *********", "MS1", "029y3"),
    ("MSnS-extra format 029y4", "MS1", "029y4"),
    ("speeduino 202402", "Speeduino", "202402"),
    ("Speeduino 2023.05-dev", "Speeduino", "2023.05-dev"),
    ("rusEFI master.2024.03.15.proteus_f4.2345678", "rusEFI", "2024.03.15"),
    ("RUSEFI weird build string", "rusEFI", ""),
    ("rusEFI (FOME) Vthpnp.2026.03.19.vthpnp.3616320453", "FOME", "2026.03.19"),
    ("FOME master.2023.08.01.hellen72.99", "FOME", "2023.08.01"),
    ("AcmeECU build 7", "unknown", ""),
    ("", "unknown", ""),
    (None, "unknown", ""),
])
def test_signature_parsing(sig, family, version):
    out = parse_signature(sig)
    assert out["family"] == family
    assert out["version"] == version
