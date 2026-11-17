import { describe, expect, test } from 'bun:test';
import type { MemoryMaintenanceRun } from '@kemiri/protocol';
import { memoryFailureStreak, memoryFailureWarning, memoryRunRows, shortMemoryReason } from '../src/lib/memory.ts';
const run = (outcome: MemoryMaintenanceRun['outcome'], message: string | null = 'Service unavailable'): MemoryMaintenanceRun => ({ at: '2026-11-04T18:30:00Z', trigger: 'nightly', outcome, message, commit: null });

describe('maintenance run history', () => {
	test('older backends and empty history add no warning', () => {
		expect(memoryFailureStreak(undefined)).toBe(0);
		expect(memoryFailureStreak([])).toBe(0);
		expect(memoryFailureWarning(undefined)).toBeUndefined();
		expect(memoryRunRows([], Date.now())).toEqual([]);
	});
	test('one failure is not a repeated failure warning', () => {
		expect(memoryFailureStreak([run('failed'), run('ok')])).toBe(1);
		expect(memoryFailureWarning([run('failed')])).toBeUndefined();
	});
	test('counts only consecutive newest failures, including an all-failed window', () => {
		expect(memoryFailureStreak([run('failed'), run('failed'), run('ok'), run('failed')])).toBe(2);
		expect(memoryFailureStreak(Array.from({ length: 10 }, () => run('failed')))).toBe(10);
		expect(memoryFailureWarning([run('failed'), run('failed'), run('failed')])).toBe('The last 3 maintenance runs failed: Service unavailable');
	});
	test('both successful outcomes break the streak', () => {
		for (const outcome of ['ok', 'nothing_to_do'] as const) {
			expect(memoryFailureStreak([run(outcome), run('failed'), run('failed')])).toBe(0);
			expect(memoryFailureWarning([run(outcome), run('failed'), run('failed')])).toBeUndefined();
		}
	});
	test('shortens and flattens reasons without changing the full text', () => {
		const message = '  Service\n unavailable\t ' + '😀'.repeat(100);
		const rows = memoryRunRows([run('failed', message)], Date.parse('2026-11-04T19:00:00Z'));
		expect(rows[0]!.run.message).toBe(message);
		expect([...rows[0]!.reason!]).toHaveLength(100);
		expect(rows[0]!.reason!.endsWith('…')).toBe(true);
		expect(shortMemoryReason('  short\n reason ')).toBe('short reason');
		expect(shortMemoryReason('a'.repeat(100))).toBe('a'.repeat(100));
	});
	test('missing or blank reasons are explained, including in the warning', () => {
		for (const reason of [null, '', ' \n ']) expect(shortMemoryReason(reason)).toBe('No failure reason was recorded.');
		expect(memoryFailureWarning([run('failed', null), run('failed')])).toContain('No failure reason was recorded.');
	});
	test('preserves server order, trigger, outcomes, exact time and commit', () => {
		const runs = [run('failed'), { ...run('ok'), trigger: 'manual' as const, commit: '123456789' }, { ...run('nothing_to_do'), trigger: 'writes' as const }];
		const rows = memoryRunRows(runs, Date.parse('2026-11-04T19:00:00Z'));
		expect(rows.map(row => row.trigger)).toEqual(['Nightly', 'Manual', 'After writes']);
		expect(rows.map(row => row.outcome)).toEqual(['failed', 'changed memory', 'nothing to do']);
		expect(rows.map(row => row.mark)).toEqual(['!', '✓', '–']);
		expect(rows[0]!.when).toBe('30 min ago');
		expect(rows[0]!.whenTitle.length).toBeGreaterThan(0);
		expect(rows[1]!.run.commit).toBe('123456789');
		expect(rows[1]!.reason).toBeUndefined();
	});
});
