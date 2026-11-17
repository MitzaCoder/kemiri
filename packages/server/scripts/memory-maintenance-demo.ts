/** Synthetic Memory history proof backend. Never opens installed data. Run with Bun from the repository root. */
import { join } from 'node:path';
import { createSetup, TestClient } from '../test/support.ts';

const origin = process.env.MEMORY_WEB_ORIGIN ?? 'http://localhost:5297';
const output = process.env.MEMORY_DEMO_OUTPUT ?? '/tmp/memory-maintenance-demo.json';
const test = await createSetup({ allowedOrigins: [origin], terminals: false });
let client = await TestClient.open(test.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: test.projectDir });
if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Memory history demo' });
const now = Date.now();
const run = (days: number, outcome: 'failed' | 'ok' | 'nothing_to_do', trigger: 'nightly' | 'manual' | 'writes' = 'nightly') => ({
	at: new Date(now - days * 86400000).toISOString(), trigger, outcome,
	commit: outcome === 'ok' ? '1234567890abcdef1234567890abcdef12345678' : null,
	message: outcome === 'failed' ? 'The model service was unavailable. The request timed out while waiting for a response; no memories were changed. Try again when the service is available.' : null,
});
const record = (recentRuns: ReturnType<typeof run>[]) => ({ lastRunHead: null, lastAttemptHead: null, nightlyAt: null, lastRun: recentRuns[0], recentRuns });
client.close();
await test.server.stop();
await Bun.write(join(test.dataDir, 'memory-maintenance.json'), JSON.stringify({
	version: 1,
	maintenance: { model: null, thinkingLevel: null, time: '03:00', afterWrites: 20 },
	scopes: {
		[`project:${projectId}`]: record([run(0.02, 'failed', 'manual'), run(1, 'failed'), run(2, 'failed'), run(3, 'ok', 'writes'), run(4, 'nothing_to_do')]),
		global: record([run(0.05, 'ok', 'manual'), run(1, 'nothing_to_do'), run(2, 'ok', 'writes')]),
	},
}));
await test.restart();
client = await TestClient.open(test.server); await client.hello();
await Bun.write(output, JSON.stringify({ url: test.server.url, projectId, pid: process.pid, dataDir: test.dataDir, origin }));
console.log('Memory history demo ready: ' + output);
process.on('SIGTERM', async () => { client.close(); await test.cleanup(); process.exit(0); });
await new Promise(() => {});
