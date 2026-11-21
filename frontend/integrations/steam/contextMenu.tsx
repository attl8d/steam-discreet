import { MenuItem, toaster } from 'millennium';
import type { ReactNode } from 'react';
import type { AppId } from '../../domain/appId';
import { installedLibrary, menuActionFor, runMenuAction } from '../../services/tagMenuController';
import { parseSelection } from './selection';

/**
 * The games a context menu acts on, from the `rgApps` argument the
 * `game-context-menu` hook passes in: the array GetTargetApps() returns, app
 * overviews with a numeric `appid` (sp.js build 1794536281, see
 * docs/research.md). Non-Steam shortcuts and mods are unsupported in v1
 * (PLAN.md), so any of them makes the selection unknown and the item disabled.
 */
export function selectionFromMenuApps(rgApps: unknown): AppId[] | null {
	if (!Array.isArray(rgApps)) return null;
	const ids: unknown[] = [];
	for (const app of rgApps as unknown[]) {
		if (typeof app !== 'object' || app === null) return null;
		const overview = app as { appid?: unknown; BIsModOrShortcut?: unknown };
		if (typeof overview.BIsModOrShortcut !== 'function') return null;
		const isShortcut: unknown = (overview.BIsModOrShortcut as () => unknown).call(app);
		if (isShortcut !== false) return null;
		ids.push(overview.appid);
	}
	return parseSelection(ids);
}

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
