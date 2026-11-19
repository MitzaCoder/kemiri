import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAntigravityQuota, readAntigravityQuota } from "../src/official-agents/antigravity-quota.ts";
import { createSetup, TestClient } from "./support.ts";

const hour = 3_600_000;
const fakeReport = (reset: string) => ({ status: "SUCCESS", num_turns: 0, command: {
	name: "usage", data: { groups: [
		{ name: "Gemini Models", buckets: [
			{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.625, reset_time: reset },
			{ id: "gemini-5h", window: "5h", remaining_fraction: 0.5, reset_time: reset },
			{ id: "disabled-5h", window: "5h", remaining_fraction: 0, reset_time: reset, disabled: true },
		] },
		{ name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0, reset_time: reset }] },
	] },
} });

const fakeAgy = (reset: string) => `#!/bin/sh
if [ "$1" = --version ]; then
  test ! -e "$HOME/.gemini/antigravity-cli" || exit 4
  printf '1.5.12\\n'; exit 0
fi
[ "$3 $4 $5 $6 $7" = '--sandbox --print /usage --output-format json' ] || exit 4
[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = true ] && [ "$SSH_TTY" = /dev/null ] || exit 4
[ "$PWD" = "$TMPDIR" ] && [ ! -e "$HOME/.profile" ] || exit 4
if IFS= read -r unexpected; then exit 4; fi
app="$HOME/.gemini/antigravity-cli"
[ -f "$app/antigravity-oauth-token" ] || exit 4
# Simulate the binary's atomic credential write through the disposable app-directory alias.
printf '%s' 'synthetic-refresh' > "$app/next" && mv "$app/next" "$app/antigravity-oauth-token" || exit 4
printf '%s\\n' '${JSON.stringify(fakeReport(reset))}'
`;

async function fixture(root: string, script: string) {
	const command = join(root, "fake-agy");
	await writeFile(command, script);
	await chmod(command, 0o700);
	return command;
}

async function profile(root: string) {
	const app = join(root, "antigravity-acp");
	await mkdir(app, { recursive: true });
	const nativeCredential = join(app, "antigravity-oauth-token");
	await writeFile(nativeCredential, "synthetic-native-token", { mode: 0o600 });
	return nativeCredential;
}

test("quota parser only accepts no-turn reports and measured, enabled buckets", () => {
	const now = Date.UTC(2030, 0, 1);
	const reset = new Date(now + hour).toISOString();
	const report = fakeReport(reset);
	report.command.data.groups[0]!.buckets.push({ id: "not-a-window", window: "mystery", remaining_fraction: 0.9, reset_time: reset });
	report.command.data.groups[0]!.buckets.push({ id: "not-measured", window: "5h", remaining_fraction: NaN, reset_time: reset });
	report.command.data.groups[1]!.buckets.push({ id: "unused-5h", window: "5h", remaining_fraction: 1, reset_time: new Date(now + 5 * hour).toISOString() });
	expect(parseAntigravityQuota(report, now).windows).toEqual([
		{ id: "gemini-weekly", label: "Gemini Models · Weekly", scope: "Gemini Models", windowMinutes: 10080, usedPercent: 37.5, resetsAt: reset },
		{ id: "gemini-5h", label: "Gemini Models · 5-hour", scope: "Gemini Models", windowMinutes: 300, usedPercent: 50, resetsAt: reset },
		{ id: "3p-weekly", label: "Claude and GPT models · Weekly", scope: "Claude and GPT models", windowMinutes: 10080, usedPercent: 100, resetsAt: reset },
		{ id: "unused-5h", label: "Claude and GPT models · 5-hour", scope: "Claude and GPT models", windowMinutes: 300, usedPercent: 0, resetsAt: null },
	]);
	for (const unexpected of [{ ...report, num_turns: 1 }, { ...report, command: { name: "model" } }, { ...report, command: { name: "usage", data: { groups: [] } } }]) {
		expect(() => parseAntigravityQuota(unexpected, now)).toThrow("readable quota report");
	}
});

test("wrong version cannot run the usage command and failures do not return stdout or stderr", async () => {
	const root = await mkdtemp(join(tmpdir(), "fake-agy-"));
	try {
		await profile(root);
		const command = await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '1.1.0\\n'; exit; }; touch '${join(root, "ran-usage")}'\n`);
		const { signal } = new AbortController();
		await expect(readAntigravityQuota(command, "1.5.12", root, signal)).rejects.toThrow("pinned agy version");
		expect(await Bun.file(join(root, "ran-usage")).exists()).toBe(false);
		await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '1.5.12\\n'; exit; }; printf 'synthetic-token'; printf 'invalid_grant: synthetic-token' >&2; exit 1\n`);
		await expect(readAntigravityQuota(command, "1.5.12", root, signal)).rejects.toThrow(/^Antigravity could not use its saved Google sign-in\. Check the login in Accounts and API keys\.$/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("usage reads the managed subscription through agy and records scoped windows in the value ledger", async () => {
	const root = await mkdtemp(join(tmpdir(), "fake-agy-"));
	try {
		const reset = new Date(Date.now() + hour).toISOString();
		const command = await fixture(root, fakeAgy(reset));
		const setup = await createSetup({ antigravityCommand: command, subscriptionUsage: { fetch: (() => { throw new Error("Native quota must not fetch"); }) as unknown as typeof fetch } });
		let client: TestClient | undefined;
		try {
			const nativeProfile = "a5fa596b-1b47-4188-b098-3191fe2f787f";
			const credentialPath = await profile(join(setup.dataDir, "official-agents", "antigravity", `subscription-${nativeProfile}`));
			await setup.credentials.modify("antigravity", async () => ({ type: "oauth", access: "", refresh: "", expires: Number.MAX_SAFE_INTEGER, nativeProfile }));
			client = await TestClient.open(setup.server);
			await client.hello();
			const limits = await client.request({ type: "subscriptions.usage", refresh: true });
			expect(limits).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ providerId: "antigravity", error: null, windows: [
				{ id: "gemini-weekly", usedPercent: 37.5, resetsAt: reset }, { id: "gemini-5h" }, { id: "3p-weekly" },
			] }] });
			expect(await readFile(credentialPath, "utf8")).toBe("synthetic-refresh");
			const report = await client.request({ type: "usage.value", utcOffsetMinutes: 0 });
			expect(report).toMatchObject({ type: "usage.value", subscriptions: [{ providerId: "antigravity", windows: [
				{ windowId: "3p-weekly", scope: "Claude and GPT models", binding: false },
				{ windowId: "gemini-weekly", scope: "Gemini Models", binding: false },
				{ windowId: "gemini-5h", scope: "Gemini Models", binding: false },
			] }] });
			await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '1.5.12\\n'; exit; }; printf 'invalid_grant: synthetic-token' >&2; exit 1\n`);
			const failed = await client.request({ type: "subscriptions.usage", refresh: true });
			expect(failed).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ error: expect.stringContaining("saved Google sign-in"), windows: [{ usedPercent: 37.5 }, {}, {}] }] });
			expect(JSON.stringify(failed)).not.toContain("synthetic-token");
			await setup.credentials.modify("antigravity", async () => ({ type: "api_key", key: "synthetic-api-key" }));
			expect(await client.request({ type: "subscriptions.usage", refresh: true })).toMatchObject({ type: "subscriptions.usage", subscriptions: [] });
		} finally { client?.close(); await setup.cleanup(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});
