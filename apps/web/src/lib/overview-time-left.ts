import type { OverviewTimeLeft } from '@kemiri/protocol';

const reasons: Record<Extract<OverviewTimeLeft, { kind: 'none' }>['reason'], string> = {
	not_started: 'Not started.', no_parts: 'Not split into parts yet.', not_enough_history: 'Not enough history yet.',
	outside_wait: 'Waiting on something outside this request.', wide_range: 'The range is too wide to be useful.',
	all_parts_done: 'All parts are done.', already_reviewed: 'Already reached its first review.'
};

export function overviewEstimateMinutes(minutes: number): string {
	if (minutes > 360) return 'more than 6 h';
	if (minutes < 5) return 'under 5 min';
	if (minutes < 60) return `${minutes} min`;
	const fraction = ({ 15: '¼', 30: '½', 45: '¾' } as Record<number, string>)[minutes % 60] ?? '';
	return `${Math.floor(minutes / 60)}${fraction} h`;
}

function rangeText(low: number, high: number): string {
	if (low > 360) return 'The range starts above 6 h';
	const start = overviewEstimateMinutes(low);
	return low === high ? start : `${start} to ${overviewEstimateMinutes(high)}`;
}

export function overviewEstimateOverrun(estimate: OverviewTimeLeft | undefined, elapsedMs: number): boolean {
	if (estimate?.kind === 'range') return !!estimate.overrun || (estimate.overrunInMs !== undefined && elapsedMs >= estimate.overrunInMs);
	if (estimate?.kind === 'usual') return estimate.longer || elapsedMs >= estimate.longerInMs;
	return false;
}

export function overviewEstimateText(estimate: OverviewTimeLeft, elapsedMs: number): { heading: string; detail: string; basis?: string } {
	const longer = overviewEstimateOverrun(estimate, elapsedMs);
	const rangeBasis = (basis: 'coordinator' | 'project') => basis === 'project' ? 'Based on project history' : 'Based on this coordinator’s history';
	switch (estimate.kind) {
		case 'range': return longer ? { heading: 'Running longer than estimated', detail: 'The first range has passed.' } : {
			heading: `About ${overviewEstimateMinutes(estimate.minutes)}`, detail: `${rangeText(estimate.low, estimate.high)} of agent work`, basis: rangeBasis(estimate.basis),
		};
		case 'usual': return longer ? { heading: 'Longer than usual', detail: 'For a request without parts.' } : {
			heading: `Usually ${rangeText(estimate.low, estimate.high)}`, detail: 'For a request without parts.', basis: rangeBasis(estimate.basis),
		};
		case 'stopped': return estimate.then ? {
			heading: 'Stopped', detail: `Then about ${overviewEstimateMinutes(estimate.then.minutes)} (${rangeText(estimate.then.low, estimate.then.high)}).`, basis: rangeBasis(estimate.then.basis),
		} : { heading: 'Stopped', detail: estimate.reason === 'review' ? 'Waiting for review.' : 'Waiting on you.' };
		case 'none': return { heading: 'No estimate', detail: reasons[estimate.reason] };
	}
}
