import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createSetup } from "./support.ts";

let fixtureRoot: string | undefined;
afterEach(() => {
	if (fixtureRoot !== undefined) expect(existsSync(fixtureRoot)).toBe(false);
	fixtureRoot = undefined;
});

test("tears down a restarted server fixture without manual cleanup", async () => {
	const setup = await createSetup({ terminals: false });
	fixtureRoot = setup.root;
	await setup.restart();
	expect(existsSync(setup.root)).toBe(true);
});

test("can still clean up a server fixture explicitly", async () => {
	const setup = await createSetup({ terminals: false });
	fixtureRoot = setup.root;
	await Promise.all([setup.cleanup(), setup.cleanup()]);
	expect(existsSync(setup.root)).toBe(false);
});
