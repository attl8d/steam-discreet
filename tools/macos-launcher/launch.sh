#!/usr/bin/env bash
# Starts Steam with Millennium, falling back to plain Steam.
# Called by the "Steam" and "Steam (plain)" launcher apps (see README.md).
#
#   launch.sh millennium [steam://url]   # Steam Millennium, plain Steam if it fails to start
#   launch.sh plain [steam://url]        # Valve's Steam.app, without Millennium
set -uo pipefail

mode="${1:-millennium}"
url="${2:-}"

valve_id="com.valvesoftware.steam"
wrapper_id="com.steamhomebrew.millennium.wrapper"
log="$HOME/Library/Logs/SteamLauncher.log"
# Seconds to wait for Steam Millennium to start before falling back.
grace="${STEAM_LAUNCHER_GRACE:-20}"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$log"; }

notify() {
    osascript -e "display notification \"$1\" with title \"Steam\"" >/dev/null 2>&1 || true
}

find_wrapper() {
    local app
    for app in "/Applications/Steam Millennium.app" "$HOME/Applications/Steam Millennium.app"; do
        if [ -x "$app/Contents/MacOS/steam_osx" ]; then
            printf '%s\n' "$app"
            return 0
        fi
    done
    return 1
}

steam_running() { pgrep -x steam_osx >/dev/null 2>&1; }

# The wrapper keeps its process (it execs steam_osx), so LaunchServices still
# lists it under the wrapper's bundle id while Steam Millennium runs.
wrapper_running() { lsappinfo info -only pid -app "$wrapper_id" 2>/dev/null | grep -q '[0-9]'; }

# Sends a link, or just activates, through the given bundle id.
open_with() {
    say "open -b $1 ${url}"
    if [ -n "$url" ]; then
        open -b "$1" "$url"
    else
        open -b "$1"
    fi
}

open_plain() { open_with "$valve_id"; }

if steam_running; then
    # Steam is already up: hand the link (or the activation) to the app that
    # LaunchServices lists it under, so no second bootstrapper starts.
    if wrapper_running; then
        open_with "$wrapper_id"
    else
        open_plain
    fi
    exit 0
fi

if [ "$mode" = "plain" ]; then
    open_plain
    exit 0
fi

if ! wrapper="$(find_wrapper)"; then
    say "Steam Millennium.app not found, starting plain Steam"
    notify "Steam Millennium is not installed. Starting Steam without Millennium."
    open_plain
    exit 0
fi

say "millennium: open -a $wrapper ${url}"
if [ -n "$url" ]; then
    open -a "$wrapper" --args "$url"
else
    open -a "$wrapper"
fi

# The wrapper exits with an error before starting Steam when its runtime is
# missing or broken. Count Steam as started once steam_osx has been up for
# 3 s in a row, so a quick quit or an update restart does not count as failure.
up=0
for _ in $(seq 1 "$grace"); do
    sleep 1
    if steam_running; then
        up=$((up + 1))
        if [ "$up" -ge 3 ]; then
            say "Steam Millennium running"
            exit 0
        fi
    else
        up=0
    fi
done
if steam_running; then
    say "Steam Millennium still starting after $grace s, leaving it"
    exit 0
fi
say "Steam Millennium did not start within $grace s, starting plain Steam"
notify "Steam Millennium did not start. Starting Steam without Millennium."
open_plain
