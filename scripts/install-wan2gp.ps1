<#
.SYNOPSIS
  Installs (or updates) Wan2GP for the local video models and links it to the app.

.DESCRIPTION
  - clones Wan2GP (or pulls updates if the folder already exists)
  - creates <folder>\venv with Python 3.11
  - installs PyTorch (CUDA build chosen from your NVIDIA driver) + requirements
  - saves the folder in the app settings, so Video Studio works without further setup

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-wan2gp.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-wan2gp.ps1 -Dir D:\AI\Wan2GP
#>
param(
    [string]$Dir = (Join-Path $HOME 'Wan2GP')
)

$ErrorActionPreference = 'Stop'
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Step 'Checking prerequisites'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git not found. Install it with: winget install Git.Git' }
if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { Fail 'No NVIDIA GPU/driver found (nvidia-smi missing). Wan2GP local video needs an NVIDIA GPU.' }

$py = $null
try { $py = (& py -3.11 -c 'import sys; print(sys.executable)' 2>$null) } catch { }
if (-not $py) { Fail 'Python 3.11 not found. Install it with: winget install Python.Python.3.11  (then re-run this script)' }
Write-Host "Python: $py"

$driver = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader | Select-Object -First 1).Trim()
$driverMajor = [int]($driver.Split('.')[0])
Write-Host "NVIDIA driver: $driver"
if ($driverMajor -ge 580) {
    $torchPkgs = @('torch==2.10.0', 'torchvision==0.25.0', 'torchaudio==2.10.0')
    $torchIndex = 'https://download.pytorch.org/whl/cu130'
} else {
    Write-Host 'Driver older than 580: using the CUDA 12.8 build (update your driver for best results).' -ForegroundColor Yellow
    $torchPkgs = @('torch==2.7.1', 'torchvision==0.22.1', 'torchaudio==2.7.1')
    $torchIndex = 'https://download.pytorch.org/whl/cu128'
}

Step "Wan2GP folder: $Dir"
if (Test-Path (Join-Path $Dir 'wgp.py')) {
    Write-Host 'Existing install found - updating code (fast-forward only).'
    & git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host 'Could not update automatically (local changes?) - continuing with the current version.' -ForegroundColor Yellow }
} else {
    & git clone https://github.com/deepbeepmeep/Wan2GP.git $Dir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
}

Step 'Creating Python environment'
$venvPy = Join-Path $Dir 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    & $py -m venv (Join-Path $Dir 'venv')
    if ($LASTEXITCODE -ne 0) { Fail 'venv creation failed' }
}
& $venvPy -m pip install --upgrade pip

Step 'Installing PyTorch (several GB, this takes a while)'
& $venvPy -m pip install @torchPkgs --index-url $torchIndex
if ($LASTEXITCODE -ne 0) { Fail 'PyTorch install failed' }

Step 'Installing Wan2GP requirements'
& $venvPy -m pip install -r (Join-Path $Dir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Fail 'requirements install failed' }

Step 'Verifying GPU access'
& $venvPy -c "import torch; print('torch', torch.__version__, '| CUDA available:', torch.cuda.is_available()); raise SystemExit(0 if torch.cuda.is_available() else 1)"
if ($LASTEXITCODE -ne 0) { Fail 'PyTorch cannot see the GPU. Update the NVIDIA driver and re-run.' }

Step 'Linking Wan2GP to the app'
$cfgDir = Join-Path $env:APPDATA 'open-generative-ai\local-ai'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfgFile = Join-Path $cfgDir 'wan2gp.json'
$cfg = [ordered]@{ dir = (Resolve-Path $Dir).Path; python = ''; url = '' }
[System.IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Saved $cfgFile"

Write-Host "`nDone. Start the app and pick a Wan2GP model in Video Studio." -ForegroundColor Green
Write-Host 'Model weights download automatically the first time each model is used.'
