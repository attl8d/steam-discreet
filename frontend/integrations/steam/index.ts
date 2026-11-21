import type { LibraryPort } from '../../services/library';
import { readCurrentAccount } from './account';
import { clearCollectionCounts } from './collectionCounts';
import { seenHooks } from './hookMarkers';
import { createSteamSignal } from './steamMobx';

/** The live Steam client, as the library service sees it. */
export function steamLibraryPort(): LibraryPort {
	return {
		currentAccount: () => readCurrentAccount(),
		createSignal: () => createSteamSignal(),
		clearCounts: () => clearCollectionCounts(),
		seenHooks: () => seenHooks(),
	};
}
