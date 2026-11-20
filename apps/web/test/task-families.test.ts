import { describe, expect, test } from 'bun:test';
import {
	familyExpansionKey, loadFamilyExpansion, needsFamilyAttention, saveFamilyExpansion, taskFamilies, taskFamilySections, taskFamilyCount,
	type FamilyExpansion, type TaskFamily
} from '../src/lib/task-families.js';
import { taskSections, type TaskRow } from '../src/lib/tasks.js';
import { needsYouCount } from '../src/lib/kanban.js';

type BoardTask = TaskRow['task'];
type Question = TaskRow['waiting'][number];
function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
	return {
		id, title: `Example ${id}`, revision: 1, description: '', acceptance: null, refs: [],
		status: 'todo', blockedBy: [], blockedReason: null, writeScopes: [], workerIds: [], scheduleId: null,
		report: { now: '', results: '', next: '', revision: 0, updatedAt: null, updatedBy: null },
		snapshots: 0, order: Number(id.slice(1)), createdBy: 'user', updatedBy: 'user',
		createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z', settledAt: null, archived: false,
		...overrides
	};
}
function question(taskId: string, kind: 'question' | 'warning' = 'question'): Question {
	return { id: 'Q1', revision: 1, taskId, kind, text: 'Choose a sample label', options: [], status: 'open', answer: null } as Question;
}
function grouped(tasks: BoardTask[], questions: Question[] = [], expansion: FamilyExpansion = {}) {
	return taskFamilySections(taskSections({ tasks, questions })).map((section) => ({ section, families: taskFamilies(section, expansion) }));
}
function flattenFamilies(families: TaskFamily[]): TaskFamily[] {
	return families.flatMap(family => [family, ...flattenFamilies(family.children)]);
}
function visible(families: TaskFamily[]): string[] {
	return flattenFamilies(families).map(family => family.row.task.id);
}
function fullRowIds(families: TaskFamily[]): string[] {
	return flattenFamilies(families).filter(family => family.role === 'task').map(family => family.row.task.id);
}
const quietFamily = [task('T1'), task('T2', { parent: 'T1' }), task('T3', { parent: 'T2' }), task('T4')];

