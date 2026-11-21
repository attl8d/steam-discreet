/**
 * Copies text in the window that shows the settings page. Steam's own UI does
 * the same: `ownerWindow.navigator.clipboard.writeText`, and a selected
 * textarea with `document.execCommand("copy")` where that is unavailable
 * (read from sp.js, build 1794536281). Resolves to false when neither worked,
 * so the caller can show the text for copying by hand.
 */
export async function copyText(text: string, ownerWindow: unknown = globalThis): Promise<boolean> {
	const clipboard = prop(prop(ownerWindow, 'navigator'), 'clipboard');
	const writeText = prop(clipboard, 'writeText');
	if (typeof writeText === 'function') {
		try {
			await (writeText as (this: unknown, t: string) => Promise<void>).call(clipboard, text);
			return true;
		} catch {
			// Not focused or not allowed: fall through to the textarea route.
		}
	}
	return copyWithTextarea(text, prop(ownerWindow, 'document'));
}

function copyWithTextarea(text: string, doc: unknown): boolean {
	if (typeof doc !== 'object' || doc === null || !('createElement' in doc)) return false;
	const d = doc as Document;
	let area: HTMLTextAreaElement | null = null;
	try {
		area = d.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		d.body.appendChild(area);
		area.select();
		// Deprecated, but it is what Steam's own fallback uses in this browser.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		return d.execCommand('copy');
	} catch {
		return false;
	} finally {
		area?.remove();
	}
}

function prop(obj: unknown, key: string): unknown {
	if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
	try {
		return (obj as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}
