import { findModuleExport } from 'millennium';
import { looksLikeObservable, type ReactiveSignal, signalFromObservable } from './reactiveSignal';

/** Steam's mobx, or null when it cannot be found (live refresh then unavailable). */
export function createSteamSignal(): ReactiveSignal | null {
	let observable: unknown;
	try {
		observable = findModuleExport((e: unknown) => looksLikeObservable(e)) as unknown;
	} catch {
		return null;
	}
	return signalFromObservable(observable);
}
