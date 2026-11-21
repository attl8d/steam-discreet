import { MenuItem, toaster } from 'millennium';
import type { ReactNode } from 'react';
import { installedLibrary, menuActionFor, runMenuAction } from '../../services/tagMenuController';
import { selectionFromMenuApps } from './selection';

function reportFailure(message: string): void {
	try {
		toaster.toast({ title: 'Steam Discreet', body: message, critical: true });
	} catch (e: unknown) {
		console.error('[steam-discreet]', message, e);
	}
}

/**
 * Called from Steam's context menu render. Never throws: anything unexpected
 * leaves Steam's menu as it was (fail open).
 */
export function tagMenuItem(rgApps: unknown): ReactNode {
	try {
		const action = menuActionFor(installedLibrary, selectionFromMenuApps(rgApps));
		return (
			<MenuItem
				key="steam-discreet-tag"
				disabled={action.kind === 'disabled'}
				onSelected={() => {
					void runMenuAction(installedLibrary, action, reportFailure);
				}}
			>
				{action.label}
			</MenuItem>
		);
	} catch (e: unknown) {
		console.error('[steam-discreet] context menu item failed', e);
		return null;
	}
}
