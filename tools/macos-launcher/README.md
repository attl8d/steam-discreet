# Steam launcher for macOS

Makes "Steam" start Steam with Millennium, with plain Steam one click away.

On macOS, Millennium is a separate app, `Steam Millennium.app` (see `../millennium-macos`). Valve's `Steam.app` still starts Steam without Millennium, and so do `steam://` links and Steam's own "start at login" option. This folder builds two small AppleScript apps in `~/Applications`:

- **Steam** (Steam's icon): starts `Steam Millennium.app`. If Steam is not running 20 s later (the wrapper exits early when its runtime is missing or broken), it starts plain Steam and shows a notification. Hold **Option** while opening it to start plain Steam. It is also the handler for `steam://` links: with Steam running they are passed to Steam.app as before, otherwise Steam Millennium starts with the link.
- **Steam (plain)**: starts Valve's Steam without Millennium. If Steam is running with Millennium, it offers to quit it and restart it without.

Valve's `Steam.app`, Steam's files and `Steam Millennium.app` are not modified, so Steam and Millennium updates do not undo anything. Neither app can tell that the Library is broken while Steam is running (that would need Steam's debug port always open); use **Steam (plain)** for that.

```sh
tools/macos-launcher/install.sh              # install or update; Steam can stay running
tools/macos-launcher/install.sh --status
tools/macos-launcher/install.sh --uninstall  # remove both apps, give steam:// back to Steam.app
```

After installing:

1. Drag `~/Applications/Steam.app` to the Dock and remove Valve's Steam icon.
2. In Steam, Settings, Interface, turn off "Run Steam when my computer starts", then add `~/Applications/Steam.app` under System Settings, General, Login Items.

Log: `~/Library/Logs/SteamLauncher.log`.

## To check live

- Steam restarts itself after a client update. Check whether it comes back with Millennium (the plugin loads) or plain.
- A `steam://` link while Steam Millennium runs reaches it (for example `open steam://open/downloads`).
- A `steam://` link with Steam closed starts Steam Millennium and opens the link.
