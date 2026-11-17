import { describe, expect, test } from 'bun:test';
import { maxLoopingWorkers, workerMotion, workerMotionBudget, workerMotionDelay, type WorkerMotionCandidate } from '../src/lib/worker-motion.js';

describe('workerMotion', () => {
	const task = { id: 'T1', status: 'todo' as const };
	const question = { taskId: 'T1', status: 'open' as const };
	test('status wins over asks and review; stopped is done, not working', () => {
		const review = { ...task, status: 'review' as const };
		for (const [status, expected] of [['running', 'working'], ['failed', 'failed'], ['done', 'done'], ['stopped', 'done']] as const) {
			expect(workerMotion({ status }, review, [question])).toBe(expected);
			expect(workerMotion({ status }, null, [])).toBe(expected);
		}
	});
	test('idle review or a blocking open ask waits; ordinary open work sleeps', () => {
		expect(workerMotion({ status: 'idle' }, { ...task, status: 'review' }, [])).toBe('waiting');
		expect(workerMotion({ status: 'idle' }, task, [question])).toBe('waiting');
		expect(workerMotion({ status: 'idle' }, task, [{ ...question, kind: 'warning', blocksWork: true }])).toBe('waiting');
		expect(workerMotion({ status: 'idle' }, task, [])).toBe('sleeping');
	});
	test('answered, withdrawn, other-task, agent-waiting and nonblocking entries are not waiting cues', () => {
		for (const ignored of [
			{ ...question, status: 'answered' as const }, { ...question, status: 'withdrawn' as const },
			{ ...question, taskId: 'T2' }, { ...question, taskId: null },
			{ ...question, waitingOn: 'agent' as const }, { ...question, blocksWork: false },
			{ ...question, kind: 'warning' as const },
		]) expect(workerMotion({ status: 'idle' }, task, [ignored])).toBe('sleeping');
	});
	test('closed or absent tasks rest even if stale asks remain open', () => {
		for (const absent of [null, undefined, { ...task, status: 'done' as const }, { ...task, status: 'dropped' as const }]) {
			expect(workerMotion({ status: 'idle' }, absent, [question])).toBe('sleeping');
		}
	});
});

describe('workerMotionBudget', () => {
	const workers: WorkerMotionCandidate[] = Array.from({ length: 20 }, (_, index) => ({ id: `worker-${index}`, state: 'working', inView: true }));
	test('at most 12 visible loops, including sleeping and waiting; stable across board order', () => {
		const mixed = workers.map((worker, index) => ({ ...worker, state: (['working', 'waiting', 'sleeping'] as const)[index % 3]! }));
		const budget = workerMotionBudget(mixed, 1);
		expect([...budget.values()].filter(allowance => allowance.looping)).toHaveLength(maxLoopingWorkers);
		expect(workerMotionBudget([...mixed].reverse(), 1)).toEqual(budget);
		expect([...budget.values()].every(allowance => !allowance.still)).toBe(true);
	});
	test('offscreen and finite poses do not spend loop slots', () => {
		const candidates = workers.map((worker, index) => ({ ...worker, inView: index >= 5 }));
		candidates.push({ id: 'failed', state: 'failed', inView: true }, { id: 'done', state: 'done', inView: true });
		const budget = workerMotionBudget(candidates, 1);
		expect(budget.get('worker-0')).toMatchObject({ looping: false, still: true });
		expect(budget.get('failed')).toMatchObject({ looping: false, still: false });
		expect(budget.get('done')).toMatchObject({ looping: false, still: false });
		expect([...budget.values()].filter(allowance => allowance.looping)).toHaveLength(12);
	});
	test('below 50% zoom or reduced motion everything is still, including one-shots', () => {
		for (const [zoom, reduced] of [[.499, false], [1, true], [NaN, false]] as const) {
			expect([...workerMotionBudget(workers, zoom, reduced).values()].every(allowance => !allowance.looping && allowance.still)).toBe(true);
		}
		expect([...workerMotionBudget(workers, .5).values()].some(allowance => allowance.looping)).toBe(true);
	});
	test('negative per-ID phase stays stable across camera changes and differs among workers', () => {
		const phases = workers.map(worker => workerMotionDelay(worker.id));
		expect(new Set(phases).size).toBe(workers.length);
		expect(phases.every(phase => phase <= 0 && phase > -6000)).toBe(true);
		for (const zoom of [.2, 1, 2]) for (const worker of workers) {
			expect(workerMotionBudget(workers, zoom).get(worker.id)?.delayMs).toBe(workerMotionDelay(worker.id));
		}
	});
});
