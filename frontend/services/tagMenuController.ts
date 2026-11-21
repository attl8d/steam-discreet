import type { AppId } from '../domain/appId';
import { decideTagMenu, failureMessage, type TagMenuAction } from '../domain/tagMenu';

/**
 * The part of frontend/services/library.ts (owned by the library-hiding work)
 * that the context menu uses. tagGames/untagGames reject when the save fails.
 */
export interface TagLibrary {
	tagGames(ids: readonly AppId[]): Promise<void>;
	untagGames(ids: readonly AppId[]): Promise<void>;
	isTagged(id: AppId): boolean;
	getState(): { readonly ready: boolean };
}

export type ReportFailure = (message: string) => void;

export function menuActionFor(library: TagLibrary, selection: readonly AppId[] | null): TagMenuAction {
	return decideTagMenu({
		selection,
		isTagged: (id) => library.isTagged(id),
		ready: library.getState().ready,
	});
}

/**
 * Runs the chosen action. Resolves to true when the save was confirmed, and
 * to false after reporting the failure. Never throws.
 */
export async function runMenuAction(library: TagLibrary, action: TagMenuAction, report: ReportFailure): Promise<boolean> {
	if (action.kind === 'disabled') return false;
	try {
		if (action.kind === 'mark') await library.tagGames(action.ids);
		else await library.untagGames(action.ids);
		return true;
	} catch (e: unknown) {
		report(failureMessage(action.kind, action.ids.length, e instanceof Error ? e.message : ''));
		return false;
	}
}
