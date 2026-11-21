import type { ReactNode } from 'react';
import { definePlugin } from 'millennium';
import { Icon } from './components/Icon';
import { SettingsContent } from './components/Settings';
import { steamLibraryPort } from './integrations/steam';
import { readAppName, readSteamBuild } from './integrations/steam/clientInfo';
import { tagMenuItem } from './integrations/steam/contextMenu';
import { revealToggleSlot } from './integrations/steam/revealToggleSlot';
import { installLibrary, LibraryService, parseViewMode } from './services/library';
import { installSettings, millenniumSettingsBackend, SettingsService } from './services/settings';
import { millenniumTagRpc, TagStorage } from './services/tagStorage';

const storage = new TagStorage(millenniumTagRpc());
const library = new LibraryService(storage, {
	...steamLibraryPort(),
	hookManifest: () => backend.steam_discreet_hook_manifest(),
});
installLibrary(library);
const settings = new SettingsService(storage, library, millenniumSettingsBackend(), {
	steamBuild: () => readSteamBuild(),
	appName: (appId) => readAppName(appId),
});
installSettings(settings);
// Start now, not in definePlugin, so the signal exists before Steam first
// computes its Library lists (see services/library.ts).
library.start();

/**
 * @ffi Called by Steam's patched collectionStore.BIsVisible (hook
 * `library-visibility`) for every game. True hides the game.
 */
export const sdShouldHide = (appId: unknown): boolean => library.shouldHide(appId);

/**
 * @ffi The library API, for the CDP live check (scripts/live/m3-cycle.js) and
 * diagnostics. The same functions the menu and toggle use.
 */
export const sdLibrary = {
	getState: () => library.getState(),
	isTagged: (appId: number) => library.isTagged(appId),
	isRevealed: () => library.isRevealed(),
	setRevealed: (on: unknown) => {
		library.setRevealed(on === true);
	},
	getMode: () => library.getMode(),
	/** Returns false if refused ("only" before the tags load or with nothing tagged). */
	setMode: (mode: unknown) => {
		const m = parseViewMode(mode);
		return m !== null && library.setMode(m);
	},
	tagGames: (appIds: readonly number[]) => library.tagGames(appIds),
	untagGames: (appIds: readonly number[]) => library.untagGames(appIds),
};

/**
 * @ffi The diagnostic report, the same text as "Copy diagnostic report" in
 * settings, so a repair session can read it over CDP (scripts/live/settings-check.js).
 */
export const sdDiagnostics = {
	report: () => settings.diagnosticReport(),
};

/**
 * @ffi Called by Steam's patched game context menu (hook `game-context-menu`)
 * with the games the menu acts on. Returns the Mark/Unmark as adult item.
 */
export const sdTagMenuItem = (rgApps: unknown): ReactNode => tagMenuItem(rgApps);

/**
 * @ffi Called by Steam's patched Library sidebar header (hook `reveal-toggle`)
 * with Steam's filter-icon class names. Returns the reveal toggle.
 */
export const sdRevealToggle = (classes: unknown): ReactNode => revealToggleSlot(classes);

export default definePlugin(() => ({
	title: 'Steam Discreet',
	icon: <Icon />,
	content: <SettingsContent />,
}));
