"""Regenerate the synthetic .msq fixtures: `python tests/fixtures/make_fixtures.py`.

All values are made up; no real engine tune is included.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def grid(rows, cols, fn, digits=1):
    lines = []
    for r in range(rows):
        lines.append("         " + " ".join(f"{fn(r, c):.{digits}f}" for c in range(cols)))
    return "\n" + "\n".join(lines) + "\n      "


def column(vals, digits=0):
    return "\n" + "\n".join(f"         {v:.{digits}f}" for v in vals) + "\n      "


RPM16 = [500 + i * 450 for i in range(16)]
KPA16 = [20 + i * 15 for i in range(16)]


def ve(r, c):
    return 35 + 55 * (KPA16[r] / 245) * (0.75 + 0.25 * (1 - abs(c - 9) / 9))


def adv(r, c):
    return max(8.0, 14 + 22 * (c / 15) - 14 * (r / 15))


def afr(r, c):
    return 14.7 - 3.0 * max(0.0, (KPA16[r] - 100) / 145)


def ms3(ve_fn=ve, req_fuel=12.3, rows=16, cols=16, comment="Synthetic MS3 test tune", extra=""):
    rpm = RPM16[:cols]
    kpa = KPA16[:rows]
    return f"""<?xml version="1.0" encoding="ISO-8859-1"?>
<msq xmlns="http://www.msefi.com/:msq">
  <bibliography author="MSQ Viewer fixture" tuneComment="{comment}" writeDate="Mon Sep 14 12:00:00 CDT 2026"/>
  <versionInfo fileFormat="5.0" firmwareInfo="MS3 synthetic" nPages="3" signature="MS3 Format 0435.14P"/>
  <page number="0" size="1024">
    <constant digits="1" name="reqFuel" units="ms">{req_fuel}</constant>
    <constant name="nCylinders">4</constant>
    <constant name="algorithm">"Speed Density"</constant>
    <constant name="alternate">"Alternating"</constant>
    <constant digits="0" name="divider">2</constant>
    <constant digits="3" name="injOpen1" units="ms">0.950</constant>
    <constant digits="0" name="RevLimNormal2" units="RPM">7000</constant>
    <constant name="twoStroke">"Four-stroke"</constant>
    <constant name="someFutureFeatureFlag">"On"</constant>
    <constant cols="1" digits="0" name="wueBins" rows="10" units="%">{column([180,170,160,150,140,130,120,110,105,100])}</constant>
  </page>
  <page number="1" size="4096">
    <constant cols="{cols}" digits="1" name="veTable1" rows="{rows}" units="%">{grid(rows, cols, ve_fn)}</constant>
    <constant cols="1" digits="0" name="frpm_table1" rows="{cols}" units="RPM">{column(rpm)}</constant>
    <constant cols="1" digits="0" name="fmap_table1" rows="{rows}" units="kPa">{column(kpa)}</constant>
    <constant cols="16" digits="1" name="advanceTable1" rows="16" units="deg">{grid(16, 16, adv)}</constant>
    <constant cols="1" digits="0" name="srpm_table1" rows="16" units="RPM">{column(RPM16)}</constant>
    <constant cols="1" digits="0" name="smap_table1" rows="16" units="kPa">{column(KPA16)}</constant>
    <constant cols="16" digits="1" name="afrTable1" rows="16" units="AFR">{grid(16, 16, afr)}</constant>
    <constant cols="1" digits="0" name="arpm_table1" rows="16" units="RPM">{column(RPM16)}</constant>
    <constant cols="1" digits="0" name="amap_table1" rows="16" units="kPa">{column(KPA16)}</constant>
    <constant cols="6" digits="0" name="mysteryTable" rows="4" units="">{grid(4, 6, lambda r, c: r * 6 + c, 0)}</constant>
    {extra}
  </page>
  <pcVariables>
    <pcVariable name="tsCanId">"CAN ID 0"</pcVariable>
  </pcVariables>
</msq>
"""


def ve_modified(r, c):
    base = ve(r, c)
    if 8 <= r <= 11 and 6 <= c <= 10:
        return base + 4.0
    if r == 2 and c == 3:
        return base - 2.5
    return base


def speeduino():
    rpm = " ".join(str(v) for v in RPM16)
    load = " ".join(str(v) for v in KPA16)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<msq>
  <bibliography author="MSQ Viewer fixture" tuneComment="Synthetic Speeduino" writeDate="2026-09-14"/>
  <versionInfo fileFormat="5.0" nPages="15" signature="speeduino 202402"/>
  <page number="1">
    <constant name="veTable" rows="16" cols="16" units="%" digits="0">{grid(16, 16, ve, 0)}</constant>
    <constant name="rpmBins" rows="1" cols="16" units="RPM" digits="0">{rpm}</constant>
    <constant name="fuelLoadBins" rows="1" cols="16" units="kPa" digits="0">{load}</constant>
    <constant name="reqFuel" units="ms" digits="1">9.8</constant>
    <constant name="nCylinders">"6"</constant>
    <constant name="injOpen" units="ms" digits="1">1.0</constant>
    <constant name="algorithm">"Speed Density"</constant>
  </page>
</msq>
"""


def unknown():
    return f"""<?xml version="1.0"?>
<msq>
  <bibliography author="x" tuneComment="Homebrew ECU" writeDate="2026"/>
  <versionInfo fileFormat="5.0" signature="AcmeECU build 7"/>
  <page number="0">
    <constant name="fooMap" rows="8" cols="8" units="?">{grid(8, 8, lambda r, c: r + c)}</constant>
    <constant name="barCurve" rows="1" cols="8">{grid(1, 8, lambda r, c: c * 2)}</constant>
    <constant name="bazScalar" units="V" digits="2">13.80</constant>
  </page>
</msq>
"""


