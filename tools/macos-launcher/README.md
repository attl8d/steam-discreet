# Steam launcher for macOS

Makes "Steam" start Steam with Millennium, with plain Steam one click away.

On macOS, Millennium is a separate app, `Steam Millennium.app` (see `../millennium-macos`). Valve's `Steam.app` still starts Steam without Millennium, and so do `steam://` links and Steam's own "start at login" option. This folder builds two small AppleScript apps in `~/Applications`:

- **Steam** (Steam's icon): starts `Steam Millennium.app`. If Steam has not stayed up for 3 s in a row within 20 s (the wrapper exits early when its runtime is missing or broken), it starts plain Steam and shows a notification. Hold **Option** while opening it to start plain Steam. It is also the handler for `steam://` links: with Steam running they go to the app it runs under (the wrapper, or Steam.app for plain Steam), otherwise Steam Millennium starts with the link.
- **Steam (plain)**: starts Valve's Steam without Millennium. If Steam is running with Millennium, it offers to quit it and restart it without.

Valve's `Steam.app`, Steam's files and `Steam Millennium.app` are not modified, so Steam and Millennium updates do not undo anything. Neither app can tell that the Library is broken while Steam is running (that would need Steam's debug port always open); use **Steam (plain)** for that.

```sh
tools/macos-launcher/install.sh              # install or update; Steam can stay running
tools/macos-launcher/install.sh --status
tools/macos-launcher/install.sh --uninstall  # remove both apps (only if they are ours), give steam:// back to Steam.app
```

After installing:

1. Drag `~/Applications/Steam.app` to the Dock and remove Valve's Steam icon. If you start Steam from Spotlight: both apps are called Steam and Spotlight shows only the one opened most (Valve's). Hide Valve's in System Settings, Spotlight, Search Privacy: click +, press Cmd-Shift-G and add `/Applications/Steam.app`. `install.sh` opens that page and shows Steam.app in Finder when it is still indexed, and `--status` reports it. Steam.app itself is not changed; remove the entry to undo. This can't be scripted: macOS has no supported API for Spotlight exclusions, and App Management blocks even `chflags hidden` on Steam.app.
2. In Steam, Settings, Interface, turn off "Run Steam when my computer starts", then add `~/Applications/Steam.app` under System Settings, General, Login Items.

Log: `~/Library/Logs/SteamLauncher.log`.

## To check live

- Steam restarts itself after a client update. Check whether it comes back with Millennium (the plugin loads) or plain.
- A `steam://` link while Steam Millennium runs reaches it (for example `open steam://open/downloads`).
- A `steam://` link with Steam closed starts Steam Millennium and opens the link (passed to the wrapper as argv).
- `lsappinfo info -app com.steamhomebrew.millennium.wrapper` lists the running client after the wrapper's `execv`; the launcher relies on this to route links and activation.
- Steam does not take the `steam://` handler back when it starts (`install.sh --status`).
- Which app Spotlight and `open -a Steam` pick now that two apps are called Steam.
