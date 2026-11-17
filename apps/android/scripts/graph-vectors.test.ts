import { expect, test } from 'bun:test';

// These generators were previously manual checks. Root/deploy tests now reject drift in all three.
for (const script of ['graph-vectors.ts', 'graph-canvas-vectors.ts', 'graph-bubble-vectors.ts']) {
	test(`Android ${script} matches the web oracle`, async () => {
		const child = Bun.spawn([process.execPath, new URL(script, import.meta.url).pathname, '--check'], { stdout: 'pipe', stderr: 'pipe' });
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(stderr).toBe('');
		expect(exitCode).toBe(0);
	});
}
