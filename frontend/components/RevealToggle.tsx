import { type ReactNode, useSyncExternalStore } from 'react';
import { adultOnlyToggleView, revealToggleView, type RevealToggleView } from '../domain/revealToggle';
import { getState, setMode, subscribe } from '../services/library';

/** Steam's own class names for the sidebar filter icons, passed in by the `reveal-toggle` hook. */
export interface FilterIconClasses {
	readonly button: string;
	readonly active: string;
	readonly disabled: string;
}

const EyeIcon = ({ open }: { open: boolean }) => (
	<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
		{/* fill="none" on the shapes: Steam's CSS fills `.Filters .CheckboxWithImage svg`, which would override it on the svg. */}
		<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" strokeWidth="2" />
		<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
		{!open && <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2" />}
	</svg>
);

/** "18+". The text takes Steam's svg fill, so it greys and turns blue like the neighbouring icons. */
const AdultOnlyIcon = () => (
	<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
		<text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fontFamily="Arial, sans-serif">
			18+
		</text>
	</svg>
);

function FilterIcon({
	classes,
	view,
	children,
}: {
	classes: FilterIconClasses;
	view: RevealToggleView;
	children: ReactNode;
}) {
	const title = view.warning === null ? view.title : `${view.title}\n\n${view.warning}`;
	const className = [classes.button, view.pressed ? classes.active : '', view.disabled ? classes.disabled : '']
		.filter((c) => c !== '')
		.join(' ');
	const activate = () => {
		if (!view.disabled) setMode(view.next);
	};
	return (
		<div
			className={className}
			role="button"
			aria-pressed={view.pressed}
			aria-disabled={view.disabled}
			aria-label={title}
			title={title}
			style={{ position: 'relative' }}
			tabIndex={0}
			onClick={activate}
			onKeyDown={(e) => {
				if ((e.key === 'Enter' || e.key === ' ') && !view.disabled) {
					e.preventDefault();
					activate();
				}
			}}
		>
			{children}
			{view.warning !== null && (
				<span
					aria-hidden="true"
					style={{ position: 'absolute', top: 0, right: 0, width: 6, height: 6, borderRadius: 3, background: '#e5a00d' }}
				/>
			)}
		</div>
	);
}

/**
 * The show/hide adult games control in the Library sidebar's filter row.
 * Hidden on every start (the mode lives only in services/library.ts).
 */
export function RevealToggle({ classes }: { classes: FilterIconClasses }) {
	const state = useSyncExternalStore(subscribe, getState);
	const view = revealToggleView(state);
	return (
		<FilterIcon classes={classes} view={view}>
			<EyeIcon open={view.pressed || state.mode === 'only'} />
		</FilterIcon>
	);
}

/** The "show only adult games" control, right after the eye. */
export function AdultOnlyToggle({ classes }: { classes: FilterIconClasses }) {
	const state = useSyncExternalStore(subscribe, getState);
	return (
		<FilterIcon classes={classes} view={adultOnlyToggleView(state)}>
			<AdultOnlyIcon />
		</FilterIcon>
	);
}
