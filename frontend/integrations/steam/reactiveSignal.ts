/**
 * A counter that Steam's own mobx tracks.
 *
 * Steam caches every collection's `visibleApps` in a keepAlive mobx computed,
 * so changing what the patched BIsVisible returns does not refresh the Library
 * by itself (docs/research.md, "Reactivity"). If our hide check reads a box
 * from Steam's mobx instance, each computed that calls BIsVisible depends on
 * the box, and bumping it recomputes exactly those lists, in place, the same
 * way Steam refreshes them when the native Hidden set changes.
 *
 * Steam's mobx is webpack module 89193 on build 1794536281 (mobx 6). Its
 * export names are minified, so `observable` is found by shape: a function
 * with `box` and `array` functions on it (confirmed live in M1). Steam sets
 * `enforceActions: "never"`, so setting the box outside an action is allowed.
 */
export interface ReactiveSignal {
	/** Read inside a mobx derivation to depend on the signal. */
	read(): void;
	/** Recompute every derivation that read the signal. */
	bump(): void;
}

interface MobxBox {
	get(): unknown;
	set(value: number): void;
}

type BoxFactory = (initial: number) => unknown;

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === 'function';
}

/** True for a mobx `observable` export: a function with `box` and `array` on it. */
export function looksLikeObservable(value: unknown): boolean {
	if (!isFunction(value)) return false;
	const v = value as unknown as Record<string, unknown>;
	return isFunction(v.box) && isFunction(v.array);
}

function isBox(value: unknown): value is MobxBox {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return isFunction(v.get) && isFunction(v.set);
}

/** Wraps a mobx `observable` export. Exported for tests. */
export function signalFromObservable(observable: unknown): ReactiveSignal | null {
	if (!looksLikeObservable(observable)) return null;
	const factory = (observable as { box: BoxFactory }).box;
	let box: unknown;
	try {
		box = factory(0);
	} catch {
		return null;
	}
	if (!isBox(box)) return null;
	const b = box;
	let n = 0;
	return {
		read: () => {
			b.get();
		},
		bump: () => {
			n += 1;
			b.set(n);
		},
	};
}
