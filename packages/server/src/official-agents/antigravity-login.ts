import { spawn } from "node:child_process";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { OfficialAgentAuthError } from "./auth-error.ts";

const GOOGLE_AUTH_PATHS = new Set(["/o/oauth2/auth", "/o/oauth2/v2/auth"]);
const MAX_LOGIN_OUTPUT = 64 * 1024;

function authorizationUrl(output: string): string | undefined {
	// agy prints an indented browser link, followed by a code prompt (without a final newline).
	for (const match of output.matchAll(/^\s+(https:\/\/accounts\.google\.com\/\S+)\r?$/gm)) {
		const url = new URL(match[1]!);
		if (url.origin === "https://accounts.google.com" && GOOGLE_AUTH_PATHS.has(url.pathname) && !url.username && !url.password && !url.hash &&
			url.searchParams.get("response_type") === "code" && url.searchParams.get("redirect_uri") === "https://antigravity.google/oauth-callback") return url.href;
	}
	return undefined;
}

// Return fixed descriptions of recognized agy/OAuth diagnostics, never text from the process.
// OAuth response bodies and even unrelated lines in the same stream can carry secrets.
function loginDiagnostic(output: string): string | undefined {
	if (/failed to exchange authorization code|oauth2: cannot fetch token/i.test(output)) {
		const exchange = "Antigravity failed to exchange the authorization code";
		if (/\binvalid_grant\b/.test(output)) return `${exchange}: Google rejected it (invalid_grant). Start again with a fresh code from the new link.`;
		if (/\baccess_denied\b/.test(output)) return `${exchange}: Google denied access (access_denied).`;
		if (/\binvalid_client\b/.test(output)) return `${exchange}: Google rejected the Antigravity OAuth client (invalid_client).`;
		return `${exchange} with Google.`;
	}
	if (/failed to read authorization code/i.test(output)) return "Antigravity failed to read the authorization code from standard input.";
	return undefined;
}

/** The pinned agy's SSH login works with pipes. Do not give it a display, browser, or PTY. */
export async function loginAntigravity(command: string, args: readonly string[], cwd: string, env: Record<string, string>, interaction: AuthInteraction & { signal: AbortSignal }): Promise<void> {
	const { signal } = interaction;
	signal.throwIfAborted();
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	const link = Promise.withResolvers<string>();
	const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
	let spawnFailed = false;
	let stdinFailed = false;
	child.once("error", () => { spawnFailed = true; });
	child.once("close", (code, signal) => closed.resolve({ code, signal }));
	child.stdin.on("error", () => { stdinFailed = true; });
	const stop = () => {
		if (!child.pid) return;
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		stop();
		aborted.reject(new OfficialAgentAuthError("Antigravity sign-in cancelled or timed out. Start it again."));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	const prompt = new AbortController();
	let stdout = "";
	let stderr = "";
	let linkFound = false;
	let linkError: string | undefined;
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-MAX_LOGIN_OUTPUT);
	});
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		if (linkFound || linkError) {
			stdout = (stdout + chunk).slice(-MAX_LOGIN_OUTPUT);
			return;
		}
		stdout += chunk;
		try {
			if (stdout.length > MAX_LOGIN_OUTPUT) throw new Error();
			const url = authorizationUrl(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
			if (url) { linkFound = true; link.resolve(url); }
		} catch {
			linkError = "Antigravity did not print a usable Google sign-in link.";
			stdout = "";
			stop();
		}
	});
	// Wait for close, not exit or EPIPE, so a final diagnostic has time to reach the pipes.
	const loginFailure = ({ code, signal }: Awaited<typeof closed.promise>) => {
		const exit = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
		const reason = spawnFailed ? "The backend could not start the Antigravity executable." :
			linkError ?? loginDiagnostic(stderr) ?? loginDiagnostic(stdout) ?? (stdinFailed ? "Antigravity closed its authorization code input unexpectedly." :
				`Antigravity ${linkFound ? "ended without completing Google sign-in" : "exited before printing a Google sign-in link"} (${exit}).`);
		return new OfficialAgentAuthError(reason);
	};
	const exitedBeforeAnswer = closed.promise.then(exit => { throw loginFailure(exit); });
	try {
		const url = await Promise.race([link.promise, aborted.promise, exitedBeforeAnswer]);
		interaction.notify({ type: "auth_url", url, instructions: "Open Google's sign-in page and copy the authorization code it displays." });
		let code: string;
		while (true) {
			code = (await Promise.race([interaction.prompt({ type: "manual_code", message: "Paste the authorization code from Google's sign-in page, not the page URL.", placeholder: "Authorization code", signal: prompt.signal }), aborted.promise, exitedBeforeAnswer])).trim();
			if (/^[A-Za-z0-9._~/-]{1,4096}$/.test(code)) break;
			interaction.notify({ type: "progress", message: "Paste only the authorization code, not a URL or multiple lines." });
		}
		signal.throwIfAborted();
		child.stdin.end(`${code}\n`);
		const exit = await Promise.race([closed.promise, aborted.promise]);
		if (exit.code !== 0 || stdinFailed) throw loginFailure(exit);
	} finally {
		prompt.abort();
		signal.removeEventListener("abort", onAbort);
		stop();
		await closed.promise;
	}
}
