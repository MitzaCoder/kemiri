import { describe, expect, test } from 'bun:test';
import type { ModelInfo, WorkerModel } from '@kemiri/protocol';
import { projectWorkerModelRows } from '../src/lib/worker-model-hint.ts';

const ref = (modelId: string, thinkingLevel: WorkerModel['thinkingLevel'] = null): WorkerModel => ({ provider: 'example', modelId, thinkingLevel });
const catalog = [
	{ ...ref('swift'), name: 'Swift', configured: false },
	{ ...ref('careful'), name: 'Careful', configured: true }
] as ModelInfo[];

describe('project worker model hint', () => {
	test('preserves project order, missing IDs, and per-model thinking', () => {
		expect(projectWorkerModelRows([ref('removed'), ref('careful', 'high'), ref('swift')], catalog, null)).toEqual([
			{ key: 'example/removed', name: 'removed', provider: 'example', order: 1, role: 'Unavailable', officialAgent: false, thinking: null },
			{ key: 'example/careful', name: 'Careful', provider: 'example', order: 2, role: 'Default', officialAgent: false, thinking: 'high' },
			{ key: 'example/swift', name: 'Swift', provider: 'example', order: 3, role: 'Fallback', officialAgent: false, thinking: null }
		]);
	});
	test('composer thinking overrides every candidate including off', () => {
		expect(projectWorkerModelRows([ref('swift', 'high'), ref('careful')], catalog, 'off').map(row => row.thinking)).toEqual(['off', 'off']);
	});
	test('credential status is not the server availability rule', () => {
		expect(projectWorkerModelRows([ref('swift'), ref('careful')], catalog, null).map(row => row.role)).toEqual(['Default', 'Fallback']);
	});
	test('empty settings do not invent a backend default', () => {
		expect(projectWorkerModelRows([], catalog, null)).toEqual([]);
		expect(projectWorkerModelRows([ref('removed')], [], null)[0]?.role).toBe('Unavailable');
	});
});
