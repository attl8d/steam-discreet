import { useSyncExternalStore } from 'react';
import { revealToggleView } from '../domain/revealToggle';
import { getState, setRevealed, subscribe } from '../services/library';

/** Steam's own class names for the sidebar filter icons, passed in by the `reveal-toggle` hook. */
export interface FilterIconClasses {
	readonly button: string;
	readonly active: string;
	readonly disabled: string;
}

const EyeIcon = ({ open }: { open: boolean }) => (
	<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
		<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
		<circle cx="12" cy="12" r="3" />
		{!open && <line x1="3" y1="21" x2="21" y2="3" />}
	</svg>
);

/**
 * The show/hide adult games control in the Library sidebar's filter row.
 * Off on every start (the state lives only in services/library.ts).
 */
export function RevealToggle({ classes }: { classes: FilterIconClasses }) {
	const state = useSyncExternalStore(subscribe, getState);
	const view = revealToggleView(state);
	const title = view.warning === null ? view.title : `${view.title}\n\n${view.warning}`;
	const className = [classes.button, view.pressed ? classes.active : '', view.disabled ? classes.disabled : '']
		.filter((c) => c !== '')
		.join(' ');
	return (
		<div
			className={className}
			role="button"
			aria-pressed={view.pressed}
			aria-disabled={view.disabled}
			aria-label={title}
			title={title}
			style={{ position: 'relative' }}
			onClick={() => {
				if (!view.disabled) setRevealed(!view.pressed);
			}}
		>
			<EyeIcon open={view.pressed} />
			{view.warning !== null && (
				<span
					aria-hidden="true"
					style={{ position: 'absolute', top: 0, right: 0, width: 6, height: 6, borderRadius: 3, background: '#e5a00d' }}
				/>
			)}
		</div>
	);
}
