import { definePlugin, Field } from 'millennium';
import { Icon } from './components/Icon';
import { steamLibraryPort } from './integrations/steam';
import { installLibrary, LibraryService } from './services/library';
import { millenniumTagRpc, TagStorage } from './services/tagStorage';

const library = new LibraryService(new TagStorage(millenniumTagRpc()), {
	...steamLibraryPort(),
	hookManifest: () => backend.steam_discreet_hook_manifest(),
});
installLibrary(library);
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
	tagGames: (appIds: readonly number[]) => library.tagGames(appIds),
	untagGames: (appIds: readonly number[]) => library.untagGames(appIds),
};

const SettingsContent = () => <Field label="Steam Discreet" description="Settings arrive in M5." />;

export default definePlugin(() => ({
	title: 'Steam Discreet',
	icon: <Icon />,
	content: <SettingsContent />,
}));
