"""The schedule-specific facade is designed for the app's own daily routine."""

import re

from bake import config, room, schedule_facade


def test_the_plan_is_the_apps():
    ts = (config.WEB / "src" / "app" / "schedule.ts").read_text(encoding="utf-8")
    assert re.search(r"import dayPlan from '\./day_plan\.json'", ts)
    plan = schedule_facade.day_plan()
    ids = {s.id for s in room.states()}
    assert plan and all(sid in ids for _at, sid in plan)
    assert [at for at, _ in plan] == sorted(at for at, _ in plan)


def test_planned_state_holds_each_entry_until_the_next():
    plan = schedule_facade.day_plan()
    first, second = plan[0], plan[1]
    assert schedule_facade.planned_state("05:30") == first[1]  # before the first: the first
    assert schedule_facade.planned_state(first[0]) == first[1]
    assert schedule_facade.planned_state(second[0]) == second[1]
    assert schedule_facade.planned_state("19:30") == plan[-1][1]  # after the last: the last


def test_every_baked_hour_has_a_state():
    hrs = schedule_facade.hours("houston")
    assert {h["month"] for h in hrs} == set(schedule_facade.MONTHS)
    assert all(h["state"] in {sid for _at, sid in schedule_facade.day_plan()} for h in hrs)
