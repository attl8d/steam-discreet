import type { Environment, UpdateStatus } from './backendInfo';
import type { HookState, SelfCheck } from './hookStatus';
import type { LibraryState } from './library';
import type { StorageState } from './tagStorage';

/**
 * The "Copy diagnostic report" text (docs/PLAN.md, M5): versions, per-hook
 * status, what each hook that is not attached was looking for, tag storage
 * health and the updater's last results. It is meant to be pasted into an LLM
 * session with "fix it", next to the repair guide in CLAUDE.md.
 *
 * It never contains game names, App IDs, the tag list, the tag count or the
 * Steam account. Paths in error messages have the user folder and any
 * SteamID64 replaced. Pure: the caller gathers the inputs.
 */

export interface DiagnosticInput {
	readonly generatedAt: Date;
	readonly environment: Environment | null;
	readonly steamBuild: string | null;
	readonly library: LibraryState;
	readonly selfCheck: SelfCheck;
	readonly storage: { readonly state: StorageState; readonly writable: boolean; readonly reason: string | null } | null;
	readonly update: UpdateStatus | null;
}

export const HOOK_STATE_TEXT: Record<HookState, string> = {
	attached: 'attached',
	checking: 'checking (Steam has not run this code yet)',
	missing: 'MISSING',
	'not-seen': 'not seen yet (runs only when that part of Steam is opened)',
	rejected: 'REJECTED',
};

export function buildDiagnosticReport(input: DiagnosticInput): string {
	const lines: string[] = [];
	const env = input.environment;
	lines.push('# Steam Discreet diagnostic report', '');
	lines.push(`Generated: ${input.generatedAt.toISOString()}`, '');

	lines.push('## Versions');
	lines.push(`- Plugin: ${env?.pluginVersion ?? 'unknown'}`);
	lines.push(`- Millennium: ${env?.millenniumVersion ?? 'unknown'}`);
	lines.push(`- Steam client build: ${input.steamBuild ?? 'unknown'}`);
	lines.push(`- OS: ${env?.os ?? 'unknown'}${env !== null && env.arch !== null ? ` (${env.arch})` : ''}`);
	if (env === null) lines.push('- (The backend did not answer, so plugin and Millennium versions are unknown.)');
	lines.push('');

	lines.push('## Status');
	lines.push(`- Overall: ${input.library.seamStatus}`);
	if (input.library.warning !== null) lines.push(`- Warning shown on the toggle: ${clean(input.library.warning)}`);
	lines.push(`- Tags loaded: ${input.library.ready ? 'yes' : 'no'}`);
	if (input.storage === null) {
		lines.push('- Tag storage: not opened');
	} else {
		lines.push(`- Tag storage: ${input.storage.state}, ${input.storage.writable ? 'writable' : 'read-only'}`);
		if (input.storage.reason !== null) lines.push(`- Tag storage note: ${clean(input.storage.reason)}`);
	}
	lines.push('');

	const check = input.selfCheck;
	lines.push('## Hooks');
	lines.push(`- Self-check: ${check.overall}`);
	if (check.loadError !== null) lines.push(`- hook_definitions.lua failed to load: ${clean(check.loadError)}`);
	if (check.hooks.length === 0) lines.push('- No hooks are active.');
	for (const hook of check.hooks) {
		lines.push(`- ${hook.id}: ${HOOK_STATE_TEXT[hook.state]}`);
		if (hook.reason !== null) lines.push(`  - Reason: ${clean(hook.reason)}`);
		if (hook.lookingFor !== null) {
			lines.push(`  - Looking for file: \`${hook.lookingFor.file}\``);
			lines.push(`  - Looking for code: \`${hook.lookingFor.find}\``);
		}
	}
	lines.push('');

	lines.push('## Updates');
	const u = input.update;
	if (u === null) {
		lines.push('- Updater status unavailable (the backend did not answer).');
	} else if (u.error !== null) {
		lines.push(`- Updater failed to start: ${clean(u.error)}`);
	} else {
		lines.push(`- Source: ${u.source ?? 'unknown'}`);
		lines.push(`- Last check: ${u.lastCheckAt === null ? 'never' : `${iso(u.lastCheckAt)}, ${u.lastResult ?? 'unknown result'}`}`);
		if (u.lastError !== null) lines.push(`- Last check error: ${clean(u.lastError)}`);
		if (u.lastApplyError !== null) lines.push(`- Last install error: ${clean(u.lastApplyError)}`);
		if (u.lastApplied !== null) {
			const kind = u.lastApplied.rollback ? 'rolled back' : 'updated';
			const at = u.lastApplied.at === null ? '' : ` at ${iso(u.lastApplied.at)}`;
			lines.push(`- Last install: ${kind} ${u.lastApplied.from} -> ${u.lastApplied.to}${at}`);
		}
		if (u.stagedVersion !== null) lines.push(`- Waiting to install at next Steam start: ${u.stagedVersion}`);
		if (u.previousVersion !== null) lines.push(`- Previous version kept for rollback: ${u.previousVersion}`);
		if (u.skipVersion !== null) lines.push(`- Skipped version (rolled back): ${u.skipVersion}`);
	}
	lines.push('');
	lines.push('Repair guide: CLAUDE.md in https://github.com/attl8d/steam-discreet');
	return lines.join('\n');
}

function iso(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return Number.isNaN(d.getTime()) ? String(unixSeconds) : d.toISOString();
}

/** Removes personal parts of error text: user folder names and SteamID64s. */
export function clean(text: string): string {
	return text
		.replace(/([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/\s'"]+/gi, '$1<user>')
		.replace(/(\/(?:Users|home)\/)[^/\s'"]+/g, '$1<user>')
		.replace(/\b7656119\d{10}\b/g, '<steamid>')
		.replace(/\s+/g, ' ')
		.trim();
}
