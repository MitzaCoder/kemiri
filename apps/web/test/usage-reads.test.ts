import { describe, expect, test } from 'bun:test';
import { UsageReads, type UsageRead } from '../src/lib/usage-reads.ts';

const studio = { id: 'studio' };
const workshop = { id: 'workshop' };
const ready = (computer: typeof studio) => ({ computer, ready: true });
const settled = () => Promise.resolve();

function usageReads() {
	let reads: UsageRead<typeof studio, number>[] = [];
	const usage = new UsageReads<typeof studio, number>((_, next) => { reads = next; });
	return { usage, reads: () => reads };
}

describe('usage reads', () => {
	test('keeps the last successful report during refresh and after failure, but accepts a successful zero', async () => {
		const { usage, reads } = usageReads();
		const targets = [ready(studio)];
		usage.sync('rolling', targets, 0, async () => 12);
		await settled();
		const refresh = Promise.withResolvers<number>();
		usage.sync('rolling', targets, 1, () => refresh.promise);
		expect(reads()[0]).toMatchObject({ loading: true, report: 12 });
		refresh.reject(new Error('Timed out'));
		await settled();
		expect(reads()[0]).toMatchObject({ loading: false, report: 12, error: 'Timed out' });
		usage.sync('rolling', targets, 2, async () => 0);
		await settled();
		expect(reads()[0]).toEqual({ computer: studio, loading: false, report: 0 });
	});

	test('only rereads the affected computer on reconnect and retains both reports', async () => {
		const { usage, reads } = usageReads();
		const targets = [ready(studio), ready(workshop)];
		const calls: string[] = [];
		const load = async (computer: typeof studio) => calls.push(computer.id);
		usage.sync('rolling', targets, 0, load);
		await settled();
		usage.sync('rolling', [{ computer: studio, ready: false }, ready(workshop)], 0, load);
		expect(reads().map(read => read.report)).toEqual([1, 2]);
		usage.sync('rolling', targets, 0, load);
		usage.sync('rolling', targets, 0, load);
		expect(calls).toEqual(['studio', 'workshop', 'studio']);
		expect(reads()[0]).toMatchObject({ loading: true, report: 1 });
		await settled();
		expect(reads().map(read => read.report)).toEqual([3, 2]);
	});

	test('a changed period and selection discard unrelated reports and late replies', async () => {
		const { usage, reads } = usageReads();
		const oldReply = Promise.withResolvers<number>();
		usage.sync('rolling', [ready(studio), ready(workshop)], 0, computer => computer === studio ? oldReply.promise : Promise.resolve(30));
		await settled();
		usage.sync('today', [ready(workshop)], 0, async () => 5);
		expect(reads()).toEqual([{ computer: workshop, loading: true, report: undefined }]);
		oldReply.resolve(99);
		await settled();
		expect(reads()).toEqual([{ computer: workshop, loading: false, report: 5 }]);
	});
});
