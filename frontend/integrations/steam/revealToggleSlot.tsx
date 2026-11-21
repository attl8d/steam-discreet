import type { ReactNode } from 'react';
import { AdultOnlyToggle, RevealToggle } from '../../components/RevealToggle';
import { filterIconClasses } from './filterIconClasses';

/**
 * Called from Steam's sidebar header render (hook `reveal-toggle`). Returns the
 * eye and the "18+" icon as one array child of Steam's icon row, each keyed.
 * Never throws (fail open).
 */
export function revealToggleSlot(classes: unknown): ReactNode {
	try {
		const c = filterIconClasses(classes);
		return [
			<RevealToggle key="steam-discreet-reveal" classes={c} />,
			<AdultOnlyToggle key="steam-discreet-adult-only" classes={c} />,
		];
	} catch (e: unknown) {
		console.error('[steam-discreet] reveal toggle failed', e);
		return null;
	}
}
