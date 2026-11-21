/**
 * What the two sidebar icons next to the Games filter show: the eye (show or
 * hide adult games) and "18+" (show only adult games). Pure; the state comes
 * from frontend/services/library.ts. The mode is never persisted.
 */
export type SeamStatus = 'ok' | 'checking' | 'warning';
export type ViewMode = 'hidden' | 'all' | 'only';

export interface RevealToggleInput {
	readonly ready: boolean;
	readonly mode: ViewMode;
	/** At least one game is tagged. */
	readonly hasTags: boolean;
	readonly seamStatus: SeamStatus;
}

export interface RevealToggleView {
	readonly pressed: boolean;
	readonly disabled: boolean;
	/** Tooltip and accessible name. */
	readonly title: string;
	/** Shown on the control when a hook failed and tagged games may be showing. */
	readonly warning: string | null;
	/** The mode a click switches to. */
	readonly next: ViewMode;
}

const WARNING =
	'Steam Discreet could not attach to part of the Library after a Steam update, so some tagged games may be showing. Your tag list is safe. Open the plugin settings for a diagnostic report.';

const LOADING = 'Steam Discreet is loading your tags';

/** The eye: pressed while every game is shown. From "only adult games" it shows everything. */
export function revealToggleView({ ready, mode, seamStatus }: RevealToggleInput): RevealToggleView {
	const warning = seamStatus === 'warning' ? WARNING : null;
	if (!ready) return { pressed: false, disabled: true, title: LOADING, warning, next: 'hidden' };
	const pressed = mode === 'all';
	return {
		pressed,
		disabled: false,
		title: pressed ? 'Hide adult games' : 'Show adult games',
		warning,
		next: pressed ? 'hidden' : 'all',
	};
}

/**
 * "18+": pressed while only tagged games are shown. Disabled until the tags
 * load and while nothing is tagged, so it can never empty the Library. The hook
 * warning is shown on the eye only, not twice.
 */
export function adultOnlyToggleView({ ready, mode, hasTags }: RevealToggleInput): RevealToggleView {
	if (!ready) return { pressed: false, disabled: true, title: LOADING, warning: null, next: 'hidden' };
	const pressed = mode === 'only';
	if (!pressed && !hasTags) {
		return {
			pressed: false,
			disabled: true,
			title: 'Show only adult games (mark a game as adult first)',
			warning: null,
			next: 'hidden',
		};
	}
	return {
		pressed,
		disabled: false,
		title: pressed ? 'Show all games except adult games' : 'Show only adult games',
		warning: null,
		next: pressed ? 'hidden' : 'only',
	};
}
