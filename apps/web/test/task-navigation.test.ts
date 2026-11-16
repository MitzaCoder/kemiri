import { describe, expect, test } from 'bun:test';
import { drillIntoTask } from '../src/lib/task-navigation.ts';

describe('task history trail', () => {
 test('starts at the task opened from, regardless of its relationship', () => {
  const from = { id: 'T12', title: 'Release checklist' };
  for (const to of ['T13', 'T2', 'T99']) expect(drillIntoTask(undefined, from, to)).toEqual([from]);
 });
 test('drill-down retains the complete trail without mutating earlier entries', () => {
  const first = { id: 'T12', title: 'Release checklist' };
  const trail = drillIntoTask(undefined, first, 'T13')!;
  expect(drillIntoTask(trail, { id: 'T13', title: 'Keyboard checks' }, 'T14')).toEqual([first, { id: 'T13', title: 'Keyboard checks' }]);
  expect(trail).toEqual([first]);
 });
 test('a fresh opening starts a new trail and self-links add no entry', () => {
  expect(drillIntoTask(undefined, { id: 'T20', title: 'Fresh task' }, 'T21')).toEqual([{ id: 'T20', title: 'Fresh task' }]);
  expect(drillIntoTask([], { id: 'T20', title: 'Fresh task' }, 'T20')).toBeUndefined();
 });
});
