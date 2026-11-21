#!/usr/bin/env bash
# Restart Steam on macOS through Millennium's wrapper app with CDP on localhost:8080.
#
# On macOS, Millennium is a separate launcher ("Steam Millennium.app") that
# starts Steam with Millennium injected; Steam.app itself is not modified.
# `-dev` makes the launcher pass `-devtools-port 8080` and create (and later
# remove) `.cef-enable-remote-debugging` beside steam_osx, so there is no flag
# file to manage by hand as on Windows.
#
#   scripts/restart-steam-mac.sh            # Millennium output is discarded (needs bun)
#   scripts/restart-steam-mac.sh steam.log  # Millennium and patch-engine output go to steam.log
set -euo pipefail

app="${MILLENNIUM_APP:-/Applications/Steam Millennium.app}"
log="${1:-/dev/null}"
cdp="$(cd "$(dirname "$0")" && pwd)/cdp.ts"

if ! command -v bun >/dev/null; then
    echo "bun not found on PATH (needed for the readiness check)" >&2
    exit 1
fi

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

# The SharedJSContext target appears a few seconds before Steam's stores are
# populated, so also wait until the Library has apps before reporting ready.
# Each probe is bounded: curl by --max-time, the cdp.ts call by its own
# timeouts and, as a backstop, a 10 s alarm.
ready() {
    local targets count
    targets="$(curl -fs --max-time 2 http://127.0.0.1:8080/json 2>/dev/null)" || return 1
    [[ "$targets" == *SharedJSContext* ]] || return 1
    count="$(CDP_TIMEOUT_MS=5000 CDP_EVAL_TIMEOUT_MS=5000 \
        perl -e 'alarm shift; exec @ARGV' 10 bun "$cdp" eval "String(globalThis.appStore?.allApps?.length ?? 0)" 2>/dev/null)" || return 1
    [[ "$count" =~ ^[1-9] ]]
}

start=$SECONDS
while (( SECONDS - start < 180 )); do
    if ready; then
        echo "Steam ready after $(( SECONDS - start )) s"
        exit 0
    fi
    sleep 1
done
echo "Steam not ready after 180 s (is Steam signed in? see the log for Millennium errors)" >&2
exit 1
