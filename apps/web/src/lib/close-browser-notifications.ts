import { RESOLVED_PUSH_TARGET_LIMIT, type NotificationPayload, type NotificationResolvedTarget } from '@kemiri/protocol';

export type BrowserClear = { backendKey: string; resolved: NotificationResolvedTarget[] };

type VisibleCard = Pick<Notification, 'tag' | 'data' | 'close'>;

/** Also recognizes malformed clear envelopes so the worker can ignore them rather than showing a generic card. */
export function parseBrowserClear(input: unknown): BrowserClear | null {
	if (!input || typeof input !== 'object') return null;
	const value = input as Partial<NotificationPayload>;
	if (value.kind !== 'resolved' || typeof value.backendKey !== 'string' || !value.backendKey || !Array.isArray(value.resolved) ||
		value.resolved.length === 0 || value.resolved.length > RESOLVED_PUSH_TARGET_LIMIT ||
		!value.resolved.every(target => target && typeof target.tag === 'string' && target.tag &&
			typeof target.at === 'string' && Number.isFinite(Date.parse(target.at)) &&
			(target.key === undefined || typeof target.key === 'string'))) return null;
	return { backendKey: value.backendKey, resolved: value.resolved };
}

function closeMatching(cards: readonly VisibleCard[], backendKey: string, matches: (card: NotificationPayload) => boolean): void {
	for (const card of cards) {
		const payload = (card.data as { payload?: NotificationPayload } | null)?.payload;
		if (payload && payload.backendKey === backendKey && matches(payload)) card.close();
	}
}

export function closeExactBrowserCards(cards: readonly VisibleCard[], clear: BrowserClear): void {
	closeMatching(cards, clear.backendKey, card => clear.resolved.some(target =>
		target.tag === card.tag && target.at === card.at && target.key === card.key));
}

/** Live and replayed resolutions also work on browsers that require every background push to be user-visible. */
export async function closeBrowserCardsFromPage(backendKey: string, tags: readonly string[], at: string): Promise<void> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || tags.length === 0) return;
	const cutoff = Date.parse(at);
	const match = new Set(tags);
	try {
		const registrations = await navigator.serviceWorker.getRegistrations();
		await Promise.all(registrations.map(async registration => closeMatching(await registration.getNotifications(), backendKey,
			card => match.has(card.tag) && Date.parse(card.at) < cutoff)));
	} catch { /* A suspended worker or revoked permission does not affect in-app alert settlement. */ }
}
