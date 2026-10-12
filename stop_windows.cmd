@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\python\python.exe" (
  "runtime\python\python.exe" -X utf8 -B run.py stop
) else (
  ".venv\Scripts\python.exe" -B run.py stop
)
if errorlevel 1 pause
