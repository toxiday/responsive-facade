"""Which day and which hours are baked for each city and month (guidelines §4.3).

Day: the month's median day by daily global horizontal irradiation (Tony, 2026-11-01;
replaces the guidelines' clearest-day rule so the demo shows typical conditions). Each
day's GHI sums DNI·sin(alt) + DHI over its .wea rows, with the sun from v3's
`solar_position` at the row's own mid-hour stamp. The day whose sum is closest to the
month's median is chosen; ties go to the day nearest the 15th.

Hours: every .wea row on that day whose sun is above the model's 5° floor. The sun comes
from v3's own `single_condition`, which keeps the file's mid-hour stamp (12.5, never
rounded) and applies north_angle to the sun vector, so `sun_room` is already in the room
frame.
"""

from __future__ import annotations

import json
import math

from . import config

MID_MONTH = 15

# Sky label from the slot's direct-normal irradiance, W/m². 120 W/m² is the WMO sunshine
# threshold; 500 separates hazy/broken sun from clear sun.
SKY_LABELS = (("overcast", 0.0), ("partly", 120.0), ("clear", 500.0))


def sky_label(dni: float) -> str:
    label = SKY_LABELS[0][0]
    for name, lo in SKY_LABELS:
        if dni >= lo:
            label = name
    return label


def daily_ghi(rows, month: int, lat: float, lon_east: float, tz_h: float) -> dict[int, float]:
    """{day: global horizontal irradiation, Wh/m²} for `month` from a `_wea_rows` index."""
    solar_position = config.import_v3().opt.solar_position
    out: dict[int, float] = {}
    for (m, d, _h), (file_hour, dni, dhi) in rows.items():
        if m != month:
            continue
        alt, _az, _v = solar_position(lat, lon_east, tz_h, m, d, file_hour)
        out[d] = out.get(d, 0.0) + dni * max(0.0, math.sin(math.radians(alt))) + dhi
    return out


def median_day(ghi: dict[int, float]) -> tuple[int, float, float]:
    """(day, its GHI, the month's median GHI): the day closest to the median."""
    vals = sorted(ghi.values())
    n = len(vals)
    med = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    day = min(ghi, key=lambda d: (abs(ghi[d] - med), abs(d - MID_MONTH), d))
    return day, ghi[day], med


def hhmm(hour: float) -> str:
    h = int(math.floor(hour))
    return f"{h:02d}:{int(round((hour - h) * 60)):02d}"


def city_slots(city: str) -> dict:
    ls = config.import_v3().live_solver
    wea = config.wea_path(city)
    lat, lon_east, tz_h, rows = ls._wea_rows(wea)
    months = []
    for month in range(1, 13):
        ghi = daily_ghi(rows, month, lat, lon_east, tz_h)
        day, ghi_day, ghi_median = median_day(ghi)
        slots = []
        for hour in range(24):
            cond5, info = ls.single_condition(wea, month, day, hour, config.NORTH_ANGLE)
            if not info["ok"]:
                continue
            assert info["has_row"], (city, month, day, hour)
            sx, sy, sz = (float(v) for v in cond5[0, :3])
            slots.append({
                "hour": info["hour"],
                "label": hhmm(info["hour"]),
                "alt": round(info["alt"], 4),
                "az_true": round(info["az"], 4),
                "sun_room": [round(sx, 6), round(sy, 6), round(sz, 6)],
                "dni": info["dni"],
                "dhi": info["dhi"],
                "sky": sky_label(info["dni"]),
                "cond5": [float(v) for v in cond5[0]],
            })
        months.append({
            "month": month, "day": day,
            "ghi_wh": round(ghi_day, 1), "ghi_median_wh": round(ghi_median, 1),
            "ghi_range_wh": [round(min(ghi.values()), 1), round(max(ghi.values()), 1)],
            "slots": slots,
        })
    return {
        "city": city,
        "wea": config.CITIES[city],
        "lat": lat,
        "lon": lon_east,
        "tz": tz_h,
        "north_angle": config.NORTH_ANGLE,
        "months": months,
    }


def write_all() -> dict[str, dict]:
    out_dir = config.assert_writable(config.WORK / "slots")
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for city in config.CITIES:
        data = city_slots(city)
        (out_dir / f"{city}.json").write_text(json.dumps(data, indent=1))
        result[city] = data
    return result


def load(city: str) -> dict:
    path = config.WORK / "slots" / f"{city}.json"
    if not path.exists():
        return write_all()[city]
    return json.loads(path.read_text())


def find_slot(city: str, month: int, label: str) -> tuple[dict, dict]:
    """(month record, slot record) for e.g. ("houston", 12, "12:30")."""
    data = load(city)
    m = data["months"][month - 1]
    for s in m["slots"]:
        if s["label"] == label:
            return m, s
    raise KeyError(f"{city} month {month} has no slot {label}")
