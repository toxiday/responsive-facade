# Dot-source before any work in this repo:
#   . "C:\Computation Project\ResponsiveFacade\tools\env.ps1"
# Keeps temp files, caches and tool lookups inside the workspace (guidelines §0).

$WS = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $WS '.tmp'
$cache = Join-Path $WS 'bake\work\cache'
New-Item -ItemType Directory -Force $tmp, $cache | Out-Null

$env:RF_WS = $WS
$env:TEMP = $tmp
$env:TMP = $tmp
$env:TMPDIR = $tmp

$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PIP_NO_CACHE_DIR = '1'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:MPLCONFIGDIR = Join-Path $cache 'matplotlib'
$env:TORCH_HOME = Join-Path $cache 'torch'
$env:XDG_CACHE_HOME = $cache
$env:CUDA_CACHE_PATH = Join-Path $cache 'cuda'

$env:npm_config_cache = Join-Path $WS '.tools\npm-cache'
$env:NPM_CONFIG_USERCONFIG = Join-Path $WS '.tools\npmrc'
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:NODE_REPL_HISTORY = ''
$env:GH_NO_UPDATE_NOTIFIER = '1'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $WS '.tools\ms-playwright'

# Drop any other activated venv (VS Code auto-activates Facade Designer V2's).
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
$keep = $env:Path -split ';' | Where-Object {
    $_ -and
    $_ -notmatch '\\Facade Designer [Vv][23]\\\.venv' -and
    $_ -notmatch '\\ResponsiveFacade\\(\.venv|\.tools)'
}
$env:Path = (@((Join-Path $WS '.venv\Scripts'), (Join-Path $WS '.tools\node')) + $keep) -join ';'