describe('collapsible task families', () => {
	test('quiet same-status families start collapsed; counts still include folded tasks', () => {
		const [{ section, families }] = grouped(quietFamily);
		expect(section!.rows).toHaveLength(4);
		expect(visible(families!)).toEqual(['T1', 'T4']);
		expect(families![0]).toMatchObject({ canToggle: true, expanded: false, foldedCount: 2 });
	});
	test('nested expansion is independent and preserved when an ancestor closes', () => {
		expect(visible(grouped(quietFamily, [], { T1: true })[0]!.families)).toEqual(['T1', 'T2', 'T4']);
		expect(visible(grouped(quietFamily, [], { T1: true, T2: true })[0]!.families)).toEqual(['T1', 'T2', 'T3', 'T4']);
		expect(visible(grouped(quietFamily, [], { T1: false, T2: true })[0]!.families)).toEqual(['T1', 'T4']);
	});
	test('parents precede children, while roots and siblings keep their priority', () => {
		const families = grouped([task('T3', { parent: 'T1', order: 0 }), task('T4', { order: 1 }), task('T1', { order: 2 }), task('T2', { parent: 'T1', order: 3 })], [], { T1: true })[0]!.families;
		expect(visible(families)).toEqual(['T4', 'T1', 'T3', 'T2']);
	});
	test('different statuses stay in their own groups at every depth', () => {
		const tasks = [
			task('T1', { status: 'in_progress' }), task('T2', { parent: 'T1', status: 'in_progress' }),
			task('T3', { parent: 'T1', status: 'review' }), task('T4', { parent: 'T2', status: 'blocked' }),
			task('T5', { parent: 'T1', status: 'waiting' }), task('T6', { parent: 'T1', status: 'done' }), task('T7', { parent: 'T1' })
		];
		const sections = grouped(tasks);
		for (const [id, taskId] of [['review', 'T3'], ['blocked', 'T4'], ['waiting', 'T5'], ['closed', 'T6'], ['todo', 'T7']]) {
			const families = sections.find(({ section }) => section.id === id)!.families;
			expect(visible(families)).toEqual([taskId!]);
			expect(families[0]!.row.task.parent).toBeDefined(); // UI renders the parent breadcrumb on root rows.
		}
		expect(visible(sections.find(({ section }) => section.id === 'working')!.families)).toEqual(['T1']);
	});
	for (const status of ['review', 'blocked', 'waiting'] as const) {
		test(`${status} descendants stay visible even when their same-status parent is collapsed`, () => {
			const families = grouped([task('T1', { status }), task('T2', { status, parent: 'T1' }), task('T3', { status, parent: 'T2' })], [], { T1: false, T2: false })[0]!.families;
			expect(visible(families)).toEqual(['T1', 'T2', 'T3']);
			expect(families[0]!.canToggle).toBe(false); // Never offer a toggle that does nothing.
		});
	}
	for (const kind of ['question', 'warning'] as const) {
		test(`an open ${kind} escapes a quiet family into Needs you`, () => {
			const sections = grouped(quietFamily, [question('T3', kind)]);
			expect(visible(sections.find(({ section }) => section.id === 'needs_you')!.families)).toEqual(['T3']);
			expect(visible(sections.find(({ section }) => section.id === 'todo')!.families)).toEqual(['T1', 'T4']);
		});
		test(`same-status nested open ${kind} cannot be folded even with saved false choices`, () => {
			const families = grouped(quietFamily.slice(0, 3), [question('T1', kind), { ...question('T2', kind), id: 'Q2' }, { ...question('T3', kind), id: 'Q3' }], { T1: false, T2: false })[0]!.families;
			expect(visible(families)).toEqual(['T1', 'T2', 'T3']);
		});
	}
	test('different statuses never nest even when both rows are in Needs you', () => {
		const families = grouped([task('T1'), task('T2', { parent: 'T1', status: 'blocked' })], [question('T1'), { ...question('T2'), id: 'Q2' }])[0]!.families;
		expect(families).toHaveLength(2);
		expect(families.every(({ children }) => children.length === 0)).toBe(true);
	});
	test('a status change immediately reveals a formerly folded child', () => {
		const before = grouped(quietFamily);
		expect(before.flatMap(({ families }) => visible(families))).not.toContain('T2');
		const after = grouped(quietFamily.map((entry) => entry.id === 'T2' ? { ...entry, status: 'review' } : entry));
		expect(after.find(({ section }) => section.id === 'review')!.families[0]!.row.task.id).toBe('T2');
	});
	test('archived and unavailable parents do not swallow their children', () => {
		const archived = task('T1', { archived: true });
		expect(visible(grouped([archived, task('T2', { parent: 'T1' })])[0]!.families)).toEqual(['T2']);
		expect(visible(grouped([task('T2', { parent: 'T404' })])[0]!.families)).toEqual(['T2']);
	});
	test('leaf rows have no disclosure, stale cycles and self-links do not lose tasks', () => {
		const families = grouped([task('T1', { parent: 'T2' }), task('T2', { parent: 'T1' }), task('T3', { parent: 'T3' })], [], { T1: true, T2: true })[0]!.families;
		expect(visible(families).sort()).toEqual(['T1', 'T2', 'T3']);
		expect(families.find(({ row }) => row.task.id === 'T3')!.canToggle).toBe(false);
	});
	test('unlinked rows remain flat on backends without task links', () => {
		expect(visible(grouped([task('T1'), task('T2')])[0]!.families)).toEqual(['T1', 'T2']);
	});
	test('attention rules do not treat ordinary work as an alert', () => {
		for (const status of ['todo', 'in_progress', 'done', 'dropped'] as const) expect(needsFamilyAttention({ task: task('T1', { status }), waiting: [], section: 'todo' })).toBe(false);
	});
});

describe('local family choices', () => {
	test('default is collapsed and keys isolate backend and project', () => {
		expect(loadFamilyExpansion('unused', undefined)).toEqual({});
		expect(familyExpansionKey('one', 'p')).not.toBe(familyExpansionKey('two', 'p'));
		expect(familyExpansionKey('one', 'p')).not.toBe(familyExpansionKey('one', 'q'));
	});
	test('keeps explicit false as well as nested true choices after reload', () => {
		const stored = new Map<string, string>();
		const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
		const key = familyExpansionKey('one', 'p');
		saveFamilyExpansion(key, { T1: false, T2: true }, storage);
		expect(loadFamilyExpansion(key, storage)).toEqual({ T1: false, T2: true });
		expect(loadFamilyExpansion(familyExpansionKey('two', 'p'), storage)).toEqual({});
	});
	test('corrupt, unavailable or blocked storage cannot break the list', () => {
		for (const text of ['no json', 'null', '[]', 'true']) expect(loadFamilyExpansion('key', { getItem: () => text })).toEqual({});
		expect(loadFamilyExpansion('key', { getItem: () => '{"T1":true,"T2":false,"T3":"yes","other":true}' })).toEqual({ T1: true, T2: false });
		expect(loadFamilyExpansion('key', { getItem: () => { throw new Error('blocked'); } })).toEqual({});
		expect(() => saveFamilyExpansion('key', { T1: true }, { setItem: () => { throw new Error('full'); } })).not.toThrow();
	});
});

