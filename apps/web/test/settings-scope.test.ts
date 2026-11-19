import { describe, expect, test } from 'bun:test';
import { parseLastProject, resolveSettingsComputer, resolveSettingsProject } from '../src/lib/settings-scope.ts';

const bakery = { backendId: 'studio', projectId: 'bakery' };
const garden = { backendId: 'travel', projectId: 'garden' };
const studio = { id: 'studio', ready: true, projectsLoaded: true, projects: [{ id: 'archived', archived: true }, { id: 'bakery' }] };
const travel = { id: 'travel', ready: true, projectsLoaded: true, projects: [{ id: 'garden' }] };

describe('settings scopes', () => {
	test('project context wins over local memory, then a ready computer supplies a project', () => {
		const computers = [studio, travel];
		expect(resolveSettingsProject(computers, garden, bakery)).toEqual(garden);
		expect(resolveSettingsProject(computers, undefined, garden)).toEqual(garden);
		expect(resolveSettingsProject(computers, undefined, undefined)).toEqual(bakery);
		expect(resolveSettingsProject([{ ...studio, ready: false }, travel], undefined, undefined)).toEqual(garden);
	});
	test('local memory keeps an unloaded project but not a deleted project or computer', () => {
		expect(parseLastProject(JSON.stringify(bakery))).toEqual(bakery);
		for (const raw of [null, '{', 'null', '{"projectId":"bakery"}']) expect(parseLastProject(raw)).toBeUndefined();
		expect(resolveSettingsProject([{ ...studio, ready: false, projectsLoaded: false, projects: [] }], undefined, bakery)).toEqual(bakery);
		expect(resolveSettingsProject([{ ...studio, projects: [] }, travel], undefined, bakery)).toEqual(garden);
		expect(resolveSettingsProject([], bakery, garden)).toBeUndefined();
	});
	test('computer scope uses the project context, the sole computer, or the last used computer', () => {
		expect(resolveSettingsComputer([studio, travel], garden, 'studio')).toBe('travel');
		expect(resolveSettingsComputer([studio], garden, 'travel')).toBe('studio');
		expect(resolveSettingsComputer([studio, travel], undefined, 'travel')).toBe('travel');
		expect(resolveSettingsComputer([{ ...studio, ready: false }, travel], undefined, 'missing')).toBe('travel');
		expect(resolveSettingsComputer([], undefined, null)).toBeUndefined();
	});
});
