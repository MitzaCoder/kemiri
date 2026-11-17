import { expect, test } from 'bun:test';
import type { ThreadSummary, BoardQuestion } from '@kemiri/protocol';
import { backgroundJobBandText, openBackgroundJobLabel } from '../src/lib/background-job-page.ts';
import { questionPin, inThread } from '../src/lib/threads.ts';
const now = Date.parse('2026-11-16T12:00:00Z');
const thread = (changes: Partial<ThreadSummary> = {}): ThreadSummary => ({id:'photo',title:'Photo library audit',state:'working',status:'running',startedBy:'main',createdAt:new Date(now-7200000).toISOString(),updatedAt:new Date(now-3600000).toISOString(),finishedAt:null,runningWorkers:0,openQuestions:0,...changes} as ThreadSummary);
const source = (name: string) => Bun.file(new URL(`../src/lib/components/${name}.svelte`,import.meta.url)).text();

test('band names its starter, time, and report destination', () => {
 const main = backgroundJobBandText(thread(),now);
 expect(main.origin).toContain('started by Main chat');
 expect(main.origin).toContain('2 h ago');
 expect(main.outcome).toBe('reports back there when it finishes');
 expect(backgroundJobBandText(thread({startedBy:'user'}),now).origin).toContain('started by you');
 expect(backgroundJobBandText(thread({startedBy:'schedule'}),now,'Nightly inventory').origin).toContain('started by schedule Nightly inventory');
 expect(backgroundJobBandText(thread({startedBy:'schedule'}),now).origin).toContain('schedule');
});

test('every state has accurate outcome and Stop availability, including legacy servers', () => {
 for(const state of ['needs_you','working','paused','failed','finished','stopped'] as const){
  const view=backgroundJobBandText(thread({state}),now);
  expect(view.canStop).toBe(state!=='finished'&&state!=='stopped');
  if(state==='failed') { expect(view.outcome).toContain('Failed'); expect(view.outcome).toContain('retry'); }
  else if(state==='finished') expect(view.outcome).toContain('its report is in Main chat');
  else if(state==='stopped') expect(view.outcome).toContain('Main chat keeps what it reported so far');
  else expect(view.outcome).toContain('reports back');
 }
 expect(backgroundJobBandText(thread({state:undefined,status:'done'}),now).canStop).toBe(false);
 expect(backgroundJobBandText(thread({state:'finished',finishedAt:new Date(now-7200000).toISOString()}),now).outcome).toContain('Finished 2 h ago');
});

test('job questions exclude other askers and switch the chosen question', () => {
 const questions = [{id:'Q1',threadId:'photo'},{id:'Q2',threadId:'photo'},{id:'Q3',threadId:'main'},{id:'Q4',threadId:'catalogue'}] as BoardQuestion[];
 const own=questions.filter(question=>inThread(question,'photo'));
 expect(questionPin(own,undefined).current?.id).toBe('Q1');
 expect(questionPin(own,'Q2').current?.id).toBe('Q2');
 expect(questionPin(own,'Q2').others.map(question=>question.id)).toEqual(['Q1']);
});

test('job band owns the question, main link and shared stop flow; composer pin stays on main only', async () => {
 const chat=await source('ProjectChat'), band=await source('BackgroundJobBand'), panel=await source('BackgroundPanel'), stop=await source('ThreadStopButton');
 expect(chat).toContain('{#if isThread && thread && threads}');
 expect(chat).toContain('<BackgroundJobBand');
 expect(chat).not.toContain('Background job of');
 expect(chat).toContain('{#if !isThread && board !== undefined && hasOpenQuestions');
 expect(chat).toContain("questions.some(question => question.status === 'open')");
 expect(chat).toContain('{#if isThread}<p');
 expect(chat).toContain("The main chat does not see what you write here, only the job's report.");
 expect(band).toContain('It is waiting for your answer');
 expect(band).toContain('compact strip onanswer=');
 expect(band).toContain('board!.answer(question.id, question.revision, answer)');
 expect(band).toContain('+{waiting.length - 1} more');
 expect(band).toContain('href={mainHref}');
 expect(band).not.toContain('conversationBack');
 expect(band).toContain('{#if text.canStop}<ThreadStopButton');
 expect(panel).toContain('<ThreadStopButton');
 expect(stop).toContain('Its running turn and its workers are aborted');
 expect(stop).toContain('Keep it running');
 expect(stop).toContain('disabled={busy}');
 expect(stop).toContain('threads.stopThread(thread.id)');
});

test('sidebar identifies only the open job, with live title or ID fallback', async () => {
 expect(openBackgroundJobLabel(undefined,[thread()])).toBeUndefined();
 expect(openBackgroundJobLabel('main',[thread()])).toBeUndefined();
 expect(openBackgroundJobLabel('photo',[thread()])).toBe('Open: Photo library audit');
 expect(openBackgroundJobLabel('unknown',[])).toBe('Open: unknown');
 const sidebar=await source('ProjectsSidebar');
 expect(sidebar).toContain('isCurrent(backend.id, project.id) && openJob');
 expect(sidebar).toContain('data-open-background-job');
 expect(sidebar).toContain('watch.stop()');
});
