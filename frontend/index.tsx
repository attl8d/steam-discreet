import { callable, definePlugin, Field } from 'millennium';
import { Icon } from './components/Icon';

// M1 experiment 1: a hardcoded test set (Factorio). Replaced by the tag store in M3.
const EXPERIMENT_TAGS = new Set<number>([427520]);

/** @ffi Read by the patched collectionStore.BIsVisible. */
export const sdIsTagged = (appId: unknown): boolean => typeof appId === 'number' && EXPERIMENT_TAGS.has(appId);

const probe = callable('sd_diag_probe');

/** @ffi M1 diagnostics, called over CDP. */
export const sdDiagnostics = {
	probe: () => probe(),
};

const SettingsContent = () => <Field label="Steam Discreet" description="M1 diagnostic build. Settings arrive in M5." />;

export default definePlugin(() => {
	console.log('[steam-discreet] frontend loaded');
	return {
		title: 'Steam Discreet',
		icon: <Icon />,
		content: <SettingsContent />,
	};
});
