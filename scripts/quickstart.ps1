# GameSaloon quickstart (Windows PowerShell). Needs Node >= 22.18 and git (unless run inside a checkout).
# Env: GAMESALOON_REPO (clone source, needed outside a checkout), GAMESALOON_DIR (default .\gamesaloon), PORT (default 8787).
$ErrorActionPreference = 'Stop'
$port = if ($env:PORT) { $env:PORT } else { '8787' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node >= 22.18 is required (https://nodejs.org)' }
$v = [version](node -v).TrimStart('v')
if ($v -lt [version]'22.18.0') { throw "Node >= 22.18 required, found $v" }

$root = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { $null }
if ($root -and (Test-Path "$root\package.json") -and (Test-Path "$root\src")) {
  Set-Location $root
} else {
  if (-not $env:GAMESALOON_REPO) { throw 'set $env:GAMESALOON_REPO to the git url' }
  $dir = if ($env:GAMESALOON_DIR) { $env:GAMESALOON_DIR } else { 'gamesaloon' }
  if (-not (Test-Path "$dir\.git")) { git clone --depth 1 $env:GAMESALOON_REPO $dir; if ($LASTEXITCODE) { throw 'clone failed' } }
  Set-Location $dir
}

npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install failed' }
npm run build; if ($LASTEXITCODE) { throw 'build failed' }
$env:PORT = $port
$p = Start-Process node -ArgumentList 'dist/main.js' -NoNewWindow -PassThru
try {
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    try { $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; $ok = $true } catch { Start-Sleep 1 }
  }
  if (-not $ok) { throw 'health check failed' }
  Write-Host "Health: $($h | ConvertTo-Json -Compress)"
  Write-Host "GameSaloon is up: ws://127.0.0.1:$port/ws   (Ctrl+C to stop)"
  Write-Host "Try: node examples/hello-client.mjs ws://127.0.0.1:$port/ws"
  $p.WaitForExit()
} finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
