import { requestPartRows } from './request-parts.js';
import { isSettled, type TaskRow, type TaskSection } from './tasks.js';

export type FamilyExpansion = Readonly<Record<string, boolean>>;
export type TaskFamily = {
	row: TaskRow;
	role: 'task' | 'parentHeader' | 'pointer';
	children: TaskFamily[];
	canToggle: boolean;
	expanded: boolean;
	foldedCount: number;
	doneParts?: number;
};

/** List-only grouping: search and board keep the ordinary state sections. */
export function taskFamilySections(sections: TaskSection[], requestAttention = false): TaskSection[] {
	if (requestAttention) return sections.map(section => ({ ...section, rows: section.rows.filter(row => row.task.parent == null) })).filter(section => section.rows.length > 0);
	const rows = sections.flatMap(section => section.rows);
	const byId = new Map(rows.map(row => [row.task.id, row]));
	function familySection(row: TaskRow): TaskRow['section'] {
		const seen = new Set([row.task.id]);
		let ancestor = row;
		while (ancestor.task.state && ancestor.task.parent) {
			const parent = byId.get(ancestor.task.parent);
			if (!parent?.task.state) break;
			if (seen.has(parent.task.id)) return row.section;
			seen.add(parent.task.id);
			ancestor = parent;
		}
		return ancestor.section;
	}
	const destinations = new Map(rows.map(row => [row.task.id, familySection(row)]));
	return sections.map(section => {
		const sectionRows = rows.filter(row => destinations.get(row.task.id) === section.id ||
			(section.id === 'needs_you' && needsYou(row)));
		if (section.id !== 'needs_you') return { ...section, rows: sectionRows };
		const taskIds = new Set(sectionRows.map(row => row.task.id));
		const parentRows = new Map<string, TaskRow>();
		for (const row of sectionRows) {
			const parent = row.task.parent == null ? undefined : byId.get(row.task.parent);
			if (needsYou(row) && parent?.task.state && !parent.task.archived && !taskIds.has(parent.task.id)) {
				parentRows.set(parent.task.id, { ...parent, section: destinations.get(parent.task.id) ?? parent.section });
			}
		}
		return { ...section, rows: sectionRows, parentRows: [...parentRows.values()] };
	}).filter(section => section.rows.length > 0);
}

function needsYou(row: TaskRow): boolean {
	return row.task.state?.group === 'needs_you';
}

/** Count attention tasks in Needs you and top-level tasks in other derived sections, regardless of folds. */
export function taskFamilyCount(section: TaskSection, requestAttention = false): number {
	if (requestAttention || !section.rows.some(row => row.task.state)) return section.rows.length;
	if (section.id === 'needs_you') return section.rows.filter(needsYou).length;
	return taskFamilies(section, {}).length;
}

/** Section attention and the legacy no-fold rule. */
export function needsFamilyAttention(row: TaskRow): boolean {
	return row.waiting.length > 0 || (row.task.state ? ['needs_you', 'waiting'].includes(row.task.state.group) : ['review', 'blocked', 'waiting'].includes(row.task.status));
}

/**
 * Derived families nest across states; legacy families still require the same status and section.
 * Needs you groups take the priority of their most urgent member; quiet parts stay foldable.
 */