function derived(id: string, group: NonNullable<BoardTask['state']>['group'], kind: NonNullable<BoardTask['state']>['kind'], parent?: string): BoardTask {
	return task(id, { parent, status: group === 'closed' ? kind === 'dropped' ? 'dropped' : 'done' : 'in_progress', state: { group, kind, since: '2026-11-05T10:00:00Z', refs: [] } });
}
describe('D94 families across derived groups', () => {
	const tasks = [derived('T1', 'in_progress', 'working'), derived('T2', 'closed', 'done', 'T1'), derived('T3', 'waiting', 'waiting_outside', 'T1'), derived('T4', 'todo', 'todo', 'T1'), derived('T5', 'closed', 'dropped', 'T1')];
	test('parts move to the parent group, finished last, and counts ignore folded parts', () => {
		const sections = grouped(tasks, [], { T1: true });
		expect(sections).toHaveLength(1);
		expect(visible(sections[0]!.families)).toEqual(['T1', 'T3', 'T4', 'T2', 'T5']);
		expect(taskFamilyCount(sections[0]!.section)).toBe(1);
		expect(visible(grouped(tasks)[0]!.families)).toEqual(['T1']);
	});
	test('each task appears once for any fold choice', () => {
		for (const kind of ['failed', 'answer_needed', 'steps_needed', 'review'] as const) {
			for (const [parentGroup, parentKind] of [['needs_you', 'review'], ['in_progress', 'working'], ['waiting', 'waiting_outside'], ['todo', 'todo'], ['closed', 'done']] as const) {
				const family = [derived('T1', parentGroup, parentKind), derived('T2', 'needs_you', kind, 'T1')];
				for (const expanded of [false, true]) {
					const sections = grouped(family, [], { T1: expanded });
					expect(sections.flatMap(({ families }) => fullRowIds(families)).sort()).toEqual(['T1', 'T2']);
					expect(fullRowIds(sections.find(({ section }) => section.id === 'needs_you')!.families)).toContain('T2');
				}
			}
		}
	});
	test('a Needs you parent cannot fold its attention parts and has no redundant toggle', () => {
		const family = [derived('T1', 'needs_you', 'answer_needed'), derived('T2', 'needs_you', 'review', 'T1')];
		const [{ families }] = grouped(family, [], { T1: false });
		expect(families).toHaveLength(1);
		expect(families[0]).toMatchObject({ role: 'task', canToggle: false, foldedCount: 0 });
		expect(fullRowIds(families[0]!.children)).toEqual(['T2']);
	});
	test('the chevron on an attention parent folds only quiet parts', () => {
		const family = [derived('T1', 'needs_you', 'review'), derived('T2', 'in_progress', 'working', 'T1'), derived('T3', 'needs_you', 'review', 'T1'), derived('T4', 'closed', 'done', 'T1')];
		const [{ families: folded }] = grouped(family);
		expect(folded[0]).toMatchObject({ canToggle: true, expanded: false, foldedCount: 2 });
		expect(fullRowIds(folded)).toEqual(['T1', 'T3']);
		const [{ families: opened }] = grouped(family, [], { T1: true });
		expect(fullRowIds(opened)).toEqual(['T1', 'T3', 'T2', 'T4']);
	});
	test('parts of a working parent share one header and have foldable pointers in its own section', () => {
		const family = [derived('T1', 'in_progress', 'working'), derived('T2', 'needs_you', 'review', 'T1'), derived('T3', 'needs_you', 'steps_needed', 'T1')];
		const [{ families: needsYou }, { families: working }] = grouped(family, [], { T1: true });
		expect(needsYou).toHaveLength(1);
		expect(needsYou[0]).toMatchObject({ role: 'parentHeader', canToggle: false, row: { section: 'in_progress', task: { id: 'T1' } } });
		expect(fullRowIds(needsYou)).toEqual(['T3', 'T2']);
		expect(working[0]!.children.map(({ role, row }) => [role, row.task.id])).toEqual([['pointer', 'T2'], ['pointer', 'T3']]);
		expect(grouped(family)[1]!.families[0]!.children).toEqual([]);
	});
	test('an archived or unavailable parent leaves a regular Needs you root with a parent link', () => {
		const child = derived('T2', 'needs_you', 'review', 'T1');
		const archived = { ...derived('T1', 'closed', 'done'), archived: true };
		for (const sections of [taskSections({ tasks: [child], questions: [] }), taskSections({ tasks: [archived, child], questions: [] }, { includeArchived: true })]) {
			const [needsYou] = taskFamilySections(sections);
			const roots = taskFamilies(needsYou!, {});
			expect(roots).toHaveLength(1);
			expect(roots[0]).toMatchObject({ role: 'task', row: { task: { id: 'T2', parent: 'T1' } } });
		}
	});
	test('a quiet child stays visible above an attention grandchild when both ancestors are folded', () => {
		const family = [derived('T1', 'needs_you', 'review'), derived('T2', 'in_progress', 'working', 'T1'), derived('T3', 'needs_you', 'failed', 'T2')];
		const [needsYou] = grouped(family);
		expect(fullRowIds(needsYou!.families)).toEqual(['T1', 'T2', 'T3']);
		expect(needsYou!.families[0]!.canToggle).toBe(false);
		expect(needsYou!.families[0]!.children[0]!.canToggle).toBe(false);
	});
	test('the count equals the number of tasks that need you regardless of folding', () => {
		const tasks = [derived('T1', 'needs_you', 'review'), derived('T2', 'in_progress', 'working', 'T1'), derived('T3', 'needs_you', 'review', 'T1'), derived('T4', 'todo', 'todo'), derived('T5', 'needs_you', 'steps_needed', 'T4')];
		for (const T1 of [false, true]) for (const T4 of [false, true]) {
			const [needsYou] = grouped(tasks, [], { T1, T4 });
			const attentionRows = flattenFamilies(needsYou!.families).filter(({ role, row }) => role === 'task' && row.task.state?.group === 'needs_you');
			expect(attentionRows).toHaveLength(3);
			expect(taskFamilyCount(needsYou!.section)).toBe(attentionRows.length);
			expect(taskFamilyCount(needsYou!.section)).toBe(needsYouCount({ tasks, questions: [] }));
		}
	});
	test('groups inherit their most urgent member, including a grandchild behind a quiet part', () => {
		const family = [derived('T1', 'needs_you', 'answer_needed'), derived('T2', 'needs_you', 'review', 'T1'), derived('T3', 'needs_you', 'review'), derived('T4', 'in_progress', 'working', 'T3'), derived('T5', 'needs_you', 'failed', 'T4'), derived('T6', 'needs_you', 'review', 'T3')];
		const [{ families }] = grouped(family);
		expect(families.map(({ row }) => row.task.id)).toEqual(['T3', 'T1']);
		expect(fullRowIds(families[0]!.children)).toEqual(['T6', 'T4', 'T5']);
	});
	test('derived cycles do not lose or clone tasks', () => {
		const family = [derived('T1', 'needs_you', 'review', 'T2'), derived('T2', 'in_progress', 'working', 'T1'), derived('T3', 'needs_you', 'steps_needed', 'T3')];
		expect(grouped(family, [], { T1: true, T2: true }).flatMap(({ families }) => fullRowIds(families)).sort()).toEqual(['T1', 'T2', 'T3']);
	});
	test('nested cross-group parents retain independent fold choices', () => {
		const family = [derived('T1', 'todo', 'todo'), derived('T2', 'waiting', 'waiting_outside', 'T1'), derived('T3', 'closed', 'done', 'T2')];
		expect(visible(grouped(family, [], { T1: true, T2: true })[0]!.families)).toEqual(['T1', 'T2', 'T3']);
		expect(visible(grouped(family, [], { T1: false, T2: true })[0]!.families)).toEqual(['T1']);
	});
	test('closed parents retain closed parts; filtered or archived parents leave root parts', () => {
		const family = [derived('T1', 'closed', 'done'), derived('T2', 'closed', 'done', 'T1')];
		expect(grouped(family)[0]!.section.id).toBe('closed');
		expect(visible(grouped(family, [], { T1: true })[0]!.families)).toEqual(['T1', 'T2']);
		expect(visible(grouped(family.slice(1))[0]!.families)).toEqual(['T2']);
		expect(visible(grouped([{ ...family[0]!, archived: true }, family[1]!])[0]!.families)).toEqual(['T2']);
	});
});
