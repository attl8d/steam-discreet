import { parseAccountId, type AccountId } from '../../domain/accountId';

/**
 * The signed-in Steam account, from `App.m_CurrentUser.strSteamID`
 * (SharedJSContext). Confirmed on the live client, build 1794536281: a string
 * holding the SteamID64. It is absent until Steam has finished logging in, so
 * callers poll. See docs/research.md, "Globals confirmed in SharedJSContext".
 */
export function readCurrentAccount(root: unknown = globalThis): AccountId | null {
	const app = prop(root, 'App');
	const user = prop(app, 'm_CurrentUser');
	return parseAccountId(prop(user, 'strSteamID'));
}

function prop(obj: unknown, key: string): unknown {
	if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
	try {
		return (obj as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}
