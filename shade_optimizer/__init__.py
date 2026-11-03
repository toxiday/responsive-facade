"""Shade optimizer: v3's facade optimizer with roller shades as the design (Tony, 2026-11-02).

The conventional L05 facade of 501.6 (Building Model v2) keeps its seven windows, two on the S
wall and five on the W wall, each eight panel rows tall. Each window gets a top-down roller
shade, and the only design variable is how far each one is lowered. A lowered shade turns the
panel rows it covers into wall, so every design is a binary 4 x 16 x 32 facade of the kind
v3's surrogate takes, scored by v3's own loss and verified by its Radiance scene. Shades are
modelled as opaque (blackout): v3 has no material for fabric that lets some light through.

  shades.py    the windows, and the facade for a set of shade positions (binary and soft)
  optimize.py  the optimizer: v3's surrogate, loss and optimiser over the shades' positions
  run.py       chains through a baked day, the exhaustive check, Radiance, the report
  __main__.py  python -m shade_optimizer {solve, exhaustive, verify, report}

It reuses the bake (bake/) for the solver, slots, targets, Radiance and metrics, so results
compare like for like with the responsive facade's. Importing the package applies the bake's
workspace rules first (bake/config.py: nothing is written outside ResponsiveFacade).
"""

import bake  # noqa: F401  (applies the workspace environment before anything heavy loads)
