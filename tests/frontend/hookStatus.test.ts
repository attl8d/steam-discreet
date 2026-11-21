import { describe, expect, test } from 'bun:test';
import { evaluateSelfCheck, isHookAttached, parseManifest, readMarkers } from '../../frontend/services/hookStatus';
import type { HookManifest } from '../../frontend/services/hookStatus';

const manifest: HookManifest = {
	version: 1,
	expected: [
		{ id: 'sidebar', description: 'sidebar seam', runs: 'startup', file: 'a', find: 'x' },
		{ id: 'search', description: 'search seam', runs: 'startup', file: 'b', find: 'y' },
		{ id: 'menu', description: 'context menu', runs: 'on_demand', file: 'c', find: 'z' },
	],
	rejected: [],
	error: null,
};

describe('evaluateSelfCheck', () => {
	test('ok when every hook reported', () => {
		const check = evaluateSelfCheck(manifest, new Set(['sidebar', 'search', 'menu']), true);
		expect(check.overall).toBe('ok');
		expect(check.hooks.map((h) => h.state)).toEqual(['attached', 'attached', 'attached']);
		expect(isHookAttached(check, 'search')).toBe(true);
	});

	test('checking, not warning, while the grace period runs', () => {
		const check = evaluateSelfCheck(manifest, new Set(['sidebar']), false);
		expect(check.overall).toBe('checking');
		expect(isHookAttached(check, 'search')).toBe(false);
	});

	test('a hook that never reported is missing, says what it looked for, and raises the warning', () => {
		const check = evaluateSelfCheck(manifest, new Set(['sidebar']), true);
		expect(check.overall).toBe('warning');
		expect(check.hooks[1]).toMatchObject({ id: 'search', state: 'missing', lookingFor: { file: 'b', find: 'y' } });
		expect(isHookAttached(check, 'search')).toBe(false);
	});

	test('an on_demand hook that has not run yet is not-seen and does not warn', () => {
		const check = evaluateSelfCheck(manifest, new Set(['sidebar', 'search']), true);
		expect(check.overall).toBe('ok');
		expect(check.hooks[2]).toMatchObject({ id: 'menu', state: 'not-seen', reason: null });
		expect(isHookAttached(check, 'menu')).toBe(false);
	});

	test('rejected definitions and a broken definitions file raise the warning at once', () => {
		const rejected = evaluateSelfCheck({ ...manifest, rejected: [{ id: 'extra', reason: 'bad' }] }, new Set(['sidebar', 'search']), false);
		expect(rejected.overall).toBe('warning');
		expect(rejected.hooks.at(-1)).toMatchObject({ id: 'extra', state: 'rejected', reason: 'bad' });

		const broken = evaluateSelfCheck({ ...manifest, expected: [], error: 'syntax error' }, new Set(), false);
		expect(broken.overall).toBe('warning');
		expect(broken.loadError).toBe('syntax error');
	});

	test('markers for unknown hooks are ignored', () => {
		const check = evaluateSelfCheck(manifest, new Set(['sidebar', 'search', 'menu', 'other']), true);
		expect(check.hooks).toHaveLength(3);
	});
});

describe('readMarkers', () => {
	test('reads ids set to 1 and ignores anything else', () => {
		expect([...readMarkers({ a: 1, b: 2, c: '1' })]).toEqual(['a']);
		expect(readMarkers(undefined).size).toBe(0);
		expect(readMarkers([1]).size).toBe(0);
	});
});

describe('parseManifest', () => {
	test('accepts the backend shape, including Lua empty tables as {}', () => {
		expect(parseManifest({ version: 1, expected: {}, rejected: {} })).toEqual({ version: 1, expected: [], rejected: [], error: null });
		expect(parseManifest(manifest)).toEqual(manifest);
	});

	test.each([
		[null],
		[{}],
		[{ version: 1, expected: [{ id: 1 }], rejected: [] }],
		[{ version: 1, expected: [{ id: 'a', description: 'd', runs: 'sometimes', file: 'f', find: 'x' }], rejected: [] }],
		[{ version: 1, expected: [], rejected: [], error: 3 }],
	])('rejects %p', (value) => {
		expect(parseManifest(value)).toBeNull();
	});
});
