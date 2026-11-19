import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialStore, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { childEnvironment } from "../child-environment.ts";
import { AcpClient } from "./acp-client.ts";
import type { OfficialAgentDefinition, OfficialAgentLogin } from "./definition.ts";

export const officialAgentAccounts = new WeakMap<Provider, OfficialAgentAccounts>();

function subscriptionId(credential: Credential | undefined): string | undefined {
	const id = credential?.type === "oauth" ? credential.nativeProfile : undefined;
	return typeof id === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id) ? id : undefined;
}

export function officialAgentEnvironment(profile: string, scratch: string): Record<string, string> {
	return { PATH: childEnvironment().PATH ?? "/usr/bin:/bin", HOME: profile, LANG: "C.UTF-8", TMPDIR: scratch };
}

export class OfficialAgentAccounts {
	#queue: Promise<unknown> = Promise.resolve();
	#changes = 0;

	constructor(readonly options: {
		directory: string;
		definition: OfficialAgentDefinition;
		credentials: CredentialStore;
		stopWorkers: () => Promise<void>;
		log: (message: string) => void;
	}) {}

	get changing(): boolean { return this.#changes > 0; }

	async workerLogin(signal: AbortSignal): Promise<{ login: OfficialAgentLogin; profile: string; identity: string } | undefined> {
		const credential = await this.options.credentials.read(this.options.definition.id, { signal });
		if (credential?.type === "api_key" && credential.key) {
			return { login: { mode: "api-key", key: credential.key }, profile: join(this.options.directory, "profile"), identity: "api-key" };
		}
		const id = subscriptionId(credential);
		return id ? { login: { mode: "subscription" }, profile: this.#profile(id), identity: id } : undefined;
	}

	/** Unlike network providers, activation must include process teardown and a native profile swap. */
	login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
		const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(5 * 60_000)]);
		return this.#change(async () => {
			const { credentials, definition, stopWorkers } = this.options;
			const id = randomUUID();
			const profile = this.#profile(id);
			const login = { mode: "subscription" } as const;
			let saved = false;
			try {
				signal.throwIfAborted();
				const binary = await definition.install();
				signal.throwIfAborted();
				await mkdir(profile, { recursive: true, mode: 0o700 });
				await chmod(profile, 0o700);
				await definition.prepareProfile(profile, login);
				const scratch = await mkdtemp(join(profile, "tmp-"));
				try {
					await definition.loginSubscription(binary, profile, scratch, { ...interaction, signal });
				} finally { await rm(scratch, { recursive: true, force: true }); }
				signal.throwIfAborted();
				await stopWorkers();
				const previous = subscriptionId(await credentials.read(definition.id, { signal }));
				// These are pi-ai's required fields, not Google's tokens or token expiry.
				const marker: OAuthCredential = { type: "oauth", access: "", refresh: "", expires: Number.MAX_SAFE_INTEGER, nativeProfile: id };
				await credentials.modify(definition.id, async () => { signal.throwIfAborted(); return marker; }, { signal });
				saved = true;
				if (previous) await this.#removeSubscription(previous).catch(() => this.options.log("Could not remove the previous Antigravity sign-in profile."));
				return marker;
			} catch {
				if (signal.aborted) throw new Error("Antigravity sign-in cancelled or timed out. Start it again.");
				throw new Error("Antigravity could not sign in. Start again with a new Google authorization code.");
			} finally {
				if (!saved) await rm(profile, { recursive: true, force: true }).catch(() => this.options.log("Could not remove an incomplete Antigravity sign-in profile."));
			}
		});
	}

	setApiKey(key: string): Promise<void> {
		return this.#change(async () => {
			const { definition, credentials, stopWorkers } = this.options;
			await stopWorkers();
			const previous = subscriptionId(await credentials.read(definition.id));
			if (previous) await this.#removeSubscription(previous);
			await credentials.modify(definition.id, async () => ({ type: "api_key", key }));
		});
	}

	logout(): Promise<boolean> {
		return this.#change(async () => {
			const { definition, credentials, stopWorkers } = this.options;
			await stopWorkers();
			const previous = await credentials.read(definition.id);
			const id = subscriptionId(previous);
			if (id) await this.#removeSubscription(id);
			await credentials.delete(definition.id);
			return previous !== undefined;
		});
	}

	async drain(): Promise<void> { await this.#queue; }

	#profile(id: string): string { return join(this.options.directory, `subscription-${id}`); }

	#change<T>(change: () => Promise<T>): Promise<T> {
		this.#changes++;
		const run = this.#queue.then(change).finally(() => { this.#changes--; });
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #removeSubscription(id: string): Promise<void> {
		const { definition, log } = this.options;
		const profile = this.#profile(id);
		const login = { mode: "subscription" } as const;
		try {
			const scratch = await mkdtemp(join(profile, "tmp-"));
			try {
				const binary = await definition.install();
				const client = new AcpClient(binary, definition.launchArgs(profile), scratch,
					{ ...officialAgentEnvironment(profile, scratch), ...definition.environment(profile, login) }, () => {});
				try { await client.logout(definition.subscriptionMethod); }
				finally { await client.close(); }
			} finally { await rm(scratch, { recursive: true, force: true }); }
		} catch {
			log("Antigravity could not complete native logout. Removing its local sign-in profile.");
		}
		// Remove the entire isolated profile, without reading any of agy's account files.
		await rm(profile, { recursive: true, force: true });
	}
}
