#!/bin/bash
# Stop this copy's GUILIU services (Quit in GUILIU.app does the same).
cd "$(dirname "$0")" || exit 1
export PYTHONNOUSERSITE=1
unset PYTHONPATH PYTHONHOME
if [ ! -f .runtime/processes.json ]; then
  echo "GUILIU is not running."
  exit 0
fi
exec runtime/python/bin/python3 -X utf8 -B launch.py stop
