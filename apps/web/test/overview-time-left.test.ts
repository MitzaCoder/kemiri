import { expect, test } from 'bun:test';
import { overviewEstimateText } from '../src/lib/overview-time-left.js';

const range = { kind: 'range', minutes: 90, low: 30, high: 180, basis: 'project', overrunInMs: 60_000 } as const;

test('agent work has a rounded amount and range, and the device marks an overrun without moving it', () => {
	expect(overviewEstimateText(range, 59_000)).toEqual({ heading: 'About 1½ h', detail: '30 min to 3 h of agent work', basis: 'Based on project history' });
	expect(overviewEstimateText(range, 60_000)).toEqual({ heading: 'Running longer than estimated', detail: 'The first range has passed.' });
});

test('stopped and unknown states have no countdown', () => {
	expect(overviewEstimateText({ kind: 'stopped', reason: 'owner_wait', then: range }, 12 * 60_000)).toMatchObject({ heading: 'Stopped', detail: 'Then about 1½ h (30 min to 3 h).' });
	expect(overviewEstimateText({ kind: 'none', reason: 'not_enough_history' }, 0)).toEqual({ heading: 'No estimate', detail: 'Not enough history yet.' });
	expect(overviewEstimateText({ kind: 'usual', low: 15, high: 40, basis: 'coordinator', runningSince: '2026-04-01T14:00:00Z', longerInMs: 90_000, longer: false }, 0)).toMatchObject({ heading: 'Usually 15 min to 40 min', detail: 'For a request without parts.' });
});
