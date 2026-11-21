-- "Steam": starts Steam with Millennium. Hold Option while opening it to start plain Steam.
use AppleScript version "2.4"
use framework "AppKit"
use scripting additions

on launchSteam(theURL)
	set optionHeld to ((current application's NSEvent's modifierFlags()) div 524288) mod 2 is 1
	if optionHeld then
		set theMode to "plain"
	else
		set theMode to "millennium"
	end if
	set helper to POSIX path of (path to resource "launch.sh")
	do shell script quoted form of helper & " " & theMode & " " & quoted form of theURL & " >/dev/null 2>&1 &"
end launchSteam

on run
	launchSteam("")
end run

on open location theURL
	launchSteam(theURL)
end open location
