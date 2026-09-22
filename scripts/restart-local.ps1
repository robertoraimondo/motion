param(
  [switch]$StartLtx,
  [switch]$StartComfy,
  [switch]$StartVite
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$ports = @(41954, 41955, 8188, 5173)

function Test-RelatedProcess($process) {
  $commandLine = [string]$process.CommandLine
  return (
    $commandLine.Contains($projectRoot) -or
    $commandLine.Contains('ComfyUI\main.py') -or
    $commandLine.Contains('ltx2_server.py') -or
    $commandLine.Contains('ltx-bridge.mjs') -or
    $commandLine.Contains('LTX Desktop.exe') -or
    $commandLine.Contains('vite.js')
  )
}

$processes = Get-CimInstance Win32_Process | Where-Object { Test-RelatedProcess $_ }
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 700

$remaining = $null
for ($attempt = 0; $attempt -lt 10; $attempt++) {
  $remaining = Get-CimInstance Win32_Process | Where-Object { Test-RelatedProcess $_ }
  if (-not $remaining) { break }
  Start-Sleep -Milliseconds 300
}
if ($remaining) {
  $remaining | ForEach-Object { Write-Error "Process still active: $($_.ProcessId) $($_.Name)" }
  exit 1
}

$occupied = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
if ($occupied) {
  $occupied | ForEach-Object { Write-Error "Port still occupied: $($_.LocalPort) by PID $($_.OwningProcess)" }
  exit 1
}

Write-Host 'All local motion servers and related processes are stopped.'

if ($StartLtx) {
  $ltxPython = 'C:\Users\Roy\AppData\Local\LTXDesktop\python\python.exe'
  $ltxBackend = 'C:\Users\Roy\AppData\Local\Programs\LTX Desktop\resources\backend'
  if (-not (Test-Path $ltxPython)) { throw "LTX Python not found: $ltxPython" }
  if (-not (Test-Path (Join-Path $projectRoot 'scripts\ltx-bridge.mjs'))) { throw 'LTX bridge not found.' }
  $logDirectory = Join-Path $projectRoot 'logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $ltxLog = Join-Path $logDirectory 'ltx-server.log'
  $ltxErrorLog = Join-Path $logDirectory 'ltx-server.error.log'
  Remove-Item $ltxLog -Force -ErrorAction SilentlyContinue
  Remove-Item $ltxErrorLog -Force -ErrorAction SilentlyContinue
  $ltxOutputDirectory = 'D:\Videos\videocreation\outputs'
  New-Item -ItemType Directory -Path $ltxOutputDirectory -Force | Out-Null
  $env:LTX_APP_DATA_DIR = 'C:\Users\Roy\AppData\Local\LTXDesktop'
  $env:LTX_AUTH_TOKEN = 'motion-local-token'
  $env:LTX_ADMIN_TOKEN = 'motion-local-admin'
  $env:LTX_PORT = '41954'
  Start-Process -FilePath $ltxPython -ArgumentList @('-u', (Join-Path $projectRoot 'scripts\ltx-server.py')) -WorkingDirectory $ltxBackend -RedirectStandardOutput $ltxLog -RedirectStandardError $ltxErrorLog | Out-Null
  Start-Process -FilePath 'node.exe' -ArgumentList 'scripts\ltx-bridge.mjs' -WorkingDirectory $projectRoot | Out-Null
}

if ($StartComfy) {
  $python = Join-Path $projectRoot 'ComfyUI\.venv\Scripts\python.exe'
  $arguments = 'ComfyUI\main.py --listen 127.0.0.1 --port 8188 --enable-cors-header --lowvram --reserve-vram 1'
  Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $projectRoot | Out-Null
}

if ($StartVite) {
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run dev -- --host 127.0.0.1' -WorkingDirectory $projectRoot | Out-Null
}

if ($StartLtx -or $StartComfy -or $StartVite) {
  Write-Host 'Requested servers are starting in separate processes.'
}
