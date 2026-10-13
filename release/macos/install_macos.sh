#!/bin/bash
# Install GUILIU for this Mac user (Apple silicon, macOS 12 or later). The package is not signed or notarized, so it
# is for local use: this script clears the download quarantine and signs unsigned binaries locally (ad hoc).
#
#   bash install_macos.sh [--data guiliu-data.tar.gz] [--replace-data]
#
# Run it beside GUILIU-<version>-macos-arm64.tar.gz, or from inside the extracted GUILIU folder. The program and its
# data go to ~/Library/Application Support/GUILIU; ~/Applications/GUILIU.app starts it (Quit stops it). A data package
# (a tar of .runtime/ from another copy) beside the script, or given with --data, is used when this Mac has no data
# yet; --replace-data puts the current data aside first. Installing again keeps this Mac's data.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Library/Application Support/GUILIU"
APP="$HOME/Applications/GUILIU.app"
DATA=""
REPLACE_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="${2:-}"; shift 2 ;;
    --replace-data) REPLACE_DATA=1; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nGUILIU was not installed: %s\n' "$1" >&2; exit 1; }
stamp() { date +%Y%m%d-%H%M%S; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS."
[ "$(uname -m)" = arm64 ] || fail "this package is for Apple silicon Macs (M1 or later)."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 12 ] || fail "macOS 12 or later is required."

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/guiliu-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
if [ -f "$HERE/launch.py" ] && [ -d "$HERE/runtime/python" ]; then
  say "Copying the package from $HERE"
  ditto "$HERE" "$STAGE/GUILIU"
  rm -rf "$STAGE/GUILIU/.runtime"
else
  ARCHIVE="$(ls "$HERE"/GUILIU-*-macos-arm64.tar.gz 2>/dev/null | tail -n 1 || true)"
  [ -n "$ARCHIVE" ] || fail "put GUILIU-<version>-macos-arm64.tar.gz beside this script."
  say "Extracting $(basename "$ARCHIVE")"
  tar -xzf "$ARCHIVE" -C "$STAGE"
fi
NEW="$STAGE/GUILIU"
[ -f "$NEW/current.json" ] && [ -x "$NEW/runtime/python/bin/python3" ] || fail "the package is incomplete."

if [ -z "$DATA" ]; then
  DATA="$(ls "$HERE"/guiliu-data-*.tar.gz 2>/dev/null | tail -n 1 || true)"
fi
if [ -n "$DATA" ]; then
  [ -f "$DATA" ] || fail "data package not found: $DATA"
  # Only .runtime/ may come from a data package.
  OUTSIDE="$(tar -tzf "$DATA" | grep -vE '^(\./)?\.runtime(/|$)' || true)"
  [ -z "$OUTSIDE" ] || fail "$(basename "$DATA") holds files outside .runtime/."
fi

say "Clearing the download quarantine and checking code signatures"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
SIGNED=0
while IFS= read -r -d '' FILE; do
  case "$(head -c 4 "$FILE" | od -An -tx1 | tr -d ' \n')" in
    cffaedfe|cafebabe)
      if ! codesign --verify "$FILE" >/dev/null 2>&1; then
        codesign --force --sign - "$FILE" >/dev/null 2>&1 || fail "could not sign $FILE"
        SIGNED=$((SIGNED + 1))
      fi ;;
  esac
