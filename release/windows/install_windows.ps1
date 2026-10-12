param([string]$Python = "")
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not $Python) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $Python = (& py -3.13 -c "import sys; print(sys.executable)" | Select-Object -Last 1)
    }
    if (-not $Python -and (Get-Command python -ErrorAction SilentlyContinue)) {
        $Python = (Get-Command python).Source
    }
}
if (-not $Python) { throw "Install Python 3.13 x64, or pass -Python with its python.exe path." }
& $Python -c "import sys,struct; assert sys.version_info[:2] == (3,13) and struct.calcsize('P') == 8, 'Python 3.13 x64 is required'"
if ($LASTEXITCODE -ne 0) { throw "Python 3.13 x64 is required." }

if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the local virtual environment." }
}
$LocalPython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath 'MANIFEST.json') {
    & $LocalPython -B launch.py verify
    if ($LASTEXITCODE -ne 0) { throw "Release integrity check failed." }
}
if (Test-Path -LiteralPath 'requirements-offline.txt') {
    & $LocalPython -m pip --isolated install --no-index --find-links wheelhouse --require-hashes -r requirements-offline.txt
} else {
    & $LocalPython -m pip --isolated install -r requirements.txt
}
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
& $LocalPython -m pip check
if ($LASTEXITCODE -ne 0) { throw "Dependency validation failed." }
Write-Host 'Installation complete. Install Node.js 22+ if needed, then run start_windows.cmd.'
