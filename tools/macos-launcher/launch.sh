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
# Seconds to wait for Steam Millennium to keep running before falling back.
grace="${STEAM_LAUNCHER_GRACE:-15}"

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

open_plain() {
    say "plain: open -b $valve_id ${url}"
    if [ -n "$url" ]; then
        open -b "$valve_id" "$url"
    else
        open -b "$valve_id"
    fi
}

if steam_running; then
    # Steam is already up (with or without Millennium): hand over the link or
    # bring it to the front the same way Steam.app would.
    if [ -n "$url" ]; then
        open_plain
    elif wrapper_running; then
        say "running under Millennium: activate"
        open -b "$wrapper_id"
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
# missing or broken. Steam itself can restart once while it updates, so only
# fall back if nothing is running at two checks a few seconds apart.
sleep "$grace"
if ! steam_running; then
    sleep 5
    if ! steam_running; then
        say "Steam Millennium did not start within $((grace + 5)) s, starting plain Steam"
        notify "Steam Millennium did not start. Starting Steam without Millennium."
        open_plain
        exit 0
    fi
fi
say "Steam Millennium running"
