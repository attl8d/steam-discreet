import { DialogButton, Field, TextField, ToggleField } from 'millennium';
import { Component, type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppId } from '../domain/appId';
import { copyText } from '../integrations/steam/clipboard';
import { canRollBack, type UpdateStatus } from '../services/backendInfo';
import type { HookState } from '../services/hookStatus';
import { getState, setMode, subscribe } from '../services/library';
import { type ActionResult, installedSettings, type SettingsService, type SettingsView } from '../services/settings';

/**
 * The plugin's settings page (docs/PLAN.md, "Settings page"). It uses no
 * Library hook, so it keeps working when every hook has failed. Each section
 * sits in its own error boundary: one failing section never hides the others.
 */

const STATUS: Record<'ok' | 'checking' | 'warning', string> = {
	ok: 'All hooks attached.',
	checking: 'Checking hooks.',
	warning: 'A hook failed.',
};

const HOOK_LABEL: Record<HookState, string> = {
	attached: 'Working',
	checking: 'Checking',
	missing: 'Not found in this Steam version',
	'not-seen': 'Not used yet this session',
	rejected: 'Turned off: invalid definition',
};

/** Shown at most this many rows at once; the search narrows the rest. */
const MAX_ROWS = 200;

const buttonStyle: CSSProperties = { width: 'auto', minWidth: 120, padding: '0 16px', marginLeft: 8 };
const textAreaStyle: CSSProperties = {
	width: '100%',
	boxSizing: 'border-box',
	minHeight: 96,
	fontFamily: 'monospace',
	fontSize: 12,
	background: 'rgba(0, 0, 0, 0.3)',
	color: 'inherit',
	border: '1px solid rgba(255, 255, 255, 0.15)',
	borderRadius: 2,
	padding: 8,
	resize: 'vertical',
};

export function SettingsContent() {
	const settings = installedSettings();
	return (
		<>
			<Section name="Show adult games">
				<RevealSection />
			</Section>
			{settings === null ? (
				<Field label="Steam Discreet is not loaded" description="Restart Steam. If this stays, copy the Millennium logs." />
			) : (
				<>
					<Section name="Undo">
						<UndoSection settings={settings} />
					</Section>
					<Section name="Tagged games">
						<TagsSection settings={settings} />
					</Section>
					<Section name="Export and import">
						<TransferSection settings={settings} />
					</Section>
					<Section name="Hooks and diagnostics">
						<DiagnosticsSection settings={settings} />
					</Section>
					<Section name="Updates">
						<UpdatesSection settings={settings} />
					</Section>
				</>
			)}
		</>
	);
}

/** The switches are the way to change the view when the sidebar icons do not appear. */
function RevealSection() {
	const state = useSyncExternalStore(subscribe, getState);
	return (
		<>
			<ToggleField
				label="Show adult games"
				description="Same as the eye icon in the Library sidebar. Off again after every Steam start."
				checked={state.mode === 'all'}
				disabled={!state.ready}
				onChange={(on) => {
					setMode(on ? 'all' : 'hidden');
				}}
			/>
			<ToggleField
				label="Show only adult games"
				description="Same as the 18+ icon in the Library sidebar: only tagged games, in their usual collections or by recent activity. Off again after every Steam start."
				checked={state.mode === 'only'}
				disabled={!state.ready || (state.mode !== 'only' && !state.hasTags)}
				onChange={(on) => {
					setMode(on ? 'only' : 'hidden');
				}}
			/>
			<Field label="Status" description={state.warning ?? STATUS[state.seamStatus]} />
		</>
	);
}

function useSettingsView(settings: SettingsService): SettingsView {
	const sub = useCallback((fn: () => void) => settings.subscribe(fn), [settings]);
	const get = useCallback(() => settings.getView(), [settings]);
	return useSyncExternalStore(sub, get);
}

function editable(view: SettingsView): boolean {
	return view.library.ready && view.tags.writable;
}

