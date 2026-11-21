import { describe, expect, test } from 'bun:test';
import { parseAccountId } from '../../frontend/domain/accountId';
import type { AppId } from '../../frontend/domain/appId';
import { decodeAppIdList, encodeAppIdList } from '../../frontend/domain/appIdList';

const ids = (...n: number[]) => n as AppId[];

describe('App ID list wire format', () => {
	test('encodes sorted and deduplicated', () => {
		expect(encodeAppIdList(ids(730, 570, 730))).toBe('570,730');
		expect(encodeAppIdList([])).toBe('');
	});

	test('decodes all or nothing', () => {
		expect(decodeAppIdList('570,730')).toEqual(ids(570, 730));
		expect(decodeAppIdList('')).toEqual([]);
		expect(decodeAppIdList('570,,730')).toBeNull();
		expect(decodeAppIdList('570,x')).toBeNull();
		expect(decodeAppIdList(570)).toBeNull();
		expect(decodeAppIdList({})).toBeNull();
	});
});

describe('parseAccountId', () => {
	test('accepts SteamID64 strings only', () => {
		expect(parseAccountId('76561198000000001')).toBe('76561198000000001' as never);
		for (const bad of ['', '0', '../x', '7656119800000000a', 7.6e16, null, '123456789012345678901']) {
			expect(parseAccountId(bad)).toBeNull();
		}
	});
});
