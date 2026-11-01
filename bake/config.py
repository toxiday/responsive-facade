"""Single home for every path, constant and environment rule the bake depends on.

Imports nothing beyond the standard library, so `apply_env()` can run before torch or any
v3 module is loaded. Every bake entry point goes through `bake/__init__.py`, which calls it.

Workspace boundary (docs/guidelines.md §0, docs/decisions.md): only `WS` is written to. The
v3 pipeline, Building Model v2 and the renders scripts folder are read-only.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Workspace (the only place anything is written)
# ---------------------------------------------------------------------------

WS = Path(__file__).resolve().parents[1]
EXPECTED_WS = Path(r"C:\Computation Project\ResponsiveFacade")

BAKE = WS / "bake"
WORK = BAKE / "work"
CACHE = WORK / "cache"
REPORTS = BAKE / "reports"
TMP = WS / ".tmp"
VENV = WS / ".venv"
WEB = WS / "web"
WEB_DATA = WEB / "public" / "data"
WEB_FIXTURES = WEB / "src" / "__fixtures__"

# ---------------------------------------------------------------------------
# Read-only sources
# ---------------------------------------------------------------------------

V3 = Path(r"C:\Computation Project\Facade Designer v3")
R = V3 / "allside_Generalised model"
TRAINER = R / "model trainer"
RESPONSIVE = R / "responsive facade"
GEN_PY = R / "data generator" / "generate_dataset_allsides_climate_pit.py"
WEIGHTS = R / "models" / "best_facade_allsides_climate_genroom.pth"
WEIGHTS_SHA256 = "0be1a5710ffbe7cec4b90ae3fe4e598b42892252d43c081270a8bb3940b30e61"
CLIMATE = R / "climate data" / "library"

BMV2 = Path(r"C:\Computation Project\Building Model v2")
UNIT_JSON = BMV2 / "Units" / "501" / "output" / "unit.json"
JOB_501_6 = BMV2 / "Units" / "501" / "output" / "501.6.json"
OPT_501_6_CSV = BMV2 / "Units" / "501" / "output" / "501.6" / "facade_wide.csv"
BASELINE_CSV = BMV2 / "Units" / "conventional L05" / "501.6" / "facade_wide.csv"

RENDERS_SCRIPTS = Path(r"C:\Computation Project\renders\unit 501 views scripts")
FURN_JSON = RENDERS_SCRIPTS / "unit501_furniture.json"
SURVEY_JSON = RENDERS_SCRIPTS / "test4_survey.json"
VIEWS_JSON = RENDERS_SCRIPTS / "test4_living_room_views.json"

READ_ONLY_ROOTS = (V3, BMV2, RENDERS_SCRIPTS)

# ---------------------------------------------------------------------------
# Room 501.6 (cross-checked against unit.json by check_room())
# ---------------------------------------------------------------------------

ROOM_ID = "501.6"
ROOM_W = 5.372487
ROOM_D = 10.498
ROOM_H = 3.0
NORTH_ANGLE = 15.0
SIDES = ("S", "N", "E", "W")
SIDES_OPEN = (True, False, False, True)  # S and W are the exterior walls

# Rhino world (mm) = Rz(+ROT_DEG) . (ORIGIN_MM + 1000 * room_xyz). Filled from VIEWS_JSON.
RHINO_ROT_DEG = 15.0

CITIES = {
    "houston": "USA_TX_Houston-Bush.Intercontinental.AP.722430_TMYx.2011-2025.wea",
    "boston": "USA_MA_Boston-Logan.Intl.AP.725090_TMYx.2011-2025.wea",
    "seattle": "USA_WA_Seattle-Tacoma.Intl.AP.727930_TMYx.2011-2025.wea",
}

# Production solve settings (docs/handoff §6). The optimizer's own glare default is 0.0.
GLARE_WEIGHT = 0.25
GLARE_CAP = 3000.0


def wea_path(city: str) -> Path:
    return CLIMATE / CITIES[city]


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

_ENV_APPLIED = False


def apply_env() -> None:
    """Redirect temp files and caches into the workspace and stop bytecode being written
    next to imported v3 modules. Idempotent. Spawned child processes inherit os.environ."""
    global _ENV_APPLIED
    if _ENV_APPLIED:
        return
    for d in (TMP, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    env = {
        "TEMP": str(TMP),
        "TMP": str(TMP),
        "TMPDIR": str(TMP),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PIP_NO_CACHE_DIR": "1",
        "MPLCONFIGDIR": str(CACHE / "matplotlib"),
        "TORCH_HOME": str(CACHE / "torch"),
        "XDG_CACHE_HOME": str(CACHE),
        "CUDA_CACHE_PATH": str(CACHE / "cuda"),
        "MPLBACKEND": "Agg",
    }
    os.environ.update(env)
    sys.dont_write_bytecode = True
    tempfile.tempdir = str(TMP)
    _ENV_APPLIED = True


def check_venv() -> None:
    """Refuse to run under any interpreter but this repo's .venv (VS Code auto-activates
    Facade Designer V2's venv, which would run the bake against the wrong torch)."""
    if Path(sys.prefix).resolve() != VENV.resolve():
        raise SystemExit(
            f"bake must run with {VENV}\\Scripts\\python.exe (current: {sys.executable})"
        )


