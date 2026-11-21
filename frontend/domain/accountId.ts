/**
 * A Steam account as the tag store knows it: the SteamID64 as a decimal
 * string. Kept as a string so no 64-bit number conversion is ever needed.
 * Where the value comes from in the live client is decided in
 * `frontend/integrations/steam/` once M1 has confirmed the source.
 */
declare const accountIdBrand: unique symbol;
export type AccountId = string & { readonly [accountIdBrand]: true };

export function parseAccountId(value: unknown): AccountId | null {
	if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || /^0+$/.test(value)) {
		return null;
	}
	return value as AccountId;
}
