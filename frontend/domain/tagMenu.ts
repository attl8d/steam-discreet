import type { AppId } from './appId';

/**
 * What the "Mark as adult" / "Unmark as adult" context-menu item does for a
 * selection. Pure: the Steam side resolves the selection, this decides.
 *
 * - `null` selection means Steam's selected App IDs could not be determined
 *   reliably, so the item is shown disabled rather than guessing (PLAN.md,
 *   Tagging).
 * - A selection where every game is tagged offers Unmark; anything else
 *   (none or some tagged) offers Mark, which tags the rest.
 * - Before the account's tags have loaded, or while storage refuses edits,
 *   the item is disabled so a click can never look saved when it is not.
 */
export type TagMenuAction =
	| { readonly kind: 'mark'; readonly label: string; readonly ids: readonly AppId[] }
	| { readonly kind: 'unmark'; readonly label: string; readonly ids: readonly AppId[] }
	| { readonly kind: 'disabled'; readonly label: string; readonly reason: DisabledReason };

export type DisabledReason = 'unknown_selection' | 'empty_selection' | 'not_ready';

export const MARK_LABEL = 'Mark as adult';
export const UNMARK_LABEL = 'Unmark as adult';

export interface TagMenuInput {
	/** Deduplicated by this function; `null` when it could not be determined. */
	readonly selection: readonly AppId[] | null;
	readonly isTagged: (id: AppId) => boolean;
	/** False until the account's tags are loaded and writable. */
	readonly ready: boolean;
}

export function decideTagMenu({ selection, isTagged, ready }: TagMenuInput): TagMenuAction {
	if (selection === null) return { kind: 'disabled', label: MARK_LABEL, reason: 'unknown_selection' };
	const ids = [...new Set(selection)];
	if (ids.length === 0) return { kind: 'disabled', label: MARK_LABEL, reason: 'empty_selection' };
	const untagged = ids.filter((id) => !isTagged(id));
	const label = untagged.length === 0 ? UNMARK_LABEL : MARK_LABEL;
	if (!ready) return { kind: 'disabled', label, reason: 'not_ready' };
	if (untagged.length === 0) return { kind: 'unmark', label, ids };
	return { kind: 'mark', label, ids: untagged };
}

/** One-line message for a failed save, shown instead of a silent success. */
export function failureMessage(kind: 'mark' | 'unmark', count: number, detail: string): string {
	const what = count === 1 ? 'this game' : `${String(count)} games`;
	const verb = kind === 'mark' ? 'mark' : 'unmark';
	const tail = detail.trim() === '' ? '' : ` ${detail.trim()}`;
	return `Steam Discreet could not ${verb} ${what} as adult. Nothing was changed.${tail}`;
}