function TagsSection({ settings }: { settings: SettingsService }) {
	const view = useSettingsView(settings);
	const [query, setQuery] = useState('');
	const [confirmClear, setConfirmClear] = useState(false);
	const [result, setResult] = useState<ActionResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice] = useState(() => settings.takeNotice());

	const count = view.tags.tags.size;
	const rows = settings.rows(query);
	const canEdit = editable(view) && !busy;

	const run = async (action: () => Promise<ActionResult>) => {
		setBusy(true);
		try {
			setResult(await action());
		} finally {
			setBusy(false);
		}
	};
	const remove = (appId: AppId) => {
		void run(() => settings.removeTag(appId));
	};

	let summary: string;
	if (!view.library.ready) summary = 'Loading your tags.';
	else if (count === 0) summary = 'No games are tagged. Right-click a game in the Library and choose Mark as adult.';
	else summary = `${String(count)} game${count === 1 ? ' is' : 's are'} tagged.`;

	return (
		<>
			{notice !== null && <Field label="Notice" description={notice} />}
			<Field
				label="Tagged games"
				description={view.library.ready && !view.tags.writable && view.tags.reason !== null ? `${summary} ${view.tags.reason}` : summary}
			/>
			{count > 0 && (
				<TextField
					label="Search"
					value={query}
					onChange={(e) => {
						setQuery(e.currentTarget.value);
					}}
				/>
			)}
			{rows.slice(0, MAX_ROWS).map((row) => (
				<Field
					key={row.appId}
					label={row.name ?? 'Unknown game'}
					description={`App ID ${String(row.appId)}`}
					indentLevel={1}
					padding="compact"
				>
					<DialogButton
						style={buttonStyle}
						disabled={!canEdit}
						onClick={() => {
							remove(row.appId);
						}}
					>
						Remove
					</DialogButton>
				</Field>
			))}
			{rows.length > MAX_ROWS && (
				<Field description={`Showing ${String(MAX_ROWS)} of ${String(rows.length)}. Search to narrow the list.`} indentLevel={1} />
			)}
			{count > 0 && query.trim() !== '' && rows.length === 0 && <Field description="No tagged game matches." indentLevel={1} />}
			{count > 0 && (
				<Field
					label="Remove all tags"
					description={
						confirmClear
							? `Remove all ${String(count)} tags? Every game shows normally again. The current list is saved first, and an Undo button puts it back until Steam restarts. Export it to keep it longer.`
							: 'Untags every game for this Steam account.'
					}
				>
					{confirmClear ? (
						<>
							<DialogButton
								style={buttonStyle}
								disabled={!canEdit}
								onClick={() => {
									setConfirmClear(false);
									void run(() => settings.clearAll());
								}}
							>
								Remove all
							</DialogButton>
							<DialogButton
								style={buttonStyle}
								onClick={() => {
									setConfirmClear(false);
								}}
							>
								Cancel
							</DialogButton>
						</>
					) : (
						<DialogButton
							style={buttonStyle}
							disabled={!canEdit}
							onClick={() => {
								setConfirmClear(true);
							}}
						>
							Remove all…
						</DialogButton>
					)}
				</Field>
			)}
			<ResultLine result={result} />
		</>
	);
}

/** Shown after Remove all or Replace: the saved list, and a button to put it back. */
function UndoSection({ settings }: { settings: SettingsService }) {
	const view = useSettingsView(settings);
	const [result, setResult] = useState<ActionResult | null>(null);
	const [busy, setBusy] = useState(false);
	const undo = view.undo;
	if (undo === null) return <ResultLine result={result} />;
	const what = undo.action === 'clear' ? 'Remove all' : 'Replace';
	return (
		<>
			<Field
				label={`Undo ${what}`}
				description={`Your previous list of ${games(undo.count)} is saved until Steam restarts. Undo puts it back, or copy it from below to keep it.`}
			>
				<DialogButton
					style={buttonStyle}
					disabled={!editable(view) || busy}
					onClick={() => {
						setBusy(true);
						void settings
							.undoLast()
							.then(setResult)
							.finally(() => {
								setBusy(false);
							});
					}}
				>
					Undo
				</DialogButton>
			</Field>
			<Field childrenLayout="below" indentLevel={1}>
				<textarea style={textAreaStyle} readOnly value={undo.text} onFocus={(e) => { e.currentTarget.select(); }} />
			</Field>
			<ResultLine result={result} />
		</>
	);
}

function games(n: number): string {
	return `${String(n)} game${n === 1 ? '' : 's'}`;
}

