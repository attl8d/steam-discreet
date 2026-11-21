import type { ReactNode } from 'react';
import { type FilterIconClasses, RevealToggle } from '../../components/RevealToggle';

/**
 * Validates the class names the `reveal-toggle` hook passes from Steam's
 * sidebar CSS module (keys CheckboxWithImage, Active, Disabled in sp.js build
 * 1794536281). Missing classes give an unstyled but working control.
 */
export function filterIconClasses(value: unknown): FilterIconClasses {
	const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
	const str = (x: unknown) => (typeof x === 'string' ? x : '');
	return { button: str(v.button), active: str(v.active), disabled: str(v.disabled) };
}

/** Called from Steam's sidebar header render. Never throws (fail open). */
export function revealToggleSlot(classes: unknown): ReactNode {
	try {
		return <RevealToggle key="steam-discreet-reveal" classes={filterIconClasses(classes)} />;
	} catch (e: unknown) {
		console.error('[steam-discreet] reveal toggle failed', e);
		return null;
	}
}
