import { boardConflict, type HarnessClient } from '@kemiri/client';
import type { NotificationAlert, NotificationMute, NotificationRecentEntry } from '@kemiri/protocol';
import { notifications } from './notifications.svelte.js';
import { activeDoNotDisturb, alertOriginMuted, quietTimerDelay } from './alert-quiet.js';
import {
	AlertSoundPlayer, DEFAULT_ALERT_VOLUME, alertSoundDecision, alertSoundProjectKey, alertSoundSetting, alertVolume,
	noteAlertSound, type AlertSoundHistory, type AlertSoundSetting,
} from './alert-sounds.js';
import {
	ALERT_BURST_WINDOW_MS, ALERT_RETENTION_MS, DEFAULT_ALERT_POPUPS, alertDuration, alertPopupDecision, alertPopupSetting,
	alertRowId, alertTimeRemaining, applyAlertEntry, canAnswerAlert, catchUpPresentation, mergesAlertBurst, reconcileAlertEntries, recentAlertSequence,
	type AlertContext, type AlertCursor, type AlertPopupSetting, type AlertRow, type AlertScreen,
} from './alerts.js';

const SETTINGS_KEY = 'aiki.in-app-alert-settings.v1';
const SOUND_HISTORY_KEY = 'aiki.alert-sound-history.v1';
const CURSOR_PREFIX = 'aiki.alert-cursor.v1:';
const ROWS_PREFIX = 'aiki.alert-rows.v1:';
const TAB_SYNC_KEY = 'aiki.alert-marks.v1';
const RETENTION_SWEEP_MS = 60_000;

export type InAppAlertSettings = {
	popupSetting: AlertPopupSetting; hideText: boolean; tabTitleAndIconCount: boolean;
	soundSetting: AlertSoundSetting; volume: number; doNotDisturb: NotificationMute | null;
};
type AlertBackend = { id: string; client: HarnessClient };
type AlertMark = { backendId: string; id: string; kind: 'shown' | 'dismissed' | 'read' };
type LiveEntry = { entry: NotificationRecentEntry; context: AlertContext; arrivedAt: number };
type AlertConnection = {
	backend: AlertBackend;
	dispose: () => void;
	generation: number;
	ready: boolean;
	buffering: boolean;
	pending: LiveEntry[];
	cursor?: AlertCursor;
	retry?: ReturnType<typeof setTimeout>;
};

type PopupMember = { row: AlertRow; arrivedAt: number };
export type AlertPopup = {
	id: string;
	kind: 'alert' | 'burst' | 'catch-up';
	members: PopupMember[];
	level: 'urgent' | 'important' | 'info';
	sortAt: number;
	remainingMs: number;
	folded: boolean;
	/** The eligible live member. An aggregate's loudest member does not inherit another member's permission. */
	soundAlertId?: string;
};

function readStored<T>(key: string): T | undefined {
	try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; }
	catch { return undefined; }
}

function writeStored(key: string, value: unknown): void {
	try { localStorage.setItem(key, JSON.stringify(value)); }
	catch { /* Live alerts still work without browser storage. */ }
}

function storedCursor(backendId: string): AlertCursor | undefined {
	const cursor = readStored<AlertCursor>(CURSOR_PREFIX + backendId);
	return cursor && typeof cursor.backendEpoch === 'string' && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0 ? cursor : undefined;
}

function retained(rows: readonly AlertRow[], now = Date.now()): AlertRow[] {
	return rows.filter(row => Date.parse(row.alert.at) >= now - ALERT_RETENTION_MS);
}

function cachedRows(backendId: string): AlertRow[] {
	const rows = readStored<AlertRow[]>(ROWS_PREFIX + backendId);
	return Array.isArray(rows) ? retained(rows.filter(row => row?.backendId === backendId && row.alert?.key && row.alert?.at)) : [];
}

function withBrowserMarks(row: AlertRow, cached: AlertRow | undefined): AlertRow {
	return cached ? { ...row, shown: row.shown || cached.shown, read: row.read || cached.read,
		dismissed: row.dismissed || cached.dismissed, done: row.done || cached.done } : row;
}

