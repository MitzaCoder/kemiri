/** Run with Bun; DEMO_ORIGINS lists the web origins allowed to use this synthetic board. */
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { BoardTaskInput } from '@kemiri/protocol';
import { coordinatorWriter, writeReportIn, type ReportWrite } from '../src/board.ts';
import { createSetup, TestClient } from '../test/support.ts';

const capacityRehearsal = `The booking desk can handle the expected morning queue at Linden Hall. We ran a rehearsal during the morning session with the reservation desk using the same arrival order that the hall expects on an ordinary opening day. The entrance team gave each volunteer a printed slip with a made up name and arrival time so that the desk could practice without using anyone's real booking details. We left the normal counter layout in place and had the same number of people on the desk as the opening schedule calls for. In the first window the desk accepted ten reservations. All ten were entered before the window ended and the clerk could find each reservation again by its slip number when the entrance team asked for it. The desk did not need to open a second queue while those ten people were being served. When the next volunteer arrived, the clerk sent the request to the waiting list instead of putting an eleventh reservation into the first window. The volunteer kept the same slip number and the clerk could call that number in order when a place opened later in the session. That handoff is the second thing we wanted to see because the door team needs to be able to tell people where to wait without sending them through the line again. Proof: the booking replay in Files follows the tenth reservation and the first waiting list entry in order. It also records what the clerk said to the volunteer so the entrance team can try the same wording next time. We did not treat the rehearsal as a forecast for a special event because a larger group arriving together could change the time people spend at the desk. The morning result is enough to keep the one queue layout for the usual opening. We erased the practice reservations from the desk book after matching them against the replay. Then we removed the practice waiting list and set out a fresh stack of blank slips. The next shift can start with an empty book instead of having to tell rehearsal names apart from new bookings. We left the usual reference card at the counter and asked the entrance team to keep using the same line for anyone who comes to make a reservation. The replay stays available for anyone who wants to see what happened at the cutoff before the hall opens again on an ordinary morning.`;

const setup = await createSetup({
	allowedOrigins: (process.env.DEMO_ORIGINS ?? 'http://localhost:5210').split(','),
	terminals: false,
});
setup.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('Synthetic demo ready.')));
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add the synthetic project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Linden Hall', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
const { runtime } = await setup.server.manager.open(projectId);

async function seedTask(title: string, description: string, status: BoardTaskInput['status'], sections?: ReportWrite['sections']) {
	const task = await runtime.board.saveTask({ task: {
		title, description, status, acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [],
	} }, status === 'done' ? 'user' : 'coordinator');
	if (sections) await runtime.harness.commit(tx => writeReportIn(tx, runtime.conversation.id, {
		taskId: task.id, sections, by: coordinatorWriter('main'),
	}, `report-demo:${task.id}`, new Date().toISOString()), BACKGROUND_CONTEXT);
	return task.id;
}

const capacity = await seedTask('Rehearse the morning reservation queue', 'Find out whether the booking desk can handle a normal morning at Linden Hall.', 'done', {
	results: capacityRehearsal,
});
const replayPath = join(setup.projectDir, 'booking-replay.md');
await Bun.write(replayPath, '# Booking replay\n\n1. The desk accepts slip 10 in the first window.\n2. The clerk says “We’ll call your slip number when a place opens” and puts slip 11 on the waiting list.\n');
await setup.server.artifacts.save({ projectId, sourcePath: replayPath, title: 'Booking replay', note: 'The replay shows the switch to the waiting list.', threadId: 'main', workerId: null, taskId: capacity });

const rows = await seedTask('Lay out the welcome table', 'Make it easy for visitors to find the right room without asking at the desk.', 'review', {
	results: [
		'- Visitors can pick up the **room guide** without joining the reservation queue.',
		'- The signs use the same room names as the [hall directory](https://example.test/hall).',
		'- The booking desk kept the same queue from ' + capacity + ' so the entrance stays clear.',
		'',
		'Table location: Just inside the east doors',
		'First session: `09:30` on market day',
		'Large print guide: The top tray beside the daily room list',
	].join('\n'),
	next: 'Walk in through the east doors and check that the guide is easy to spot.',
});

const manual = await seedTask('Prepare the pickup desk', 'Make it clear where visitors collect reserved kits.', 'in_progress', {
	steps: '1. Put the blue pickup sign on the counter by the east doors.\n2. Set the desk code to `314` on the sign-out clipboard.',
	results: '- The counter has a tray for reserved kits.\n- The tray has room for the morning pickup slips.',
	notDone: [
		'The evening pickup plan still needs a venue check.',
		'',
		'| Entrance | What is missing |',
		'| --- | --- |',
		'| East doors | An inside sign for after dusk |',
		'| Side gate | A covered place to wait in the rain |',
		'',
		'The day shift can still use the east doors.',
	].join('\n'),
	next: 'The desk team will confirm which entrance stays open after dusk.',
});
await runtime.board.markReportStale(manual, ['next'], 'The venue changed the evening door schedule.');
const empty = await seedTask('Plan the next hall open day', 'Keep a place for the next open day plan.', 'todo');

const backends = [{ id: 'report-demo', name: 'Report demo', url: setup.server.url }];
const routes = Object.fromEntries(Object.entries({ capacity, rows, manual, empty }).map(([example, taskId]) =>
	[example, `/b/report-demo/projects/${encodeURIComponent(projectId)}?task=${encodeURIComponent(taskId)}`]));
if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, JSON.stringify({ backends, routes, pid: process.pid }));
console.log(`Synthetic report backend: ${setup.server.url}`);
console.log(`Open an allowed web origin, then run localStorage.setItem('aiki.backends.v1', ${JSON.stringify(JSON.stringify(backends))}) and reload.`);
console.log('Task routes:', routes);
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
