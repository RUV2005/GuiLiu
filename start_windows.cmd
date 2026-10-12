@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\python\python.exe" (
  "runtime\python\python.exe" -X utf8 -B run.py serve %*
  if errorlevel 1 pause
  exit /b
)
if not exist ".venv\Scripts\python.exe" (
  echo Run install_windows.ps1 first. Python 3.13 x64 and Node.js 22+ are required.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -B run.py serve %*
if errorlevel 1 pause
