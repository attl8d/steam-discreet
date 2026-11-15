import { describe, expect, test } from 'bun:test';
import { parseAppId } from '../../frontend/domain/appId';

describe('parseAppId', () => {
	test('accepts positive 32-bit integers and numeric strings', () => {
		expect(parseAppId(730)).toBe(730 as never);
		expect(parseAppId('570')).toBe(570 as never);
		expect(parseAppId(0xffffffff)).toBe(0xffffffff as never);
	});

	const invalid: unknown[] = [0, -1, 1.5, 0x100000000, NaN, '', '12a', ' 7', null, undefined, {}, [730]];

	test.each(invalid.map((value) => [value]))('rejects %p', (value) => {
		expect(parseAppId(value)).toBeNull();
	});
});
