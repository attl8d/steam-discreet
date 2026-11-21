import type { ReactNode } from 'react';
import { RevealToggle } from '../../components/RevealToggle';
import { filterIconClasses } from './filterIconClasses';

/** Called from Steam's sidebar header render. Never throws (fail open). */
export function revealToggleSlot(classes: unknown): ReactNode {
	try {
		return <RevealToggle key="steam-discreet-reveal" classes={filterIconClasses(classes)} />;
	} catch (e: unknown) {
		console.error('[steam-discreet] reveal toggle failed', e);
		return null;
	}
}