export function taskFamilies(section: TaskSection, expansion: FamilyExpansion, partsByRequest?: ReadonlyMap<string, readonly TaskRow[]>): TaskFamily[] {
	if (partsByRequest) return section.rows.map(row => {
		const parts = section.id === 'needs_you' || section.id === 'closed' ? [] : partsByRequest.get(row.task.id) ?? [];
		const doneParts = section.id === 'needs_you' || section.id === 'closed' ? 0 :
			(row.task.partsDigest?.parts.filter(part => part.state === 'done').length ?? parts.filter(part => part.task.status === 'done').length);
		const canToggle = parts.length > 0 || doneParts > 0;
		const expanded = canToggle && expansion[row.task.id] === true;
		const children = expanded ? requestPartRows(parts).map(part => ({ row: part, role: 'task' as const, children: [], canToggle: false, expanded: false, foldedCount: 0 })) : [];
		return { row, role: 'task', children, canToggle, expanded, foldedCount: parts.length, doneParts: expanded ? doneParts : 0 };
	});
	const inNeedsYou = section.id === 'needs_you';
	const byId = new Map(section.rows.map((row) => [row.task.id, row]));
	const needsYouPriority = new Map(section.rows.flatMap((row, index) => needsYou(row) ? [[row.task.id, index] as const] : []));
	const priority = (row: TaskRow) => needsYouPriority.get(row.task.id) ?? Infinity;
	const parents = new Map<string, string>();
	for (const row of section.rows) {
		const parent = row.task.parent == null ? undefined : byId.get(row.task.parent);
		if (parent && !(inNeedsYou && needsYou(row) && parent.task.archived) &&
			((parent.task.state && row.task.state) || parent.task.status === row.task.status) && parent.task.id !== row.task.id) parents.set(row.task.id, parent.task.id);
	}
	// A partial/stale board must not lose tasks to a cycle, even though the server rejects cycles.
	for (const id of parents.keys()) {
		const seen = new Set([id]);
		let ancestor = parents.get(id);
		while (ancestor !== undefined) {
			if (seen.has(ancestor)) { parents.delete(id); break; }
			seen.add(ancestor);
			ancestor = parents.get(ancestor);
		}
	}
	const children = new Map<string, TaskRow[]>();
	for (const row of section.rows) {
		const parent = parents.get(row.task.id);
		if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), row]);
	}
	const attention = new Map<string, boolean>();
	function mustShow(row: TaskRow): boolean {
		const cached = attention.get(row.task.id);
		if (cached !== undefined) return cached;
		const required = (row.task.state
			? needsYou(row) ? inNeedsYou : row.waiting.length > 0 && !isSettled(row.task.status)
			: needsFamilyAttention(row)) || (children.get(row.task.id) ?? []).some(mustShow);
		attention.set(row.task.id, required);
		return required;
	}
	function branchCount(row: TaskRow): number {
		return 1 + (children.get(row.task.id) ?? []).reduce((count, child) => count + branchCount(child), 0);
	}
	function family(row: TaskRow): TaskFamily {
		const nested = [...(children.get(row.task.id) ?? [])];
		if (row.task.state) nested.sort((a, b) =>
			(inNeedsYou && priority(a) !== priority(b) ? priority(a) - priority(b) : 0) ||
			Number(isSettled(a.task.status)) - Number(isSettled(b.task.status)) || a.task.order - b.task.order);
		const canToggle = nested.some((child) => !mustShow(child));
		const expanded = canToggle && expansion[row.task.id] === true;
		const visible = nested.filter((child) => expanded || mustShow(child));
		return {
			row, role: !inNeedsYou && needsYou(row) ? 'pointer' : 'task', canToggle, expanded,
			children: visible.map(family),
			foldedCount: nested.filter((child) => !expanded && !mustShow(child)).reduce((count, child) => count + branchCount(child), 0)
		};
	}
	const roots = section.rows.filter(row => !parents.has(row.task.id));
	if (!inNeedsYou || needsYouPriority.size === 0) return roots.map(family);

	const headerRows = new Map(section.parentRows?.map(row => [row.task.id, row]));
	const headers = new Map<string, TaskFamily>();
	const groups: TaskFamily[] = [];
	for (const row of roots) {
		const parent = row.task.parent == null ? undefined : headerRows.get(row.task.parent);
		if (!parent || !needsYou(row)) {
			groups.push(family(row));
			continue;
		}
		let header = headers.get(parent.task.id);
		if (!header) {
			header = { row: parent, role: 'parentHeader', children: [], canToggle: false, expanded: true, foldedCount: 0 };
			headers.set(parent.task.id, header);
			groups.push(header);
		}
		header.children.push(family(row));
	}
	function groupPriority(group: TaskFamily): number {
		return group.children.reduce((best, child) => Math.min(best, groupPriority(child)), priority(group.row));
	}
	return groups.map(group => ({ group, priority: groupPriority(group) }))
		.sort((a, b) => a.priority === b.priority ? 0 : a.priority - b.priority)
		.map(({ group }) => group);
}

export const FAMILY_EXPANSION_KEY = 'aiki.task-families.v1';

/** Scope choices to backend/project, not just T1, which exists on every board. */
export function familyExpansionKey(backendId: string, projectId: string): string {
	return `${FAMILY_EXPANSION_KEY}:${encodeURIComponent(backendId)}:${encodeURIComponent(projectId)}`;
}

export function loadFamilyExpansion(key: string, storage: Pick<Storage, 'getItem'> | undefined): Record<string, boolean> {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([id, expanded]) => /^T\d+$/.test(id) && typeof expanded === 'boolean'));
	} catch { return {}; }
}

export function saveFamilyExpansion(key: string, expansion: FamilyExpansion, storage: Pick<Storage, 'setItem'> | undefined): void {
	try { storage?.setItem(key, JSON.stringify(expansion)); } catch { /* Keep in-memory choices when storage is unavailable. */ }
}