def assert_writable(path: os.PathLike | str) -> Path:
    """Return `path` resolved, or raise if it falls outside the workspace."""
    p = Path(path).resolve()
    if not p.is_relative_to(WS.resolve()):
        raise PermissionError(f"refusing to write outside the workspace: {p}")
    for ro in READ_ONLY_ROOTS:
        if p.is_relative_to(ro.resolve()):
            raise PermissionError(f"refusing to write into a read-only source: {p}")
    return p


# ---------------------------------------------------------------------------
# v3 imports
# ---------------------------------------------------------------------------


def import_v3():
    """Import the v3 modules the bake uses and return them as a simple namespace.

    `live_solver` adds `model trainer` to sys.path itself; both folders are added here so the
    import order does not matter."""
    apply_env()
    for p in (TRAINER, RESPONSIVE):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    import types

    import live_solver
    import optimize_facade_allsides_climate as opt
    import seed_sweep
    import verify_facade_radiance as vfr

    return types.SimpleNamespace(live_solver=live_solver, opt=opt, seed_sweep=seed_sweep, vfr=vfr)


# ---------------------------------------------------------------------------
# Checks and provenance
# ---------------------------------------------------------------------------


def check_room() -> dict:
    """Confirm the room constants match Building Model v2's unit.json."""
    unit = json.loads(UNIT_JSON.read_text())
    room = next(r for r in unit["rooms"] if r["name"] == ROOM_ID)
    problems = []
    for key, want in (("width", ROOM_W), ("depth", ROOM_D), ("height", ROOM_H),
                      ("north_angle", NORTH_ANGLE)):
        if abs(float(room[key]) - want) > 1e-6:
            problems.append(f"{key}: unit.json {room[key]} != config {want}")
    sides = tuple(s in room["sides"] for s in SIDES)
    if sides != SIDES_OPEN:
        problems.append(f"sides: unit.json {room['sides']!r} != config {SIDES_OPEN}")
    if room["origin_uv"] != [0.0, 0.0]:
        problems.append(f"origin_uv {room['origin_uv']} (furniture uv would need offsetting)")
    if problems:
        raise ValueError("room 501.6 mismatch: " + "; ".join(problems))
    return room


def rhino_origin_mm() -> tuple[float, float, float]:
    views = json.loads(VIEWS_JSON.read_text())
    v = next(e for e in views if e["room"] == ROOM_ID)
    return (float(v["OX"]), float(v["OY"]), float(v["OZ"]))


def v3_commit() -> dict:
    """Read v3's checked-out commit from its .git files (never runs git there)."""
    git = V3 / ".git"
    head = (git / "HEAD").read_text().strip()
    if not head.startswith("ref: "):
        return {"ref": None, "commit": head}
    ref = head[5:]
    ref_file = git / ref
    if ref_file.exists():
        return {"ref": ref, "commit": ref_file.read_text().strip()}
    packed = git / "packed-refs"
    if packed.exists():
        for line in packed.read_text().splitlines():
            if line.endswith(" " + ref):
                return {"ref": ref, "commit": line.split()[0]}
    return {"ref": ref, "commit": None}


def weights_sha256() -> str:
    """SHA-256 of the checkpoint, cached against (size, mtime) under bake/work/cache."""
    st = WEIGHTS.stat()
    key = f"{st.st_size}:{st.st_mtime_ns}"
    cache = CACHE / "weights_sha256.json"
    try:
        cached = json.loads(cache.read_text())
        if cached.get("key") == key:
            return cached["sha256"]
    except (OSError, ValueError):
        pass
    h = hashlib.sha256()
    with open(WEIGHTS, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"key": key, "sha256": digest}))
    return digest


def provenance() -> dict:
    """What produced a bake. torch details are added by callers that have imported it."""
    sha = weights_sha256()
    return {
        "pipeline": str(R),
        "pipeline_git": v3_commit(),
        "weights": WEIGHTS.name,
        "weights_sha256": sha,
        "weights_sha256_ok": sha == WEIGHTS_SHA256,
        "python": sys.version.split()[0],
    }
