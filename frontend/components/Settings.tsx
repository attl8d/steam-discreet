import { Field, ToggleField } from 'millennium';
import { useSyncExternalStore } from 'react';
import { getState, setRevealed, subscribe } from '../services/library';

const STATUS: Record<'ok' | 'checking' | 'warning', string> = {
	ok: 'All hooks attached.',
	checking: 'Checking hooks.',
	warning: 'A hook failed.',
};

/**
 * Minimal settings for now (the full page is separate work). The switch is
 * the way to reveal tagged games when the sidebar toggle does not appear,
 * for example after a Steam update moved the code it attaches to.
 */
export function SettingsContent() {
	const state = useSyncExternalStore(subscribe, getState);
	return (
		<>
			<ToggleField
				label="Show adult games"
				description="Same as the eye icon in the Library sidebar. Off again after every Steam start."
				checked={state.revealed}
				disabled={!state.ready}
				onChange={(on) => {
					setRevealed(on);
				}}
			/>
			<Field label="Status" description={state.warning ?? STATUS[state.seamStatus]} />
		</>
	);
}
