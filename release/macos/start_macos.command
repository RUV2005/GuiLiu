#!/bin/bash
# Start GUILIU and open it in the browser. Double-clicked, it runs in this Terminal window (Ctrl+C stops it);
# GUILIU.app starts it with --background instead.
cd "$(dirname "$0")" || exit 1
export PYTHONNOUSERSITE=1
unset PYTHONPATH PYTHONHOME
if [ "${1:-}" = "--background" ]; then
  shift
  mkdir -p .runtime/logs
  exec runtime/python/bin/python3 -X utf8 -B launch.py serve "$@" >> .runtime/logs/app.log 2>&1
fi
exec runtime/python/bin/python3 -X utf8 -B launch.py serve "$@"
