/**
 * Synthetic fixture for the official-agent settings screens. Run it with Bun and an isolated HOME: it never reads an
 * installed account and signs in to nothing real.
 *
 * It starts a `createSetup` server whose Antigravity provider runs the fake ACP agent fixture, adds one project
 * whose worker model is Antigravity, and serves the built web app (`OFFICIAL_AGENT_WEB_DIR`, the `apps/web/build`
 * folder) so the page and the backend share an origin. A small control server (`OFFICIAL_AGENT_CONTROL_PORT`) moves
 * Antigravity between its login states while the page is open:
 *   GET /state/none          not signed in
 *   GET /state/subscription  the non-secret marker a finished sign-in stores
 *   GET /state/api-key       a fake Gemini API key
 * The fixture's details are written to `OFFICIAL_AGENT_DEMO_OUTPUT` as JSON.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSetup, TestClient } from '../test/support.ts';

const AGENT = 'antigravity';
const fakeAgent = new URL('../test/fixtures/fake-acp.ts', import.meta.url).pathname;
const output = process.env.OFFICIAL_AGENT_DEMO_OUTPUT ?? '/tmp/official-agent-web-demo.json';
const webDir = process.env.OFFICIAL_AGENT_WEB_DIR;
const controlPort = Number(process.env.OFFICIAL_AGENT_CONTROL_PORT ?? 0);
const webOrigin = process.env.OFFICIAL_AGENT_WEB_ORIGIN;

const setup = await createSetup({
	antigravityCommand: fakeAgent,
	terminals: false,
	...(webDir === undefined ? {} : { webDir }),
	...(webOrigin === undefined ? {} : { allowedOrigins: [webOrigin] })
});

async function setLogin(state: string): Promise<void> {
	const { credentials } = setup;
	if (state === 'none') await credentials.delete(AGENT);
	else if (state === 'subscription') {
		// What a finished sign-in stores: pi-ai's required fields plus the id of agy's private profile. No token.
		await credentials.modify(AGENT, async () => ({ type: 'oauth', access: '', refresh: '', expires: Number.MAX_SAFE_INTEGER, nativeProfile: randomUUID() }));
	} else if (state === 'api-key') await credentials.modify(AGENT, async () => ({ type: 'api_key', key: 'synthetic-fixture-key' }));
	else throw new Error(`Unknown state: ${state}`);
}
await setLogin('none');

await mkdir(join(setup.projectDir, 'src'), { recursive: true });
await writeFile(join(setup.projectDir, 'src', 'kite.txt'), 'A synthetic paper kite.\n');
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
const projectId = added.project.id;
const configured = await client.request({
	type: 'projects.configure',
	projectId,
	name: 'Paper kites',
	coordinatorModel: { provider: 'faux', modelId: 'faux-1' },
	workerModels: [{ provider: AGENT, modelId: 'gemini-3.8-flash' }]
});
if (configured.type !== 'projects.configure') throw new Error(JSON.stringify(configured));

const control = Bun.serve({
	hostname: '127.0.0.1',
	port: controlPort,
	async fetch(request) {
		const match = /^\/state\/([a-z-]+)$/.exec(new URL(request.url).pathname);
		if (match?.[1] === undefined) return new Response('Not found', { status: 404 });
		try {
			await setLogin(match[1]);
			return new Response(`ok ${match[1]}\n`);
		} catch (error) {
			return new Response(String(error), { status: 400 });
		}
	}
});

await Bun.write(output, JSON.stringify({ url: setup.server.url, controlUrl: `http://127.0.0.1:${control.port}`, projectId, pid: process.pid, root: setup.root }));
console.log(`Synthetic official-agent fixture ready: ${output}`);
let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	control.stop(true);
	client.close();
	await setup.cleanup();
	process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
await new Promise(() => {});