function strongestLevel(members: PopupMember[]): AlertPopup['level'] {
	if (members.some(({ row }) => row.alert.level === 'urgent')) return 'urgent';
	return members.some(({ row }) => row.alert.level === 'important') ? 'important' : 'info';
}

class Alerts {
	rows = $state.raw<AlertRow[]>([]);
	popups = $state.raw<AlertPopup[]>([]);
	visible = $state(false);
	composerHeight = $state(0);
	chatBannerHost = $state.raw<HTMLElement>();
	taskSheet = $state.raw<HTMLElement>();
	taskComposerHeight = $state(0);
	popupSetting = $state<AlertPopupSetting>(DEFAULT_ALERT_POPUPS);
	hideText = $state(false);
	tabTitleAndIconCount = $state(true);
	soundSetting = $state<AlertSoundSetting>('urgent');
	volume = $state(DEFAULT_ALERT_VOLUME);
	doNotDisturb = $state<NotificationMute | null>(null);
	audioUnlocked = $state(false);
	#soundPlayer = new AlertSoundPlayer();
	#soundHistory: AlertSoundHistory = { softAt: {} };
	#disturbExpiry?: ReturnType<typeof setTimeout>;
	inboxOpen = $state(false);
	inboxTrigger?: HTMLElement;
	#screen: () => AlertScreen | undefined = () => undefined;
	#connections = new Map<string, AlertConnection>();
	#channel?: BroadcastChannel;
	#displayedIds = new Set<string>();
	#hoveredIds = new Set<string>();
	#focusedIds = new Set<string>();
	#menuIds = new Set<string>();
	#lastTick = 0;
	#popupId = 0;
	#composerOwner?: object;
	#taskComposerOwner?: object;

	setComposerHeight(owner: object, height: number, inTask = false): void {
		if (inTask) {
			this.#taskComposerOwner = owner;
			this.taskComposerHeight = height;
		} else {
			this.#composerOwner = owner;
			this.composerHeight = height;
		}
	}

