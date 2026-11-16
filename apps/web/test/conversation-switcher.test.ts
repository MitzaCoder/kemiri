import { expect, test } from 'bun:test';
import type { ThreadSummary } from '@kemiri/protocol';
import { conversationChoices, conversationMenuIndex } from '../src/lib/conversation-switcher.ts';
const now = Date.parse('2026-11-16T12:00:00Z');
const job = (id: string, state: ThreadSummary['state'], age = 0): ThreadSummary => ({ id, title: id, state, archived: false, main: false, updatedAt: new Date(now - age).toISOString(), finishedAt: null } as ThreadSummary);

test('one list, Main chat first, state order and current marker independent of origin', () => {
 const threads = [job('paused','paused'),job('done','finished'),job('working','working'),job('failed','failed'),job('question','needs_you'),job('old','stopped',25*3600000),{...job('archived','working'),archived:true}, {...job('main','paused'),main:true}];
 const main = conversationChoices(threads,'demo','p',undefined,now);
 const inside = conversationChoices(threads,'demo','p','question',now);
 expect(main.main).toEqual({title:'Main chat',href:'/b/demo/projects/p',current:true});
 expect(inside.main.current).toBe(false);
 expect(main.visible.map(row=>row.title)).toEqual(['question','failed','working','paused','done']);
 expect(inside.visible.map(row=>row.href)).toEqual(main.visible.map(row=>row.href));
 expect(inside.visible.filter(row=>row.current).map(row=>row.title)).toEqual(['question']);
 expect(main.visible.every(row=>!row.current)).toBe(true);
 expect(main.finished.map(row=>row.title)).toEqual(['old']);
 expect(main.visible[0]!.href).toBe('/b/demo/projects/p/threads/question');
});

test('24 hour boundary stays visible, older settled rows fold even when current', () => {
 const list = conversationChoices([job('edge','finished',24*3600000),job('older','finished',24*3600000+1),job('paused','paused',48*3600000)],'b','p','older',now);
 expect(list.visible.map(row=>row.title)).toEqual(['paused','edge']);
 expect(list.finished[0]!.current).toBe(true);
});

test('keyboard arrows wrap, Home/End jump, Enter and Escape retain native activation/dismissal', () => {
 expect(conversationMenuIndex('ArrowDown',-1,5)).toBe(0);
 expect(conversationMenuIndex('ArrowDown',4,5)).toBe(0);
 expect(conversationMenuIndex('ArrowUp',0,5)).toBe(4);
 expect(conversationMenuIndex('ArrowUp',-1,5)).toBe(4);
 expect(conversationMenuIndex('Home',3,5)).toBe(0);
 expect(conversationMenuIndex('End',0,5)).toBe(4);
 for(const key of ['Enter','Escape','Tab']) expect(conversationMenuIndex(key,1,5)).toBeUndefined();
 expect(conversationMenuIndex('ArrowDown',0,0)).toBeUndefined();
});

test('header removes Background action; title owns counts and menu semantics at every width', async () => {
 const header = await Bun.file(new URL('../src/lib/components/ProjectChat.svelte',import.meta.url)).text();
 const switcher = await Bun.file(new URL('../src/lib/components/ConversationSwitcher.svelte',import.meta.url)).text();
 expect(header).not.toContain("label: 'Background jobs'");
 expect(header).not.toContain("id: 'background',");
 expect(header).toContain('{#if supportsThreads}');
 expect(header).toContain('counts={jobCounts}');
 expect(switcher).toContain('aria-haspopup="menu"');
 expect(switcher).not.toContain('aria-pressed');
 expect(switcher).toContain('aria-keyshortcuts="Alt+J"');
 expect(switcher).toContain('{counts.needsYou} needs you');
 expect(switcher).toContain('{counts.working} working');
 expect(switcher).toContain('All background jobs');
});