RUS_RPM = [650.0, 1000.0, 1500.0, 2000.0, 2500.0, 3000.0, 3500.0, 4000.0,
           4500.0, 5000.0, 5500.0, 6000.0, 6500.0, 7000.0, 7500.0, 8000.0]
RUS_LOAD = [12.5 + i * 15.5 for i in range(16)]  # float bins, fractional


def rus_family(signature, comment, lambda_fn=None):
    lam = lambda_fn or (lambda r, c: 1.0 - 0.22 * max(0.0, (RUS_LOAD[r] - 100) / 145))
    rpm = column(RUS_RPM, 1)
    load = column(RUS_LOAD, 2)
    return f"""<?xml version="1.0" encoding="ISO-8859-1"?>
<msq xmlns="http://www.msefi.com/:msq">
  <bibliography author="TunerStudio fixture" tuneComment="{comment}" writeDate="Tue Mar 24 09:30:00 CDT 2026"/>
  <versionInfo fileFormat="5.0" firmwareInfo="" nPages="1" signature="{signature}"/>
  <page number="0">
    <constant digits="0" name="cylindersCount">4</constant>
    <constant digits="0" name="rpmHardLimit" units="rpm">7200</constant>
    <constant digits="2" name="injector_flow" units="cc/min">440.00</constant>
    <constant digits="3" name="displacement" units="L">1.800</constant>
    <constant name="fuelAlgorithm">"Speed Density"</constant>
    <constant name="injectionMode">"Sequential"</constant>
    <constant name="ignitionMode">"Individual Coils"</constant>
    <constant name="engineType">"DEFAULT_FRANKENSO"</constant>
    <constant cols="16" digits="1" name="veTable" rows="16" units="%">{grid(16, 16, ve, 1)}</constant>
    <constant cols="1" digits="0" name="veRpmBins" rows="16" units="RPM">{rpm}</constant>
    <constant cols="1" digits="0" name="veLoadBins" rows="16" units="kPa">{load}</constant>
    <constant cols="16" digits="1" name="ignitionTable" rows="16" units="deg">{grid(16, 16, adv, 1)}</constant>
    <constant cols="1" digits="0" name="ignitionRpmBins" rows="16" units="RPM">{rpm}</constant>
    <constant cols="1" digits="0" name="ignitionLoadBins" rows="16" units="Load">{load}</constant>
    <constant cols="16" digits="2" name="lambdaTable" rows="16" units="lambda">{grid(16, 16, lam, 2)}</constant>
    <constant cols="1" digits="0" name="lambdaRpmBins" rows="16" units="RPM">{rpm}</constant>
    <constant cols="1" digits="0" name="lambdaLoadBins" rows="16" units="">{load}</constant>
    <constant cols="8" digits="0" name="vvtTable1" rows="8" units="deg">{grid(8, 8, lambda r, c: min(40, c * 4 + r), 0)}</constant>
    <constant cols="1" digits="0" name="vvtTable1RpmBins" rows="8" units="RPM">{column(RUS_RPM[::2], 0)}</constant>
    <constant cols="1" digits="0" name="vvtTable1LoadBins" rows="8" units="Load">{column(RUS_LOAD[::2], 1)}</constant>
    <constant cols="8" digits="1" name="boostTableOpenLoop" rows="8" units="%">{grid(8, 8, lambda r, c: r * c * 0.9, 1)}</constant>
    <constant cols="4" digits="2" name="luaScratchTable" rows="4" units="">{grid(4, 4, lambda r, c: (r + 1) * 0.25 + c, 2)}</constant>
    <constant cols="1" digits="1" name="cltFuelCorrBins" rows="16" units="C">{column([-40 + i * 10.5 for i in range(16)], 1)}</constant>
    <constant cols="1" digits="2" name="cltFuelCorr" rows="16" units="ratio">{column([1.5 - i * 0.033 for i in range(16)], 2)}</constant>
  </page>
</msq>
"""


XXE = """<?xml version="1.0"?>
<!DOCTYPE msq [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<msq>
  <bibliography author="&xxe;"/>
  <versionInfo signature="MS3 format 0342.01"/>
</msq>
"""

BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<msq><bibliography author="&lol3;"/></msq>
"""

MALFORMED = """<?xml version="1.0"?>
<msq>
  <versionInfo signature="MS3 format 0342.01">
  <page number="0">
    <constant name="reqFuel">12.3</constant
</msq>
"""

if __name__ == "__main__":
    files = {
        "ms3_basic.msq": ms3(),
        "ms3_modified.msq": ms3(ve_fn=ve_modified, req_fuel=13.1, comment="Synthetic MS3, VE tweaked"),
        "ms3_resized.msq": ms3(rows=12, cols=12, comment="Synthetic MS3, 12x12 VE"),
        "speeduino_basic.msq": speeduino(),
        "unknown_firmware.msq": unknown(),
        "rusefi_basic.msq": rus_family("rusEFI master.2026.02.01.proteus_f4.1234567890", "Synthetic rusEFI Proteus"),
        "fome_vthpnp.msq": rus_family("rusEFI (FOME) Vthpnp.2026.03.19.vthpnp.3616320453", "Synthetic FOME VTHPNP"),
        "xxe.msq": XXE,
        "billion_laughs.msq": BILLION_LAUGHS,
        "malformed.msq": MALFORMED,
        "not_xml.msq": "PK\x03\x04 this is a zip, not a tune\n",
    }
    for name, text in files.items():
        (HERE / name).write_text(text, encoding="latin-1" if "ISO-8859-1" in text else "utf-8")
    print("wrote", len(files), "fixtures")
