import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityPin } from "../src/antigravity-pin.ts";
import { parseAntigravityQuota, readAntigravityQuota } from "../src/official-agents/antigravity-quota.ts";
import { SUBSCRIPTION_USAGE_FILE } from "../src/subscription-usage.ts";
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

const placeholderReport = (now: number) => ({ status: "SUCCESS", num_turns: 0, command: {
	name: "usage", data: { description: "Model quotas", groups: ["Gemini Models", "Claude and GPT models"].map((name, index) => ({
		name, description: "Shared model quota", buckets: ["weekly", "5h"].map(window => ({
			id: `${index === 0 ? "gemini" : "3p"}-${window}`, name: window, window,
			remaining_fraction: 1, reset_time: new Date(now + (window === "weekly" ? 168 : 5) * hour).toISOString(),
		})),
	})) },
} });

const fakeAgy = (reset: string) => `#!/bin/sh
if [ "$1" = --version ]; then
  test ! -e "$HOME/.gemini/antigravity-cli" || exit 4
  printf '${antigravityPin.version}\\n'; exit 0
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
	]);
	for (const unexpected of [{ ...report, num_turns: 1 }, { ...report, command: { name: "model" } }, { ...report, command: { name: "usage", data: { groups: [] } } }]) {
		expect(() => parseAntigravityQuota(unexpected, now)).toThrow("readable quota report");
	}
});

test("current CLI placeholders are not quota, but a measured zero and its actual reset are valid", () => {
	const now = Date.UTC(2030, 0, 1);
	const report = placeholderReport(now);
	expect(() => parseAntigravityQuota(report, now + 2_000)).toThrow("default limits instead of measured quota");
	const reset = new Date(now + 2 * hour).toISOString();
	report.command.data.groups[1]!.buckets[1]!.reset_time = reset;
	expect(parseAntigravityQuota(report, now + 2_000).windows).toEqual([
		{ id: "3p-5h", label: "Claude and GPT models · 5-hour", scope: "Claude and GPT models", windowMinutes: 300, usedPercent: 0, resetsAt: reset },
	]);
});

test("a partial Antigravity report keeps both measured windows and omits the placeholder pool", () => {
	const now = Date.UTC(2030, 0, 1);
	const report = placeholderReport(now);
	const weeklyReset = new Date(now + 120 * hour).toISOString();
	const fiveHourReset = new Date(now + 3 * hour).toISOString();
	const measuredPool = report.command.data.groups[0]!;
	measuredPool.buckets = measuredPool.buckets.map(bucket => ({
		...bucket,
		remaining_fraction: bucket.window === "weekly" ? 0.75 : 0.25,
		reset_time: bucket.window === "weekly" ? weeklyReset : fiveHourReset,
		description: "Measured model quota",
	}));
	expect(parseAntigravityQuota(report, now).windows).toEqual([
		{ id: "gemini-weekly", label: "Gemini Models · Weekly", scope: "Gemini Models", windowMinutes: 10080, usedPercent: 25, resetsAt: weeklyReset },
		{ id: "gemini-5h", label: "Gemini Models · 5-hour", scope: "Gemini Models", windowMinutes: 300, usedPercent: 75, resetsAt: fiveHourReset },
	]);
});

test("wrong version cannot run the usage command and failures do not return stdout or stderr", async () => {
	const root = await mkdtemp(join(tmpdir(), "fake-agy-"));
	try {
		await profile(root);
		const command = await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '1.1.0\\n'; exit; }; touch '${join(root, "ran-usage")}'\n`);
		const { signal } = new AbortController();
		await expect(readAntigravityQuota(command, antigravityPin.version, root, signal)).rejects.toThrow("pinned agy version");
		expect(await Bun.file(join(root, "ran-usage")).exists()).toBe(false);
		await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '${antigravityPin.version}\\n'; exit; }; printf 'synthetic-token'; printf 'invalid_grant: synthetic-token' >&2; exit 1\n`);
		await expect(readAntigravityQuota(command, antigravityPin.version, root, signal)).rejects.toThrow(/^Antigravity could not use its saved Google sign-in\. Check the login in Accounts and API keys\.$/);
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
			const samples = [{ at: new Date().toISOString(), usedPercent: 0 }];
			await Bun.write(join(setup.dataDir, SUBSCRIPTION_USAGE_FILE), JSON.stringify({ subscriptions: [{
				providerId: "antigravity", label: "Antigravity", source: "usage_api", plan: null, account: null, error: null, updatedAt: samples[0]!.at,
				windows: [{ id: "gemini-weekly", label: "Gemini Models · Weekly", windowMinutes: 10_080, usedPercent: 0, resetsAt: null, samples }],
			}] }));
			client = await TestClient.open(setup.server);
			await client.hello();
			const cached = await client.request({ type: "subscriptions.usage" });
			expect(cached).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ windows: [], error: expect.stringContaining("could not be verified") }] });
			const defaultCommand = `#!/bin/sh\n[ "$1" = --version ] && { printf '${antigravityPin.version}\\n'; exit; }; printf '%s\\n' '${JSON.stringify(placeholderReport(Date.now()))}'\n`;
			await fixture(root, defaultCommand);
			const unmeasured = await client.request({ type: "subscriptions.usage", refresh: true });
			expect(unmeasured).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ windows: [], error: expect.stringContaining("default limits") }] });
			await fixture(root, fakeAgy(reset));
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
			await fixture(root, defaultCommand);
			const unmeasuredAgain = await client.request({ type: "subscriptions.usage", refresh: true });
			expect(unmeasuredAgain).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ error: expect.stringContaining("default limits"), windows: [
				{ usedPercent: 37.5, resetsAt: reset, samples: [{ usedPercent: 37.5 }] }, {}, {},
			] }] });
			await fixture(root, `#!/bin/sh\n[ "$1" = --version ] && { printf '${antigravityPin.version}\\n'; exit; }; printf 'invalid_grant: synthetic-token' >&2; exit 1\n`);
			const failed = await client.request({ type: "subscriptions.usage", refresh: true });
			expect(failed).toMatchObject({ type: "subscriptions.usage", subscriptions: [{ error: expect.stringContaining("saved Google sign-in"), windows: [{ usedPercent: 37.5 }, {}, {}] }] });
			expect(JSON.stringify(failed)).not.toContain("synthetic-token");
			await setup.credentials.modify("antigravity", async () => ({ type: "api_key", key: "synthetic-api-key" }));
			expect(await client.request({ type: "subscriptions.usage", refresh: true })).toMatchObject({ type: "subscriptions.usage", subscriptions: [] });
		} finally { client?.close(); await setup.cleanup(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});
