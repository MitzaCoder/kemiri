import { spawn } from "node:child_process";
import type { AuthInteraction } from "@earendil-works/pi-ai";

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

/** The pinned agy's SSH login works with pipes. Do not give it a display, browser, or PTY. */
export async function loginAntigravity(command: string, args: readonly string[], cwd: string, env: Record<string, string>, interaction: AuthInteraction & { signal: AbortSignal }): Promise<void> {
	const { signal } = interaction;
	signal.throwIfAborted();
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
	const link = Promise.withResolvers<string>();
	const exited = Promise.withResolvers<boolean>();
	child.once("error", () => exited.resolve(false));
	child.once("exit", code => exited.resolve(code === 0));
	child.stdin.on("error", () => exited.resolve(false));
	const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
	const stop = () => {
		if (!child.pid) return;
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		stop();
		aborted.reject(new Error("Antigravity sign-in cancelled or timed out. Start it again."));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	const prompt = new AbortController();
	let output = "";
	let linkFound = false;
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		// Drain, but never retain or forward what agy prints after the sign-in link.
		if (linkFound) return;
		output += chunk;
		if (output.length > MAX_LOGIN_OUTPUT) { output = ""; stop(); return; }
		try {
			const url = authorizationUrl(output.slice(0, output.lastIndexOf("\n") + 1));
			if (url) { linkFound = true; output = ""; link.resolve(url); }
		} catch { stop(); }
	});
	const loginFailed = () => new Error("Antigravity could not sign in. Start again with a new Google authorization code.");
	const exitedEarly = exited.promise.then(() => { throw loginFailed(); });
	try {
		const url = await Promise.race([link.promise, aborted.promise, exitedEarly]);
		interaction.notify({ type: "auth_url", url, instructions: "Open Google's sign-in page and copy the authorization code it displays." });
		let code: string;
		while (true) {
			code = (await Promise.race([interaction.prompt({ type: "manual_code", message: "Paste the authorization code from Google's sign-in page, not the page URL.", placeholder: "Authorization code", signal: prompt.signal }), aborted.promise, exitedEarly])).trim();
			if (/^[A-Za-z0-9._~/-]{1,4096}$/.test(code)) break;
			interaction.notify({ type: "progress", message: "Paste only the authorization code, not a URL or multiple lines." });
		}
		signal.throwIfAborted();
		child.stdin.end(`${code}\n`);
		if (!await Promise.race([exited.promise, aborted.promise])) throw loginFailed();
	} finally {
		prompt.abort();
		signal.removeEventListener("abort", onAbort);
		stop();
		await closed;
	}
}
