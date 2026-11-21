#!/usr/bin/env bash
# Restart Steam on macOS through Millennium's wrapper app with CDP on localhost:8080.
#
# On macOS, Millennium is a separate launcher ("Steam Millennium.app") that
# starts Steam with Millennium injected; Steam.app itself is not modified.
# `-dev` makes the launcher pass `-devtools-port 8080` and create (and later
# remove) `.cef-enable-remote-debugging` beside steam_osx, so there is no flag
# file to manage by hand as on Windows.
#
#   scripts/restart-steam-mac.sh            # Millennium output is discarded
#   scripts/restart-steam-mac.sh steam.log  # Millennium and patch-engine output go to steam.log
set -euo pipefail

app="${MILLENNIUM_APP:-/Applications/Steam Millennium.app}"
log="${1:-/dev/null}"

if [ ! -x "$app/Contents/MacOS/steam_osx" ]; then
    echo "Millennium wrapper app not found at $app (set MILLENNIUM_APP)" >&2
    exit 1
fi

if pgrep -x steam_osx >/dev/null; then
    open "steam://exit"
    for _ in $(seq 1 60); do
        pgrep -x steam_osx >/dev/null || break
        sleep 1
    done
    if pgrep -x steam_osx >/dev/null; then
        echo "Steam did not quit within 60 s" >&2
        exit 1
    fi
fi

nohup "$app/Contents/MacOS/steam_osx" -dev >"$log" 2>&1 &

for t in $(seq 1 120); do
    if curl -fs --max-time 2 http://127.0.0.1:8080/json 2>/dev/null | grep -q SharedJSContext; then
        echo "CDP ready after ${t} s"
        exit 0
    fi
    sleep 1
done
echo "CDP not reachable after 120 s" >&2
exit 1
