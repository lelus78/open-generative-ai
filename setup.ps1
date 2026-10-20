<#
.SYNOPSIS
  One-step setup for Open Generative AI (desktop app) on Windows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup.ps1            # app only
  powershell -ExecutionPolicy Bypass -File setup.ps1 -Wan2GP    # app + local video models
  powershell -ExecutionPolicy Bypass -File setup.ps1 -ModelsDir D:\AI\local-ai
#>
param(
    [switch]$Wan2GP,
    # Optional: where engine + models are stored (default: the app data folder)
    [string]$ModelsDir = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Step 'Checking prerequisites'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git not found. Install it with: winget install Git.Git' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js not found. Install it with: winget install OpenJS.NodeJS.LTS  (then open a new terminal)' }
$nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { Fail "Node.js 18+ required (found $(& node -v))." }

Step 'Fetching submodules'
& git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { Fail 'git submodule update failed' }

Step 'Installing dependencies and building (takes a few minutes)'
& npm install
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
& npm run build:packages
if ($LASTEXITCODE -ne 0) { Fail 'npm run build:packages failed' }

Step 'Making sure the Electron binary is present'
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
    & node node_modules\electron\install.js
    if ($LASTEXITCODE -ne 0) { Fail 'Electron download failed' }
}

if ($ModelsDir) {
    Step "Setting models folder: $ModelsDir"
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
    $userData = Join-Path $env:APPDATA 'open-generative-ai'
    New-Item -ItemType Directory -Force -Path $userData | Out-Null
    $json = @{ dir = (Resolve-Path $ModelsDir).Path } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $userData 'local-ai-location.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Wan2GP) {
    & (Join-Path $PSScriptRoot 'scripts\install-wan2gp.ps1')
    if ($LASTEXITCODE -ne 0) { Fail 'Wan2GP setup failed' }
}

Write-Host "`nSetup complete. Start the app with start.bat (or: npm run electron:dev)." -ForegroundColor Green
Write-Host 'In Settings > Local Models you can download Z-Image Turbo (image) and change the storage folder.'
if (-not $Wan2GP) { Write-Host 'For local video models run: setup.ps1 -Wan2GP' }