function TransferSection({ settings }: { settings: SettingsService }) {
	const view = useSettingsView(settings);
	const ref = useRef<HTMLDivElement>(null);
	const [exported, setExported] = useState<string | null>(null);
	const [importText, setImportText] = useState('');
	/** Set while the Replace confirmation is open: how many App IDs the paste holds. */
	const [confirmReplace, setConfirmReplace] = useState<number | null>(null);
	const [result, setResult] = useState<ActionResult | null>(null);
	const [busy, setBusy] = useState(false);
	const canEdit = editable(view) && !busy;

	const doExport = async () => {
		setBusy(true);
		try {
			const res = await settings.exportText();
			if (!res.ok) {
				setResult(res);
				return;
			}
			setExported(res.text);
			const copied = await copyText(res.text, ownerWindow(ref.current));
			setResult({
				ok: true,
				message: copied
					? 'Tag list copied to the clipboard. Keep it somewhere safe; it is also shown below.'
					: 'Could not reach the clipboard. Select the text below and copy it.',
			});
		} finally {
			setBusy(false);
		}
	};

	const doImport = async (mode: 'merge' | 'replace') => {
		setBusy(true);
		try {
			const res = await settings.importText(importText, mode);
			setResult(res);
			if (res.ok) setImportText('');
		} finally {
			setBusy(false);
		}
	};

	const askReplace = async () => {
		setBusy(true);
		try {
			const preview = await settings.previewImport(importText);
			if (preview.ok) {
				setResult(null);
				setConfirmReplace(preview.count);
			} else {
				setResult({ ok: false, message: `Nothing was replaced: ${preview.message}` });
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div ref={ref}>
			<Field label="Export" description="Copies your tag list (App IDs only) so you can keep it or move it to another PC.">
				<DialogButton
					style={buttonStyle}
					disabled={!view.library.ready || busy}
					onClick={() => {
						void doExport();
					}}
				>
					Export
				</DialogButton>
			</Field>
			{exported !== null && (
				<Field childrenLayout="below" indentLevel={1}>
					<textarea style={textAreaStyle} readOnly value={exported} onFocus={(e) => { e.currentTarget.select(); }} />
				</Field>
			)}
			<Field
				label="Import"
				description="Paste an exported list, or App IDs separated by commas or new lines."
				childrenLayout="below"
			>
				<textarea
					style={textAreaStyle}
					value={importText}
					placeholder="Paste here"
					onChange={(e) => {
						setImportText(e.currentTarget.value);
						setConfirmReplace(null);
					}}
				/>
			</Field>
			<Field
				indentLevel={1}
				description={
					confirmReplace !== null
						? `Replace your ${games(view.tags.tags.size)} with the ${games(confirmReplace)} pasted? Games not in the paste are untagged. The current list is saved first, and an Undo button puts it back until Steam restarts.`
						: 'Add keeps your current tags. Replace swaps the whole list.'
				}
			>
				{confirmReplace !== null ? (
					<>
						<DialogButton
							style={buttonStyle}
							disabled={!canEdit}
							onClick={() => {
								setConfirmReplace(null);
								void doImport('replace');
							}}
						>
							Replace
						</DialogButton>
						<DialogButton
							style={buttonStyle}
							onClick={() => {
								setConfirmReplace(null);
							}}
						>
							Cancel
						</DialogButton>
					</>
				) : (
					<>
						<DialogButton
							style={buttonStyle}
							disabled={!canEdit || importText.trim() === ''}
							onClick={() => {
								void doImport('merge');
							}}
						>
							Add to my tags
						</DialogButton>
						<DialogButton
							style={buttonStyle}
							disabled={!canEdit || importText.trim() === ''}
							onClick={() => {
								void askReplace();
							}}
						>
							Replace…
						</DialogButton>
					</>
				)}
			</Field>
			<ResultLine result={result} />
		</div>
	);
}

function DiagnosticsSection({ settings }: { settings: SettingsService }) {
	useSettingsView(settings);
	const ref = useRef<HTMLDivElement>(null);
	const [, setTick] = useState(0);
	const [report, setReport] = useState<string | null>(null);
	const [result, setResult] = useState<ActionResult | null>(null);

	// Hook markers change without a state change (an on-demand hook runs when
	// a menu opens), so re-read them while the page is open.
	useEffect(() => {
		const timer = setInterval(() => {
			setTick((t) => t + 1);
		}, 2000);
		return () => {
			clearInterval(timer);
		};
	}, []);

	const check = settings.selfCheck();
	const copy = async () => {
		const text = await settings.diagnosticReport();
		setReport(text);
		const copied = await copyText(text, ownerWindow(ref.current));
		setResult(
			copied
				? { ok: true, message: 'Report copied. Paste it into an LLM session on this PC with "fix it". It holds no game names or tags.' }
				: { ok: false, message: 'Could not reach the clipboard. Select the report below and copy it.' },
		);
	};

	return (
		<div ref={ref}>
			{check.loadError !== null && <Field label="Hook definitions failed to load" description={check.loadError} />}
			{check.hooks.map((hook) => (
				<Field
					key={hook.id}
					label={hook.id}
					description={[HOOK_LABEL[hook.state], hook.reason].filter((s) => s !== null && s !== '').join(': ')}
					indentLevel={1}
					padding="compact"
				/>
			))}
			<Field label="Diagnostic report" description="Versions, hook status and update results, for repairing the plugin after a Steam update.">
				<DialogButton
					style={buttonStyle}
					onClick={() => {
						void copy();
					}}
				>
					Copy diagnostic report
				</DialogButton>
			</Field>
			<ResultLine result={result} />
			{report !== null && (
				<Field childrenLayout="below" indentLevel={1}>
					<textarea style={{ ...textAreaStyle, minHeight: 200 }} readOnly value={report} onFocus={(e) => { e.currentTarget.select(); }} />
				</Field>
			)}
		</div>
	);
}

function UpdatesSection({ settings }: { settings: SettingsService }) {
	const [status, setStatus] = useState<UpdateStatus | null | 'loading'>('loading');
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<ActionResult | null>(null);

	useEffect(() => {
		let live = true;
		void settings.updateStatus().then((s) => {
			if (live) setStatus(s);
		});
		return () => {
			live = false;
		};
	}, [settings]);

	if (status === 'loading') return <Field label="Updates" description="Reading update status." />;
	if (status === null) return <Field label="Updates" description="The updater did not answer. The diagnostic report has details." />;

	const rollback = async () => {
		setBusy(true);
		try {
			const res = await settings.rollback();
			setResult(
				res.ok
					? { ok: true, message: `Version ${res.to} will be put back at the next Steam start, and this version will not be downloaded again.` }
					: { ok: false, message: `Rollback failed: ${res.message}` },
			);
			setStatus(await settings.updateStatus());
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Field label="Installed version" description={status.currentVersion ?? 'unknown'} />
			<Field label="Last update check" description={describeCheck(status)} />
			{status.lastApplyError !== null && <Field label="Last install failed" description={status.lastApplyError} />}
			{status.stagedVersion !== null && (
				<Field label="Waiting to install" description={`${status.stagedVersion} installs when Steam next closes and loads at the following start.`} />
			)}
			{canRollBack(status) && status.previousVersion !== null && (
				<Field
					label="Roll back"
					description={
						confirm
							? `Go back to ${status.previousVersion} at the next Steam start? Your tags are not affected.`
							: `Use this if the current version misbehaves. Version ${status.previousVersion} is kept for this.`
					}
				>
					{confirm ? (
						<>
							<DialogButton
								style={buttonStyle}
								disabled={busy}
								onClick={() => {
									setConfirm(false);
									void rollback();
								}}
							>
								Roll back
							</DialogButton>
							<DialogButton
								style={buttonStyle}
								onClick={() => {
									setConfirm(false);
								}}
							>
								Cancel
							</DialogButton>
						</>
					) : (
						<DialogButton
							style={buttonStyle}
							disabled={busy}
							onClick={() => {
								setConfirm(true);
							}}
						>
							Roll back…
						</DialogButton>
					)}
				</Field>
			)}
			<ResultLine result={result} />
		</>
	);
}

/** In words, for the settings page. */
export function describeCheck(status: UpdateStatus): string {
	if (status.error !== null) return `The updater could not start: ${status.error}`;
	if (status.lastCheckAt === null) return 'Not checked yet. Steam Discreet checks shortly after Steam starts.';
	const when = new Date(status.lastCheckAt * 1000).toLocaleString();
	switch (status.lastResult) {
		case 'up_to_date':
			return `${when}: up to date.`;
		case 'staged':
		case 'already_staged':
			return `${when}: a new version was downloaded.`;
		case 'skipped':
			return `${when}: a newer version exists but was rolled back, so it is skipped.`;
		case 'error':
			return `${when}: failed (${status.lastError ?? 'unknown error'}). Nothing was changed.`;
		default:
			return when;
	}
}

function ResultLine({ result }: { result: ActionResult | null }) {
	if (result === null) return null;
	return <Field description={result.ok ? result.message : `⚠ ${result.message}`} indentLevel={1} />;
}

function ownerWindow(element: HTMLElement | null): unknown {
	return element?.ownerDocument.defaultView ?? globalThis;
}

interface SectionProps {
	readonly name: string;
	readonly children: ReactNode;
}

/** Keeps a failing section from taking the whole settings page down. */
class Section extends Component<SectionProps, { failed: string | null }> {
	override state: { failed: string | null } = { failed: null };

	static getDerivedStateFromError(error: unknown): { failed: string } {
		return { failed: error instanceof Error ? error.message : String(error) };
	}

	override componentDidCatch(error: unknown): void {
		console.error(`[steam-discreet] settings section "${this.props.name}" failed`, error);
	}

	override render(): ReactNode {
		if (this.state.failed !== null) {
			return <Field label={this.props.name} description={`This section failed to show (${this.state.failed}). The rest of the page still works.`} />;
		}
		return this.props.children;
	}
}
