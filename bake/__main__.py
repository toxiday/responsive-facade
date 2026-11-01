"""Bake command line.  Run from the repo root:

    .venv\\Scripts\\python.exe -m bake <command>

Commands
    smoke   import v3 read-only, load the surrogate on the GPU, run one sun condition and one
            forward pass on the baseline facade; writes bake/work/smoke.json
    slots   median day + sun-up hours for every city and month; writes bake/work/slots/
    m1      M1 orientation/shadow check (2 Radiance runs); writes web/src/__fixtures__/m1.json
    manifest  room, furniture, states, legend, cities; writes web/public/data/manifest.json
    fixtures  v3 geometry for the TypeScript tests; writes web/src/__fixtures__/conventions.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from . import config


def cmd_smoke(_args) -> int:
    config.check_venv()
    room = config.check_room()
    prov = config.provenance()
    if not prov["weights_sha256_ok"]:
        print(f"weights SHA-256 mismatch: {prov['weights_sha256']}", file=sys.stderr)
        return 1

    v3 = config.import_v3()
    import numpy as np
    import torch

    t0 = time.perf_counter()
    solver = v3.live_solver.LiveSolver(verbose=False)
    t_load = time.perf_counter() - t0

    cond5, info = v3.live_solver.single_condition(
        config.wea_path("houston"), 6, 21, 12, config.NORTH_ANGLE)
    assert info["ok"] and info["hour"] == 12.5, info  # mid-hour stamp kept, never rounded

    baseline = v3.vfr.load_binary_wide(config.BASELINE_CSV)  # (4,16,32), 1 = window
    cond = v3.opt.append_room(cond5, config.ROOM_W, config.ROOM_D, config.ROOM_H)
    t1 = time.perf_counter()
    lux = solver.opt.predict_lux(baseline, cond)[0]
    t_pred = time.perf_counter() - t1

    out = {
        "provenance": prov,
        "torch": torch.__version__,
        "device": str(solver.opt.device),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "room": {k: room[k] for k in ("name", "width", "depth", "height", "north_angle", "sides")},
        "sun": {k: info[k] for k in ("alt", "az", "dni", "dhi", "hour")},
        "baseline_glazing_pct": float(baseline[[0, 3]].mean() * 100),
        "baseline_lux": {
            "mean": float(lux.mean()), "min": float(lux.min()), "max": float(lux.max()),
            "cells_over_3000": int((lux > 3000).sum()),
        },
        "seconds": {"load": round(t_load, 2), "predict_first": round(t_pred, 3)},
    }
    path = config.assert_writable(config.WORK / "smoke.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))
    assert np.isfinite(lux).all()
    return 0


def cmd_slots(_args) -> int:
    config.check_venv()
    from . import slots

    data = slots.write_all()
    total = 0
    for city, d in data.items():
        counts = [len(m["slots"]) for m in d["months"]]
        total += sum(counts)
        days = " ".join(f"{m['month']}/{m['day']}" for m in d["months"])
        print(f"{city:8s} {sum(counts):3d} slots  per month {counts}")
        print(f"         days {days}")
        skies = [s["sky"] for m in d["months"] for s in m["slots"]]
        print("         sky  " + ", ".join(f"{k} {skies.count(k)}" for k in ("clear", "partly", "overcast")))
    print(f"total {total} slots")
    return 0


def cmd_m1(args) -> int:
    from . import m1

    res = m1.run(force=args.force)
    bad = [c for c in res["cases"] if c["iou_geometric_vs_radiance"] < m1.IOU_MIN]
    return 1 if bad else 0


def cmd_manifest(_args) -> int:
    config.check_venv()
    from . import manifest

    print(manifest.write())
    return 0


def cmd_fixtures(_args) -> int:
    config.check_venv()
    from . import fixtures

    print(fixtures.write())
    print(fixtures.write_month_fixture())
    return 0


def cmd_bench(args) -> int:
    from . import bench
    bench.run(procs=tuple(int(n) for n in args.procs.split(",")))
    return 0


def _scope(args):
    cities = args.city.split(",")
    months = [int(m) for m in args.months.split(",")]
    return cities, months


def cmd_solve(args) -> int:
    from . import solve
    cities, months = _scope(args)
    solve.run(cities, months, procs=args.procs, force=args.force)
    return 0


def cmd_baseline(args) -> int:
    from . import solve
    cities, months = _scope(args)
    print(f"baseline: {solve.run_baseline(cities, months, force=args.force)} month(s) written")
    return 0


def cmd_verify(args) -> int:
    from . import verify
    cities, months = _scope(args)
    r = verify.run(cities, months, workers=args.workers)
    print(f"verify: {r['runs']} run(s) in {r['minutes']:.1f} min, {len(r['failed'])} failed")
    return 1 if r["failed"] else 0


def cmd_pack(args) -> int:
    from . import pack
    pack.run(*_scope(args))
    return 0


def cmd_report(args) -> int:
    from . import report
    print(report.write(*_scope(args)))
    return 0


def cmd_m2(args) -> int:
    """Houston December end to end: solve, baseline, verify, pack, report."""
    for step in (cmd_solve, cmd_baseline, cmd_verify, cmd_pack, cmd_report):
        if step(args):
            return 1
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bake")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("smoke", help="import v3 and run one forward pass")
    sub.add_parser("slots", help="compute the baked days and hours")
    p = sub.add_parser("m1", help="M1 orientation and shadow check")
    p.add_argument("--force", action="store_true", help="re-run Radiance")
    sub.add_parser("manifest", help="write web/public/data/manifest.json")
    sub.add_parser("fixtures", help="write the TypeScript test fixtures")
    p = sub.add_parser("bench", help="measure solve, concurrency and Radiance costs")
    p.add_argument("--procs", default="1,2,3,4", help="solver process counts to try")
    for name, help_ in (("solve", "facade solve chains"), ("baseline", "baseline facade lux"),
                        ("verify", "Radiance verification"), ("pack", "write the site data"),
                        ("report", "write bake_report.md"),
                        ("m2", "solve, baseline, verify, pack and report")):
        q = sub.add_parser(name, help=help_)
        q.add_argument("--city", default="houston")
        q.add_argument("--months", default="12")
        q.add_argument("--procs", type=int, default=3, help="solver processes")
        q.add_argument("--workers", type=int, default=20, help="Radiance workers")
        q.add_argument("--force", action="store_true", help="redo finished work")
    args = ap.parse_args(argv)
    cmds = {"smoke": cmd_smoke, "slots": cmd_slots, "m1": cmd_m1,
            "manifest": cmd_manifest, "fixtures": cmd_fixtures, "bench": cmd_bench,
            "solve": cmd_solve, "baseline": cmd_baseline, "verify": cmd_verify,
            "pack": cmd_pack, "report": cmd_report, "m2": cmd_m2}
    return cmds[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
