/**
 * What the reveal toggle next to the Games filter shows. Pure; the state comes
 * from frontend/services/library.ts. The toggle itself is never persisted.
 */
export type SeamStatus = 'ok' | 'checking' | 'warning';

export interface RevealToggleInput {
	readonly ready: boolean;
	readonly revealed: boolean;
	readonly seamStatus: SeamStatus;
}

export interface RevealToggleView {
	readonly pressed: boolean;
	readonly disabled: boolean;
	/** Tooltip and accessible name. */
	readonly title: string;
	/** Shown on the control when a hook failed and tagged games may be showing. */
	readonly warning: string | null;
}

const WARNING =
	'Steam Discreet could not attach to part of the Library after a Steam update, so some tagged games may be showing. Your tag list is safe. Open the plugin settings for a diagnostic report.';

export function revealToggleView({ ready, revealed, seamStatus }: RevealToggleInput): RevealToggleView {
	const warning = seamStatus === 'warning' ? WARNING : null;
	if (!ready) {
		return { pressed: false, disabled: true, title: 'Steam Discreet is loading your tags', warning };
	}
	return {
		pressed: revealed,
		disabled: false,
		title: revealed ? 'Hide adult games' : 'Show adult games',
		warning,
	};
}
