import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsageReading, WindowReading } from "../subscription-usage.ts";
import { officialAgentEnvironment } from "./auth.ts";
import { OfficialAgentAuthError } from "./auth-error.ts";

const MAX_REPORT_BYTES = 1024 * 1024;
const QUOTA_TIMEOUT_MS = 20_000;
const QUOTA_COMMAND_MINIMUM = [1, 1, 11]; // Google introduced no-turn print reports in 1.1.11.

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const quotaReportError = () => new OfficialAgentAuthError("Antigravity did not return a readable quota report.");

export function parseAntigravityQuota(report: unknown, now: number): UsageReading {
	const envelope = record(report);
	const command = record(envelope?.command);
	const groups = record(command?.data)?.groups;
	if (envelope?.status !== "SUCCESS" || envelope.num_turns !== 0 || command?.name !== "usage" || !Array.isArray(groups)) throw quotaReportError();
	const windows = new Map<string, WindowReading>();
	let hasPlaceholder = false;
	for (const entry of groups) {
		const group = record(entry);
		if (typeof group?.name !== "string" || !group.name.trim() || group.name.length > 120 || /[\x00-\x1f\x7f]/.test(group.name) || !Array.isArray(group.buckets)) continue;
		for (const entry of group.buckets) {
			const bucket = record(entry);
			if (!bucket || bucket.disabled === true || typeof bucket.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(bucket.id)) continue;
			const windowMinutes = bucket.window === "5h" ? 300 : bucket.window === "weekly" ? 10_080 : null;
			const remaining = bucket.remaining_fraction;
			if (windowMinutes === null || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
			const reset = typeof bucket.reset_time === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(bucket.reset_time) ? Date.parse(bucket.reset_time) : NaN;
			// agy can return SUCCESS before quota loads. Full remaining quota plus a
			// sliding full-window reset is not evidence of a balance or a schedule.
			if (remaining === 1 && !bucket.description && Math.abs(reset - now - windowMinutes * 60_000) <= 60_000) {
				hasPlaceholder = true;
				continue;
			}
			if (windows.has(bucket.id)) throw quotaReportError();
			const scope = group.name.trim();
			windows.set(bucket.id, {
				id: bucket.id, scope, label: `${scope} · ${windowMinutes === 300 ? "5-hour" : "Weekly"}`,
				usedPercent: Math.round((1 - remaining) * 1e8) / 1e6,
				resetsAt: Number.isFinite(reset) && reset > now ? new Date(reset).toISOString() : null,
				windowMinutes,
			});
		}
	}
	if (windows.size === 0) {
		if (hasPlaceholder) throw new OfficialAgentAuthError("Antigravity returned default limits instead of measured quota. Try refreshing or check /usage in the Antigravity CLI.");
		throw quotaReportError();
	}
	return { source: "usage_api", windows: [...windows.values()] };
}

function runAgy(command: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stop = () => {
			if (!child.pid) return;
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		};
		let bytes = 0;
		let stderr = "";
		let overflow = false;
		const chunks: Buffer[] = [];
		signal.addEventListener("abort", stop, { once: true });
		child.on("error", () => stop());
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > MAX_REPORT_BYTES) { overflow = true; stop(); }
			else chunks.push(chunk);
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
		child.once("close", code => {
			signal.removeEventListener("abort", stop);
			stop();
			if (signal.aborted) return reject(new OfficialAgentAuthError("Antigravity quota read timed out or was cancelled."));
			if (code !== 0 || overflow) {
				if (/authentication required|invalid_grant|not authenticated|failed to refresh|please (?:log|sign) in/i.test(stderr)) {
					return reject(new OfficialAgentAuthError("Antigravity could not use its saved Google sign-in. Check the login in Accounts and API keys."));
				}
				return reject(quotaReportError());
			}
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

/** The pinned CLI reads the same native file format under a different app-directory name. */
export async function readAntigravityQuota(command: string, pinnedVersion: string, profile: string, signal: AbortSignal): Promise<UsageReading> {
	const app = join(profile, "antigravity-acp");
	if (!(await lstat(app).catch(() => undefined))?.isDirectory() ||
		!(await lstat(join(app, "antigravity-oauth-token")).catch(() => undefined))?.isFile()) {
		throw new OfficialAgentAuthError("Antigravity has no saved Google sign-in in its managed profile.");
	}
	const scratch = await mkdtemp(join(tmpdir(), "agy-quota-"));
	try {
		const home = join(scratch, "home");
		const gemini = join(home, ".gemini");
		await mkdir(gemini, { recursive: true, mode: 0o700 });
		const env = officialAgentEnvironment(home, scratch);
		const browser = join(scratch, "xdg-open");
		// Prevent a failed passive read from launching an OAuth browser or auto-updating the pin.
		await writeFile(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		await symlink(browser, join(scratch, "open"));
		Object.assign(env, { PATH: `${scratch}:${env.PATH}`, BROWSER: browser, SSH_TTY: "/dev/null", AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(QUOTA_TIMEOUT_MS)]);
		const version = (await runAgy(command, ["--version"], scratch, env, deadline)).trim();
		const parts = version.split(".").map(Number);
		const mismatch = parts.findIndex((part, index) => part !== QUOTA_COMMAND_MINIMUM[index]);
		if (version !== pinnedVersion || !/^\d+\.\d+\.\d+$/.test(version) || (mismatch !== -1 && parts[mismatch]! < QUOTA_COMMAND_MINIMUM[mismatch]!)) {
			throw new OfficialAgentAuthError("Antigravity quota reports require the backend’s pinned agy version.");
		}
		// Directory alias, not a token copy or file link: native atomic token refresh stays in the managed profile.
		await symlink(app, join(gemini, "antigravity-cli"), "dir");
		const report = await runAgy(command, ["--log-file", join(scratch, "agy.log"), "--sandbox", "--print", "/usage", "--output-format", "json"], scratch, env, deadline);
		let parsed: unknown;
		try { parsed = JSON.parse(report); } catch { throw quotaReportError(); }
		return parseAntigravityQuota(parsed, Date.now());
	} catch (error) {
		// Neither process output, URLs, JSON errors nor filesystem details belong in the usage panel.
		throw error instanceof OfficialAgentAuthError ? error : quotaReportError();
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
	}
}
