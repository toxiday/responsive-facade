"""Baked days and hours: median-GHI day, mid-hour stamps, sun above 5°."""

import pytest

from bake import config, slots


@pytest.fixture(scope="module")
def data():
    return {c: slots.city_slots(c) for c in config.CITIES}


def test_median_day_rule(data):
    ls = config.import_v3().live_solver
    for city, d in data.items():
        lat, lon, tz, rows = ls._wea_rows(config.wea_path(city))
        for m in d["months"]:
            ghi = slots.daily_ghi(rows, m["month"], lat, lon, tz)
            day, _g, med = slots.median_day(ghi)
            assert day == m["day"]
            assert abs(ghi[day] - med) == min(abs(v - med) for v in ghi.values())


def test_stamps_are_mid_hour_and_sun_is_up(data):
    for d in data.values():
        for m in d["months"]:
            assert 7 <= len(m["slots"]) <= 14
            for s in m["slots"]:
                assert s["hour"] % 1 == 0.5 and s["label"].endswith(":30")
                assert s["alt"] > 5.0 and s["sun_room"][2] < 0


def test_slot_counts(data):
    assert {c: sum(len(m["slots"]) for m in d["months"]) for c, d in data.items()} == {
        "houston": 134, "boston": 128, "seattle": 131}


def test_sky_label():
    assert slots.sky_label(0) == "overcast"
    assert slots.sky_label(119.9) == "overcast"
    assert slots.sky_label(120) == "partly"
    assert slots.sky_label(500) == "clear"
