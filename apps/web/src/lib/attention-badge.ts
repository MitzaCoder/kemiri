import type { AlertRow } from './alerts.js';
import { needsYouTotal, type ProjectAttentionLink } from './sidebar-attention.js';

export const URGENT_FAVICON = '/favicon-urgent.svg';

/** The count is live Needs you; the red dot is an unresolved urgent alert, even if already read. */
export function attentionBadge(links: readonly Pick<ProjectAttentionLink, 'count'>[], latestAlerts: readonly AlertRow[], enabled = true): { count: number; urgent: boolean } {
	return enabled ? { count: needsYouTotal(links), urgent: latestAlerts.some(({ done, alert }) => !done && alert.level === 'urgent') }
		: { count: 0, urgent: false };
}

export function attentionTabTitle(baseTitle: string, count: number): string {
	return count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}