done < <(find "$NEW/runtime" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "Signed locally: $SIGNED file(s)."

PREVIOUS=""
if [ -d "$TARGET" ]; then
  if [ -f "$TARGET/.runtime/processes.json" ]; then
    say "Stopping the running GUILIU"
    (cd "$TARGET" && PYTHONNOUSERSITE=1 runtime/python/bin/python3 -X utf8 -B launch.py stop) || true
    for _ in $(seq 1 60); do
      [ -f "$TARGET/.runtime/processes.json" ] || break
      sleep 1
    done
    [ ! -f "$TARGET/.runtime/processes.json" ] || fail "GUILIU is still running. Quit GUILIU and run the installer again."
  fi
  # The new program takes this Mac's data along; the old program folder is kept aside, not deleted.
  if [ -d "$TARGET/.runtime" ]; then
    mv "$TARGET/.runtime" "$NEW/.runtime"
  fi
  PREVIOUS="$TARGET.replaced-$(stamp)"
  mv "$TARGET" "$PREVIOUS"
fi
mkdir -p "$(dirname "$TARGET")"
mv "$NEW" "$TARGET"

if [ -n "$DATA" ]; then
  if [ -f "$TARGET/.runtime/data/backend.sqlite3" ] && [ "$REPLACE_DATA" != 1 ]; then
    echo "This Mac already has GUILIU data, so it was kept. Run again with --replace-data to use $(basename "$DATA")."
  else
    if [ -d "$TARGET/.runtime" ]; then
      mv "$TARGET/.runtime" "$TARGET/.runtime.replaced-$(stamp)"
      echo "The data that was here is kept in $TARGET/.runtime.replaced-*."
    fi
    say "Importing data from $(basename "$DATA")"
    tar -xzf "$DATA" -C "$TARGET"
    xattr -dr com.apple.quarantine "$TARGET/.runtime" 2>/dev/null || true
  fi
fi

say "Checking the installation"
cd "$TARGET"
export PYTHONNOUSERSITE=1
unset PYTHONPATH PYTHONHOME
PY="$TARGET/runtime/python/bin/python3"
"$PY" -X utf8 -B launch.py verify
VERSION="$("$PY" -I -c 'import json; print(json.load(open("current.json"))["version"])')"
(cd "versions/$VERSION" && "$PY" -X utf8 -B -c 'import sys; sys.path.insert(0, "."); import fastapi, uvicorn, sqlite3, psutil, lancedb, pyarrow, numpy, openai, PIL, primp, cryptography, tiktoken, lxml, regex, backend.system_control; print("Python modules OK")')
echo "Node $("$TARGET/runtime/node/bin/node" --version)"

say "Creating $APP"
cat > "$STAGE/GUILIU.applescript" <<'APPLESCRIPT'
-- GUILIU: starts the local services in the background and opens the browser; clicking the Dock icon opens it
-- again, and Quit stops the services.
on run
	startGuiliu()
end run

on reopen
	startGuiliu()
end reopen

on quit
	try
		do shell script quoted form of (guiliuFolder() & "stop_macos.command") & " >/dev/null 2>&1"
	end try
	continue quit
end quit

on guiliuFolder()
	return (POSIX path of (path to home folder)) & "Library/Application Support/GUILIU/"
end guiliuFolder

on startGuiliu()
	do shell script quoted form of (guiliuFolder() & "start_macos.command") & " --background >/dev/null 2>&1 &"
end startGuiliu
APPLESCRIPT
osacompile -s -o "$STAGE/GUILIU.app" "$STAGE/GUILIU.applescript"
PLIST="$STAGE/GUILIU.app/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string io.github.rhinoqvq.guiliu "$PLIST"
plutil -replace CFBundleName -string GUILIU "$PLIST"
# The applet's own icon would win over applet.icns through its asset catalog.
plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
rm -f "$STAGE/GUILIU.app/Contents/Resources/Assets.car"
"$PY" -I -B - "versions/$VERSION/frontend/assets/app-icon-512.png" "$STAGE/GUILIU.app/Contents/Resources/applet.icns" <<'PYICON'
import sys
from PIL import Image
art = Image.open(sys.argv[1]).convert('RGBA')
side = round(art.width * 1024 / 824)   # macOS icons keep a margin around the artwork
canvas = Image.new('RGBA', (side, side))
canvas.paste(art, ((side - art.width) // 2, (side - art.height) // 2), art)
canvas.resize((1024, 1024), Image.Resampling.LANCZOS).save(sys.argv[2])
PYICON
codesign --force --deep --sign - "$STAGE/GUILIU.app" >/dev/null 2>&1
mkdir -p "$HOME/Applications"
rm -rf "$APP"
mv "$STAGE/GUILIU.app" "$APP"
touch "$APP"

say "GUILIU $VERSION is installed"
echo "Program and data: $TARGET"
echo "Start: $APP (Finder > Go > Home > Applications, or Spotlight). Quit it in the Dock to stop GUILIU."
echo "Logs: $TARGET/.runtime/logs"
if [ -n "$PREVIOUS" ]; then
  echo "The previous program folder is kept at $PREVIOUS; delete it once the new one works."
fi
open "$APP"
