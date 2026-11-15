/**
 * Steam App IDs are unsigned 32-bit integers. Anything arriving from Steam or
 * from an imported file is `unknown` until it passes through here.
 */
declare const appIdBrand: unique symbol;
export type AppId = number & { readonly [appIdBrand]: true };

const MAX_APP_ID = 0xffffffff;

export function parseAppId(value: unknown): AppId | null {
	const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > MAX_APP_ID) {
		return null;
	}
	return n as AppId;
}