	clearComposerHeight(owner: object): void {
		if (this.#composerOwner === owner) this.composerHeight = 0;
		if (this.#taskComposerOwner === owner) this.taskComposerHeight = 0;
	}

	start(screen: () => AlertScreen | undefined): () => void {
		this.#screen = screen;
		this.#loadSettings();
		if (typeof BroadcastChannel !== 'undefined') {
			try {
				this.#channel = new BroadcastChannel(TAB_SYNC_KEY);
				this.#channel.onmessage = event => this.#receiveMarks(event.data);
			} catch { /* Storage events are the fallback. */ }
		}
		const onVisibility = () => {
			this.#advanceTime();
			this.visible = document.visibilityState === 'visible';
			if (!this.visible) {
				this.#hoveredIds.clear();
				this.#focusedIds.clear();
				this.#menuIds.clear();
			}
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key === SETTINGS_KEY) this.#loadSettings();
			if (event.key === TAB_SYNC_KEY && event.newValue) {
				try { this.#receiveMarks(JSON.parse(event.newValue).marks); } catch { /* Ignore invalid browser data. */ }
			}
		};
		this.#lastTick = performance.now();
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('storage', onStorage);
		const timer = setInterval(() => this.#advanceTime(), 250);
		const sweep = setInterval(() => {
			const retainedRows = retained(this.rows);
			if (retainedRows.length === this.rows.length) return;
			this.#setRows(retainedRows);
			for (const backendId of this.#connections.keys()) this.#saveRows(backendId);
		}, RETENTION_SWEEP_MS);
		return () => {
			clearInterval(timer);
			clearInterval(sweep);
			clearTimeout(this.#disturbExpiry);
			this.#soundPlayer.close();
			this.audioUnlocked = false;
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('storage', onStorage);
			this.#channel?.close();
			this.#channel = undefined;
			this.observeBackends([]);
		};
	}

	setSettings(settings: Partial<InAppAlertSettings>): void {
		const next = {
			popupSetting: this.popupSetting, hideText: this.hideText, tabTitleAndIconCount: this.tabTitleAndIconCount,
			soundSetting: this.soundSetting, volume: this.volume, doNotDisturb: this.doNotDisturb, ...settings,
		};
		writeStored(SETTINGS_KEY, next);
		this.#applySettings(next);
	}

	#loadSettings(): void {
		this.#applySettings(readStored<Partial<Record<keyof InAppAlertSettings, unknown>>>(SETTINGS_KEY));
	}

	#applySettings(settings?: Partial<Record<keyof InAppAlertSettings, unknown>>): void {
		this.popupSetting = alertPopupSetting(settings?.popupSetting);
		this.hideText = settings?.hideText === true;
		this.tabTitleAndIconCount = settings?.tabTitleAndIconCount !== false;
		this.soundSetting = alertSoundSetting(settings?.soundSetting);
		this.volume = alertVolume(settings?.volume);
		this.doNotDisturb = activeDoNotDisturb(settings?.doNotDisturb, Date.now());
		this.#scheduleDisturbExpiry();
		if (this.popupSetting === 'off' || this.doNotDisturb) this.popups = [];
	}

	#scheduleDisturbExpiry(): void {
		clearTimeout(this.#disturbExpiry);
		const deadline = this.doNotDisturb?.until;
		if (deadline === undefined) return;
		this.#disturbExpiry = setTimeout(() => {
			if (Date.now() >= deadline) this.setSettings({ doNotDisturb: null });
			else this.#scheduleDisturbExpiry();
		}, quietTimerDelay(deadline, Date.now()));
	}

	async unlockSounds(): Promise<boolean> {
		const unlocked = await this.#soundPlayer.unlock();
		if (unlocked) this.audioUnlocked = true;
		return unlocked;
	}

	async testSound(): Promise<void> {
		if (await this.unlockSounds()) this.#soundPlayer.play('urgent', this.volume);
	}

	pruneMutedPopups(): void {
		if (this.popups.length) this.#setRows(this.rows);
	}

	observeBackends(backends: readonly AlertBackend[]): void {
		for (const [id, connection] of this.#connections) {
			if (backends.some(backend => backend.id === id && backend.client === connection.backend.client)) continue;
			connection.dispose();
			this.#connections.delete(id);
			this.#setRows(this.rows.filter(row => row.backendId !== id));
		}
		for (const backend of backends) {
			if (this.#connections.has(backend.id)) continue;
			const connection: AlertConnection = { backend, ready: false, buffering: true, generation: 0, pending: [], dispose: () => {} };
			this.#connections.set(backend.id, connection);
			const offAlert = backend.client.onNotificationAlert(({ alert, sound }) =>
				this.#receiveLive(connection, { type: 'alert', alert, resolved: false }, sound));
			const offResolved = backend.client.onNotificationResolved(({ tags, seq, backendEpoch, at }) =>
				this.#receiveLive(connection, { type: 'resolved', tags, seq, backendEpoch, at }, false));
			const onConnection = (state: HarnessClient['state']) => {
				const authorized = !state.auth || state.auth.mode === 'off' || state.auth.sessionId !== null;
				if (state.status === 'ready' && !authorized) {
					connection.cursor = undefined;
					this.#setRows(this.rows.filter(row => row.backendId !== backend.id));
				}
				const ready = state.status === 'ready' && authorized && state.features?.includes('in-app-alerts') === true;
				if (ready === connection.ready) return;
				connection.ready = ready;
				if (ready) {
					if (!connection.cursor) this.#setRows([...cachedRows(backend.id), ...this.rows.filter(row => row.backendId !== backend.id)]);
					this.#catchUp(connection);
				} else {
					clearTimeout(connection.retry);
					connection.generation++;
					connection.buffering = true;
					connection.pending = [];
				}
			};
			const offConnection = backend.client.subscribe(onConnection);
			connection.dispose = () => {
				connection.generation++;
				clearTimeout(connection.retry);
				offConnection(); offAlert(); offResolved();
			};
			onConnection(backend.client.state);
		}
	}

	#presentationMuted(backendId: string, projectId: string | null, now = Date.now()): boolean {
		return activeDoNotDisturb(this.doNotDisturb, now) !== null || alertOriginMuted(notifications.settings, backendId, projectId, now);
	}

	#context(backendId: string, soundAllowed: boolean, projectId: string | null = null): AlertContext {
		return { backendId, screen: this.#screen(), setting: this.popupSetting, visible: document.visibilityState === 'visible',
			soundAllowed, muted: alertOriginMuted(notifications.settings, backendId, projectId, Date.now()),
			doNotDisturb: activeDoNotDisturb(this.doNotDisturb, Date.now()) !== null };
	}

	#popupDecision(alert: NotificationAlert, context: AlertContext) {
		const now = Date.now();
		return alertPopupDecision(alert, { ...context,
			muted: context.muted || alertOriginMuted(notifications.settings, context.backendId, alert.projectId, now),
			doNotDisturb: context.doNotDisturb || activeDoNotDisturb(this.doNotDisturb, now) !== null,
		});
	}

	#receiveLive(connection: AlertConnection, entry: NotificationRecentEntry, sound: boolean): void {
		if (!connection.ready) return;
		const { backend } = connection;
		const live = { entry, context: this.#context(backend.id, sound, entry.type === 'alert' ? entry.alert.projectId : null), arrivedAt: Date.now() };
		if (connection.buffering) { connection.pending.push(live); return; }
		const epoch = entry.type === 'alert' ? entry.alert.backendEpoch : entry.backendEpoch;
		if (connection.cursor?.backendEpoch !== epoch) {
			connection.pending.push(live);
			this.#catchUp(connection);
			return;
		}
		const seq = recentAlertSequence(entry);
		if (seq <= connection.cursor.seq) return;
		this.#applyLive(backend.id, live);
		this.#commit(connection, { backendEpoch: epoch, seq });
	}

	#catchUp(connection: AlertConnection, confirmEpoch = true): void {
		connection.buffering = true;
		const generation = ++connection.generation;
		const { backend } = connection;
		const cursor = storedCursor(backend.id) ?? connection.cursor;
		// A tab already open may be behind the shared cursor. Fill that gap into its list without replaying pop-ups.
		const requestedCursor = connection.cursor ?? cursor;
		const after = requestedCursor?.seq ?? 0;
		void (async () => {
			let history = await backend.client.readRecentNotifications(after);
			if (connection.generation !== generation) return;
			if (after !== 0 && requestedCursor?.backendEpoch !== history.backendEpoch) {
				history = await backend.client.readRecentNotifications(0);
				if (connection.generation !== generation) return;
			}
			const { backendEpoch: epoch, latestSeq } = history;
			const liveEpoch = (live: LiveEntry) => live.entry.type === 'alert' ? live.entry.alert.backendEpoch : live.entry.backendEpoch;
			const pending = connection.pending.filter(live => liveEpoch(live) === epoch);
			const lastBuffered = connection.pending.at(-1);
			const changedDuringRead = lastBuffered && liveEpoch(lastBuffered) !== epoch && liveEpoch(lastBuffered) !== requestedCursor?.backendEpoch;
			connection.pending = changedDuringRead ? connection.pending.filter(live => liveEpoch(live) !== epoch) : [];
			const bufferedSeqs = new Map(pending.map(live => [recentAlertSequence(live.entry), live]));
			const ordered = reconcileAlertEntries(history.events, pending.map(live => live.entry));
			const cached = new Map(cachedRows(backend.id).map(row => [alertRowId(row), row]));
			let rows = this.rows.map(row => row.backendId === backend.id && row.alert.backendEpoch !== epoch ? { ...row, done: true } : row);
			for (const entry of ordered) rows = applyAlertEntry(rows, backend.id, entry);
			this.#setRows(retained(rows.map(row => withBrowserMarks(row, cached.get(alertRowId(row))))));
			const now = Date.now();
			const context = this.#context(backend.id, false);
			const catchUp: AlertRow[] = [];
			for (const entry of ordered) {
				if (entry.type !== 'alert') continue;
				const { seq } = entry.alert;
				const row = this.#findRow(backend.id, entry.alert);
				if (!row || row.done || row.dismissed) continue;
				const live = bufferedSeqs.get(seq);
				if (live) {
					const { pop, silent } = this.#popupDecision(row.alert, live.context);
					if (pop) this.#queue(row, live.arrivedAt, !silent);
				} else if (!row.shown && cursor?.backendEpoch === epoch && seq > cursor.seq && this.#popupDecision(row.alert, context).pop) {
					catchUp.push(row);
				}
			}
			const presentation = catchUpPresentation(cursor, epoch, catchUp, now);
			if (presentation === 'summary') this.#addPopup('catch-up', catchUp.map(row => ({ row, arrivedAt: now })), now);
			if (presentation === 'individual') {
				// Show the missed events individually; they did not arrive in one live burst.
				for (const row of catchUp) this.#addPopup('alert', [{ row, arrivedAt: Date.parse(row.alert.at) }], Date.parse(row.alert.at));
			}
			const lastEntry = ordered.at(-1);
			this.#commit(connection, { backendEpoch: epoch, seq: Math.max(latestSeq, lastEntry ? recentAlertSequence(lastEntry) : 0) });
			connection.buffering = false;
			// An epoch change while a history request was in flight needs a fresh snapshot.
			if (confirmEpoch && connection.pending.length) this.#catchUp(connection, false);
			else connection.pending = [];
		})().catch(() => {
			if (connection.generation === generation) connection.retry = setTimeout(() => this.#catchUp(connection, confirmEpoch), 1_000);
		});
	}

	#commit(connection: AlertConnection, cursor: AlertCursor): void {
		const { id } = connection.backend;
		this.#saveRows(id);
		connection.cursor = cursor;
		const shared = storedCursor(id);
		if (shared?.backendEpoch !== cursor.backendEpoch || shared.seq < cursor.seq) writeStored(CURSOR_PREFIX + id, cursor);
	}

