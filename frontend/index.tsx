import { definePlugin, Field } from 'millennium';
import { Icon } from './components/Icon';

const SettingsContent = () => <Field label="Steam Discreet" description="Settings arrive in M5." />;

export default definePlugin(() => ({
	title: 'Steam Discreet',
	icon: <Icon />,
	content: <SettingsContent />,
}));
