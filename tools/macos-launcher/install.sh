#!/usr/bin/env bash
# Installs the "Steam" and "Steam (plain)" launcher apps into ~/Applications
# and makes "Steam" the handler for steam:// links. Valve's Steam.app and
# Steam Millennium.app are not modified. Steam can stay running.
#
#   tools/macos-launcher/install.sh              # install or update
#   tools/macos-launcher/install.sh --status     # show what is installed
#   tools/macos-launcher/install.sh --uninstall  # remove both apps, give steam:// back to Steam.app
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="${STEAM_LAUNCHER_DIR:-$HOME/Applications}"
launcher="$dest/Steam.app"
plain="$dest/Steam (plain).app"
launcher_id="io.github.attl8d.steam-launcher"
plain_id="io.github.attl8d.steam-launcher.plain"
valve_app="/Applications/Steam.app"
valve_id="com.valvesoftware.steam"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 1; }
case "$(cd "$(dirname "$launcher")" 2>/dev/null && pwd -P)/Steam.app" in
    "$valve_app")
        echo "refusing to install into $dest: that is where Valve's Steam.app lives" >&2
        exit 1
        ;;
esac

# Sets the default app for the steam:// scheme. LSSetDefaultHandlerForURLScheme
# is deprecated but still the only call that sets a scheme handler without UI.
# Reads the handler back afterwards and fails unless it is the one asked for.
set_handler() {
    local rc now
    rc="$(osascript -l JavaScript -e "ObjC.import('CoreServices'); \$.LSSetDefaultHandlerForURLScheme(\$('steam'), \$('$1'))")"
    now="$(current_handler)"
    # LaunchServices may report the bundle id in another case.
    if [ "$rc" != "0" ] || [ "$(printf '%s' "$now" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "could not set the steam:// handler to $1 (OSStatus $rc, handler now $now)" >&2
        return 1
    fi
}

current_handler() {
    osascript -l JavaScript -e "ObjC.import('CoreServices'); ObjC.unwrap(ObjC.castRefToObject(\$.LSCopyDefaultHandlerForURLScheme(\$('steam'))))" 2>/dev/null || echo "none"
}

status() {
    for app in "$launcher" "$plain"; do
        if [ -d "$app" ]; then echo "installed: $app"; else echo "missing:   $app"; fi
    done
    echo "steam:// handler: $(current_handler)"
    echo "log: $HOME/Library/Logs/SteamLauncher.log"
}

# Our own bundle id, or empty when the path holds something else.
bundle_id() { defaults read "$1/Contents/Info" CFBundleIdentifier 2>/dev/null || true; }

# Removes an app only if it is one of ours; stops otherwise.
remove_ours() {
    local app="$1" id="$2" found
    [ -e "$app" ] || return 0
    found="$(bundle_id "$app")"
    if [ "$found" != "$id" ]; then
        echo "refusing to remove $app: bundle id is '${found:-none}', not $id" >&2
        exit 1
    fi
    "$lsregister" -u "$app" 2>/dev/null || true
    rm -rf "$app"
}

build_app() {
    local source="$1" app="$2" id="$3" url_scheme="$4"
    local plist="$app/Contents/Info.plist"

    remove_ours "$app" "$id"
    osacompile -o "$app" "$source"
    install -m 0755 "$here/launch.sh" "$app/Contents/Resources/launch.sh"

    # Reuse Steam's own icon so the Dock and Spotlight look the same.
    local icon
    icon="$(defaults read "$valve_app/Contents/Info" CFBundleIconFile 2>/dev/null || true)"
    icon="${icon%.icns}"
    if [ -n "$icon" ] && [ -f "$valve_app/Contents/Resources/$icon.icns" ]; then
        cp "$valve_app/Contents/Resources/$icon.icns" "$app/Contents/Resources/applet.icns"
        # An asset-catalog icon would take precedence over applet.icns.
        /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$plist" 2>/dev/null || true
        rm -f "$app/Contents/Resources/Assets.car"
    fi

    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $id" "$plist" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $id" "$plist"
    if [ "$url_scheme" = "yes" ]; then
        /usr/libexec/PlistBuddy \
            -c "Delete :CFBundleURLTypes" "$plist" 2>/dev/null || true
        /usr/libexec/PlistBuddy \
            -c "Add :CFBundleURLTypes array" \
            -c "Add :CFBundleURLTypes:0 dict" \
            -c "Add :CFBundleURLTypes:0:CFBundleURLName string Steam" \
            -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
            -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string steam" \
            "$plist"
    fi

    # Editing Info.plist invalidates osacompile's ad-hoc signature; re-sign.
    codesign --force --deep --sign - "$app"
    "$lsregister" -f "$app"
}

case "${1:-}" in
    --status)
        status
        exit 0
        ;;
    --uninstall)
        set_handler "$valve_id" || echo "warning: steam:// may still point at the launcher until Steam.app is opened once" >&2
        remove_ours "$launcher" "$launcher_id"
        remove_ours "$plain" "$plain_id"
        echo "Removed the launcher apps; steam:// opens Steam.app again."
        status
        exit 0
        ;;
    "") ;;
    *)
        echo "usage: $0 [--status|--uninstall]" >&2
        exit 1
        ;;
esac

[ -d "$valve_app" ] || { echo "Steam.app not found at $valve_app" >&2; exit 1; }
[ "$(defaults read "$valve_app/Contents/Info" CFBundleIdentifier)" = "$valve_id" ] \
    || { echo "Steam.app does not have bundle id $valve_id" >&2; exit 1; }
if [ ! -d "/Applications/Steam Millennium.app" ] && [ ! -d "$HOME/Applications/Steam Millennium.app" ]; then
    echo "warning: Steam Millennium.app not found; the launcher will start plain Steam" >&2
fi

mkdir -p "$dest"
build_app "$here/Steam.applescript" "$launcher" "$launcher_id" yes
build_app "$here/Steam (plain).applescript" "$plain" "$plain_id" no
set_handler "$launcher_id"

echo "Installed. Pin $launcher in the Dock in place of Steam.app."
status
