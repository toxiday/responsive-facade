# Source before any work in this repo (Git Bash):
#   source "/c/Computation Project/ResponsiveFacade/tools/env.sh"
# Keeps temp files, caches and tool lookups inside the workspace (guidelines §0).

RF_WS_POSIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RF_WS="$(cygpath -w "$RF_WS_POSIX")"
export RF_WS
mkdir -p "$RF_WS_POSIX/.tmp" "$RF_WS_POSIX/bake/work/cache"

export TEMP="$RF_WS\\.tmp" TMP="$RF_WS\\.tmp" TMPDIR="$RF_WS\\.tmp"

export PYTHONDONTWRITEBYTECODE=1
export PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
export MPLCONFIGDIR="$RF_WS\\bake\\work\\cache\\matplotlib"
export TORCH_HOME="$RF_WS\\bake\\work\\cache\\torch"
export XDG_CACHE_HOME="$RF_WS\\bake\\work\\cache"
export CUDA_CACHE_PATH="$RF_WS\\bake\\work\\cache\\cuda"

export npm_config_cache="$RF_WS\\.tools\\npm-cache"
export NPM_CONFIG_USERCONFIG="$RF_WS\\.tools\\npmrc"
export npm_config_update_notifier=false npm_config_fund=false
export NODE_REPL_HISTORY=""
export GH_NO_UPDATE_NOTIFIER=1
export PLAYWRIGHT_BROWSERS_PATH="$RF_WS\\.tools\\ms-playwright"

# Drop any other activated venv (VS Code auto-activates Facade Designer V2's).
unset VIRTUAL_ENV
PATH="$(printf '%s' "$PATH" | tr ':' '\n' \
  | grep -v -E '/Facade Designer [Vv][23]/\.venv|/ResponsiveFacade/(\.venv|\.tools)' \
  | paste -sd ':' -)"
export PATH="$RF_WS_POSIX/.venv/Scripts:$RF_WS_POSIX/.tools/node:$PATH"
