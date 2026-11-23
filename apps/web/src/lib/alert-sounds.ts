import { quietHoursActive, type QuietHours } from '@kemiri/client';
import type { NotificationAlertLevel } from '@kemiri/protocol';

export const DEFAULT_ALERT_VOLUME = 40;
export const ALERT_SOUND_INTERVAL_MS = 8_000;
export const PROJECT_SOFT_SOUND_INTERVAL_MS = 2 * 60_000;
export type AlertSoundSetting = 'urgent-important' | 'urgent' | 'off';
export type AlertTone = 'urgent' | 'soft';
export type AlertSoundHistory = { lastAt?: number; softAt: Record<string, number> };

export function alertSoundSetting(value: unknown): AlertSoundSetting {
	return value === 'off' || value === 'urgent-important' ? value : 'urgent';
}

export function alertVolume(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : DEFAULT_ALERT_VOLUME;
}

export function alertSoundProjectKey(backendId: string, projectId: string | null): string {
	return JSON.stringify([backendId, projectId]);
}

type SoundFacts = {
	level: NotificationAlertLevel;
	setting: AlertSoundSetting;
	popupVisible: boolean;
	permitted: boolean;
	quietHours: QuietHours | null;
	projectKey: string;
	catchUp?: boolean;
	unresolved?: boolean;
};

export function alertSoundDecision(facts: SoundFacts, history: AlertSoundHistory, now: number): AlertTone | undefined {
	const { level, setting, popupVisible, permitted, quietHours, projectKey, catchUp, unresolved } = facts;
	if (!popupVisible || !permitted || setting === 'off' || quietHoursActive(quietHours, new Date(now))) return undefined;
	if (catchUp && (level !== 'urgent' || !unresolved)) return undefined;
	if (history.lastAt !== undefined && now - history.lastAt < ALERT_SOUND_INTERVAL_MS) return undefined;
	if (level === 'urgent') return 'urgent';
	if (level !== 'important' || setting !== 'urgent-important') return undefined;
	const lastSoftAt = history.softAt[projectKey];
	return lastSoftAt === undefined || now - lastSoftAt >= PROJECT_SOFT_SOUND_INTERVAL_MS ? 'soft' : undefined;
}

export function noteAlertSound(history: AlertSoundHistory, tone: AlertTone, projectKey: string, now: number): AlertSoundHistory {
	const softAt = Object.fromEntries(Object.entries(history.softAt).filter(([, at]) => now - at < PROJECT_SOFT_SOUND_INTERVAL_MS));
	if (tone === 'soft') softAt[projectKey] = now;
	return { lastAt: now, softAt };
}

const TONES = {
	urgent: [{ hz: 659.25, delay: 0, duration: 0.14 }, { hz: 880, delay: 0.14, duration: 0.16 }],
	soft: [{ hz: 392, delay: 0, duration: 0.13 }],
} as const;

type ToneContext = Pick<AudioContext, 'currentTime' | 'destination' | 'createOscillator' | 'createGain'>;

/** Schedule sine tones with a short attack and release to prevent audio clicks. */
export function scheduleAlertTone(context: ToneContext, tone: AlertTone, volume: number): boolean {
	const peak = alertVolume(volume) / 100 * (tone === 'urgent' ? 0.18 : 0.13);
	if (peak === 0) return false;
	const start = context.currentTime + 0.005;
	for (const note of TONES[tone]) {
		const at = start + note.delay;
		const oscillator = context.createOscillator();
		const envelope = context.createGain();
		oscillator.type = 'sine';
		oscillator.frequency.setValueAtTime(note.hz, at);
		envelope.gain.setValueAtTime(0, at);
		envelope.gain.linearRampToValueAtTime(peak, at + 0.025);
		envelope.gain.linearRampToValueAtTime(0, at + note.duration);
		oscillator.connect(envelope);
		envelope.connect(context.destination);
		oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
		oscillator.start(at);
		oscillator.stop(at + note.duration);
	}
	return true;
}

/** Owns this tab's audio context. Only trusted browser activation calls unlock(). Nothing queues before that. */
export class AlertSoundPlayer {
	#context?: AudioContext;

	async unlock(): Promise<boolean> {
		try {
			if (typeof AudioContext === 'undefined') return false;
			const context = this.#context ??= new AudioContext();
			if (context.state !== 'running') await context.resume();
			return context.state === 'running';
		} catch { return false; }
	}

	play(tone: AlertTone, volume: number): boolean {
		try { return this.#context?.state === 'running' && scheduleAlertTone(this.#context, tone, volume); }
		catch { return false; }
	}

	close(): void {
		void this.#context?.close().catch(() => {});
		this.#context = undefined;
	}
}
