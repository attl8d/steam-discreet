-- "Steam (plain)": starts Valve's Steam without Millennium. If Steam is already
-- running with Millennium, offers to quit it and start it again without Millennium.
use AppleScript version "2.4"
use scripting additions

on run
	set helper to POSIX path of (path to resource "launch.sh")
	set underMillennium to (do shell script "lsappinfo info -only pid -app com.steamhomebrew.millennium.wrapper | grep -c '[0-9]' || true") is not "0"
	if underMillennium then
		display dialog "Steam is running with Millennium. Quit it and start Steam without Millennium?" buttons {"Cancel", "Restart without Millennium"} default button 2 with title "Steam (plain)"
		do shell script "open 'steam://exit'; for i in $(seq 1 60); do pgrep -x steam_osx >/dev/null || exit 0; sleep 1; done; exit 1"
	end if
	do shell script quoted form of helper & " plain '' >/dev/null 2>&1 &"
end run