	#saveRows(backendId: string): void {
		const cached = new Map(cachedRows(backendId).map(row => [alertRowId(row), row]));
		for (const row of this.rows) {
			if (row.backendId !== backendId) continue;
			const id = alertRowId(row);
			cached.set(id, withBrowserMarks(row, cached.get(id)));
		}
		writeStored(ROWS_PREFIX + backendId, retained([...cached.values()]));
	}

	#findRow(backendId: string, alert: NotificationAlert): AlertRow | undefined {
		const id = alertRowId({ backendId, alert });
		return this.rows.find(row => alertRowId(row) === id);
	}

	#applyLive(backendId: string, { entry, context, arrivedAt }: LiveEntry): void {
		const previous = entry.type === 'alert' ? this.popups.find(popup => popup.kind === 'alert' && popup.members.some(({ row }) =>
			row.backendId === backendId && row.alert.backendEpoch === entry.alert.backendEpoch && row.alert.tag === entry.alert.tag)) : undefined;
		let rows = applyAlertEntry(this.rows, backendId, entry);
		if (entry.type === 'alert') {
			const id = alertRowId({ backendId, alert: entry.alert });
			const cached = cachedRows(backendId).find(row => alertRowId(row) === id);
			rows = rows.map(row => alertRowId(row) === id ? withBrowserMarks(row, cached) : row);
		}
		this.#setRows(retained(rows));
		if (entry.type !== 'alert') return;
		const row = this.#findRow(backendId, entry.alert);
		const { pop, silent } = this.#popupDecision(entry.alert, context);
		if (row && !row.done && !row.dismissed && pop) this.#queue(row, arrivedAt, !silent, previous);
	}

	#setRows(rows: AlertRow[]): void {
		this.rows = rows;
		const byId = new Map(rows.map(row => [alertRowId(row), row]));
		this.popups = this.popups.flatMap(popup => {
			const members = popup.members.flatMap(member => {
				const row = byId.get(alertRowId(member.row));
				return row && !row.done && !row.dismissed && !this.#presentationMuted(row.backendId, row.alert.projectId) ? [{ ...member, row }] : [];
			});
			return members.length ? [{ ...popup, members, level: strongestLevel(members) }] : [];
		});
	}

	#queue(row: AlertRow, arrivedAt: number, sound: boolean, replacement?: AlertPopup): void {
		const { backendId, alert } = row;
		const soundAlertId = sound ? alertRowId(row) : undefined;
		const sameProject = ({ row: member }: PopupMember) => alert.projectId !== null && member.backendId === backendId && member.alert.projectId === alert.projectId;
		const projectPopups = this.popups.filter(popup => popup.kind !== 'catch-up' && popup.members.some(member =>
			sameProject(member) && arrivedAt - member.arrivedAt <= ALERT_BURST_WINDOW_MS && arrivedAt >= member.arrivedAt));
		const previous = projectPopups.flatMap(popup => popup.members);
		const burst = projectPopups.find(popup => popup.kind === 'burst');
		if (burst || mergesAlertBurst(previous.map(member => member.arrivedAt), arrivedAt)) {
			this.popups = this.popups.filter(popup => !projectPopups.includes(popup));
			this.#addPopup('burst', [...previous, { row, arrivedAt }], arrivedAt, soundAlertId, burst?.id);
		} else {
			this.#addPopup('alert', [{ row, arrivedAt }], replacement?.sortAt ?? arrivedAt, soundAlertId, replacement?.id);
		}
	}

	#addPopup(kind: AlertPopup['kind'], members: PopupMember[], sortAt: number, soundAlertId?: string, id = String(++this.#popupId)): void {
		this.#advanceTime();
		const level = strongestLevel(members);
		this.popups = [...this.popups, { id, kind, members, level, sortAt, soundAlertId, folded: false,
			remainingMs: alertDuration(level, members.some(({ row }) => row.alert.warning)) }];
	}

	#advanceTime(): void {
		const now = performance.now();
		const elapsed = now - this.#lastTick;
		this.#lastTick = now;
		if (!this.visible || !this.#displayedIds.size || !this.popups.length) return;
		this.popups = this.popups.flatMap(popup => {
			const remaining = alertTimeRemaining(popup.remainingMs, elapsed,
				!popup.folded && this.#displayedIds.has(popup.id), this.#hoveredIds.has(popup.id) || this.#focusedIds.has(popup.id) || this.#menuIds.has(popup.id));
			if (remaining === popup.remainingMs) return [popup];
			if (remaining > 0) return [{ ...popup, remainingMs: remaining }];
			return popup.level === 'urgent' || popup.members.some(({ row }) => row.alert.warning)
				? [{ ...popup, remainingMs: 0, folded: true }] : [];
		});
	}

	setDisplayed(ids: readonly string[]): void {
		this.#advanceTime();
		this.#displayedIds = new Set(ids);
		for (const paused of [this.#hoveredIds, this.#focusedIds, this.#menuIds]) {
			for (const id of paused) if (!this.#displayedIds.has(id)) paused.delete(id);
		}
	}

	pause(id: string, source: 'hover' | 'focus' | 'menu', paused: boolean): void {
		this.#advanceTime();
		const pauses = source === 'hover' ? this.#hoveredIds : source === 'focus' ? this.#focusedIds : this.#menuIds;
		if (paused) pauses.add(id);
		else pauses.delete(id);
	}

	markDisplayed(ids: readonly string[]): void {
		if (document.visibilityState !== 'visible') return;
		const marks: AlertMark[] = [];
		const keysByBackend = new Map<string, string[]>();
		for (const popup of this.popups) {
			if (!ids.includes(popup.id)) continue;
			for (const { row } of popup.members) {
				if (row.shown) continue;
				const id = alertRowId(row);
				if (popup.soundAlertId === id) this.#playPopupSound(row, popup.kind === 'catch-up');
				marks.push({ backendId: row.backendId, id, kind: 'shown' });
				const keys = keysByBackend.get(row.backendId) ?? [];
				keys.push(row.alert.key);
				keysByBackend.set(row.backendId, keys);
			}
		}
		for (const [backendId, keys] of keysByBackend) {
			const client = this.#connections.get(backendId)?.backend.client;
			for (let start = 0; start < keys.length; start += 200) void client?.reportNotificationsShown(keys.slice(start, start + 200)).catch(() => {});
		}
		this.#mark(marks);
	}

	#playPopupSound(row: AlertRow, catchUp: boolean): void {
		if (!this.audioUnlocked || !this.volume) return;
		const { backendId, alert } = row;
		const decision = this.#popupDecision(alert, this.#context(backendId, true, alert.projectId));
		const now = Date.now();
		const stored = readStored<AlertSoundHistory>(SOUND_HISTORY_KEY);
		const history = stored?.softAt && (stored.lastAt ?? 0) >= (this.#soundHistory.lastAt ?? 0) ? stored : this.#soundHistory;
		const projectKey = alertSoundProjectKey(backendId, alert.projectId);
		const tone = alertSoundDecision({ level: alert.level, setting: this.soundSetting, popupVisible: decision.pop,
			permitted: !decision.silent, quietHours: notifications.settings.quietHours, projectKey, catchUp, unresolved: !row.done }, history, now);
		if (!tone || !this.#soundPlayer.play(tone, this.volume)) return;
		this.#soundHistory = noteAlertSound(history, tone, projectKey, now);
		writeStored(SOUND_HISTORY_KEY, this.#soundHistory);
	}

	showInbox(trigger?: HTMLElement): void {
		this.inboxTrigger = trigger;
		this.inboxOpen = true;
	}

	markRead(row: AlertRow): void {
		if (!row.read) this.#mark([{ backendId: row.backendId, id: alertRowId(row), kind: 'read' }]);
	}

	markAllRead(): void {
		this.#mark(this.rows.filter(row => !row.read).map(row => ({ backendId: row.backendId, id: alertRowId(row), kind: 'read' })));
	}

	dismiss(popup: AlertPopup): void { this.#markPopup(popup, 'dismissed'); }
	open(popup: AlertPopup): void {
		this.#markPopup(popup, 'read');
		this.hidePopup(popup);
	}

	hidePopup(popup: AlertPopup): void {
		this.popups = this.popups.filter(entry => entry.id !== popup.id);
	}

	async answer(row: AlertRow, label: string): Promise<'answered' | 'changed' | 'failed'> {
		const { alert, backendId } = row;
		const connection = this.#connections.get(backendId);
		if (!connection?.ready || !canAnswerAlert(alert) || !alert.choices.some(choice => choice.label === label)) return 'failed';
		try {
			await connection.backend.client.answerBoardQuestion(alert.projectId, alert.questionId, alert.questionRevision, label);
			this.#mark([{ backendId, id: alertRowId(row), kind: 'read' }]);
			this.#setRows(this.rows.map(entry => alertRowId(entry) === alertRowId(row) ? { ...entry, done: true } : entry));
			this.#saveRows(backendId);
			return 'answered';
		} catch (error) {
			return boardConflict(error) ? 'changed' : 'failed';
		}
	}

	#markPopup(popup: AlertPopup, kind: AlertMark['kind']): void {
		this.#mark(popup.members.map(({ row }) => ({ backendId: row.backendId, id: alertRowId(row), kind })));
	}

	#mark(marks: AlertMark[]): void {
		if (!marks.length) return;
		this.#receiveMarks(marks);
		if (this.#channel) this.#channel.postMessage(marks);
		else writeStored(TAB_SYNC_KEY, { marks, nonce: crypto.randomUUID() });
	}

	#receiveMarks(value: unknown): void {
		if (!Array.isArray(value)) return;
		const byId = new Map<string, AlertMark['kind'][]>();
		const backendIds = new Set<string>();
		for (const mark of value) {
			if (!mark || typeof mark.id !== 'string' || typeof mark.backendId !== 'string' ||
				(mark.kind !== 'shown' && mark.kind !== 'dismissed' && mark.kind !== 'read')) continue;
			byId.set(mark.id, [...(byId.get(mark.id) ?? []), mark.kind]);
			backendIds.add(mark.backendId);
		}
		this.#setRows(this.rows.map(row => {
			const marks = byId.get(alertRowId(row));
			return marks ? { ...row, shown: row.shown || marks.includes('shown'), dismissed: row.dismissed || marks.includes('dismissed'), read: row.read || marks.includes('read') } : row;
		}));
		for (const backendId of backendIds) this.#saveRows(backendId);
	}
}

export const alerts = new Alerts();

/** The alert stack moves inside a task dialog and needs that dialog's own composer clearance. */
export function trackTaskComposer(element: HTMLElement): { destroy(): void } {
	const measure = () => alerts.setComposerHeight(element, element.offsetHeight, true);
	const observer = new ResizeObserver(measure);
	observer.observe(element);
	measure();
	return { destroy() { observer.disconnect(); alerts.clearComposerHeight(element); } };
}
