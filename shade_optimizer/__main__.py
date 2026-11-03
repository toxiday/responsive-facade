"""python -m shade_optimizer <command> [--city houston] [--months 12] [--states activity]

  solve       shade chains through each baked day, to shade_optimizer/work/solve/
  exhaustive  every shade combination for --cases (state@HH:MM,...), against the optimizer
  verify      Radiance runs of the shipped shade designs (shares the bake's result cache)
  pack        the site's shade data: web/public/data/{city}/{MM}.shades.bin and .json
  report      shade_optimizer/reports/report.md: conventional vs shades vs responsive
  compare     the optimizer's methods (window, gradient, GA) on the same hours: methods.md

--states is 'activity' (the activity states and ambient, the default), 'all', or a comma
list of state ids.
"""

from __future__ import annotations

import argparse

from bake import config

from . import run


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m shade_optimizer", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=("solve", "exhaustive", "verify", "pack", "report",
                                   "compare"))
    p.add_argument("--city", default="houston", help="comma list (solve, verify, report)")
    p.add_argument("--months", default="12", help="comma list; exhaustive takes the first")
    p.add_argument("--states", default="activity")
    p.add_argument("--cases", default="", help="exhaustive: state@HH:MM,...")
    p.add_argument("--batch", type=int, default=2048, help="exhaustive: designs per call")
    p.add_argument("--workers", type=int, default=20, help="verify: Radiance workers")
    p.add_argument("--procs", type=int, default=1, help="solve: solver processes")
    p.add_argument("--force", action="store_true", help="solve: redo finished chains")
    a = p.parse_args(argv)
    cities = a.city.split(",")
    months = [int(m) for m in a.months.split(",")]
    states = run.state_ids(a.states)
    if a.cmd in ("solve", "exhaustive", "verify", "compare"):
        config.keep_awake()
    if a.cmd == "solve":
        run.solve(cities, months, states, procs=a.procs, force=a.force)
    elif a.cmd == "exhaustive":
        if not a.cases:
            p.error("exhaustive needs --cases state@HH:MM,...")
        run.exhaustive(cities[0], months[0], a.cases.split(","), a.batch)
    elif a.cmd == "verify":
        r = run.verify(cities, months, states, a.workers)
        print(f"shade verify: {r['runs']} run(s) in {r['minutes']:.1f} min, "
              f"{len(r['failed'])} failed")
    elif a.cmd == "pack":
        from . import pack

        for c in cities:
            for m in months:
                r = pack.pack_month(c, m)
                print(f"  {c} {m:02d}: {r['slots']} slots x {r['states']} states, "
                      f"{r['bytes'] / 2 ** 20:.2f} MB, Radiance for {r['radiance']} of "
                      f"{r['records']} records")
        print(f"  index: {pack.write_index()}")
    elif a.cmd == "compare":
        sts = run.COMPARE_STATES if a.states == "activity" else tuple(states)
        print(f"compare: {run.compare(cities[0], months[0], sts)}")
    else:
        print(f"report: {run.report(cities, months, states)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
