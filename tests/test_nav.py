"""The category tree is the whole navigation model, so it gets its own tests."""
import pytest

from app.nav import CATEGORY_LABEL, CATEGORY_ORDER, build_sections, categorize, nav_from_sections
from app.parser import Constant
from app.render import build_grid


@pytest.mark.parametrize("name,expected", [
    # the obvious ones
    ("veTable", "fuel"),
    ("ignitionTable", "spark"),
    ("lambdaTable", "afr"),
    ("afrTable1", "afr"),
    ("vvtTable1", "vvt"),
    ("boostTableOpenLoop", "boost"),
    ("luaScratchTable", "script"),
    ("cylindersCount", "engine"),
    ("displacement", "engine"),
    # ordering matters: Idle is checked before Fuel, so this is not "fuel"
    ("idleVeTable", "idle"),
    # ...and Protection before Fuel, so "rev" doesn't drag in "ve"
    ("rpmHardLimit", "knock"),
    ("RevLimNormal2", "knock"),
    # camelCase and snake_case both tokenise
    ("tpsTpsAccelTbl", "accel"),
    ("injector_flow", "fuel"),
    ("wueBins", "crank"),
    ("fan1DutyAcOffTbl", "io"),
    # nothing recognisable still lands somewhere
    ("mysteryTable", "other"),
])
def test_categorize(name, expected):
    assert categorize(name) == expected


def test_label_beats_a_cryptic_name():
    assert categorize("scriptCurve1", "Engine knock threshold") == "knock"


def test_every_category_has_a_label_and_a_place_in_the_order():
    assert set(CATEGORY_ORDER) == set(CATEGORY_LABEL)
    assert len(CATEGORY_ORDER) == len(set(CATEGORY_ORDER))


def _scalar(name):
    return Constant(name, "scalar", [1.0])


def test_build_sections_places_everything_exactly_once():
    z = Constant("veTable", "table", [float(i) for i in range(4)], 2, 2)
    grid = build_grid("ve", "VE Table", z)
    settings = [_scalar(n) for n in ("reqFuel", "idleRpm", "somethingWeird", "nCylinders")]
    sections = build_sections(grids=[grid], settings=settings)

    assert sum(len(s.items) for s in sections) == 1
    assert sum(len(s.settings) for s in sections) == len(settings)
    anchors = [i.anchor for s in sections for i in s.items]
    assert len(anchors) == len(set(anchors)), "anchors must be unique — they are DOM ids"
    # sections come back in display order
    keys = [s.key for s in sections]
    assert keys == sorted(keys, key=CATEGORY_ORDER.index)


def test_build_sections_is_empty_for_an_empty_tune():
    assert build_sections() == []


def test_nav_mirrors_the_sections():
    settings = [_scalar("reqFuel"), _scalar("idleRpm")]
    sections = build_sections(settings=settings)
    nav = nav_from_sections(sections)

    assert nav[0].items[0].id == "overview"
    assert [g.label for g in nav[1:]] == [s.label for s in sections]
    # every category with settings gets a Settings link pointing at its anchor
    for group, section in zip(nav[1:], sections):
        assert group.items[-1].id == section.settings_anchor
