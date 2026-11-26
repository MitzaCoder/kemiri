import { Worker } from "node:worker_threads";
import { serverSettings } from "./server-settings.ts";
import { packagedResources } from "./packaged-resources.ts";
import type { BoardMaintenance } from "./board-checkpoint.ts";
import type { BoardStorageRequest, BoardStorageResults } from "./board-storage-worker.ts";

/** One job at a time avoids competing reads of a legacy board and concurrent multi-gigabyte VACUUMs. */
export class BoardStorageJobs {
	readonly #maintenance = new Map<string, Promise<BoardMaintenance | undefined>>();
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;

	maintain(path: string, overview = false): Promise<BoardMaintenance | undefined> {
		const pending = this.#maintenance.get(path);
		if (pending) return pending;
		const job = (async () => {
			if (!(await Bun.file(path).exists())) return;
			return this.run({ type: "maintenance", path, overview });
		})();
		this.#maintenance.set(path, job);
		void job.then(result => {
			if (!result || result.vacuumDeferred) this.#maintenance.delete(path);
		}, () => this.#maintenance.delete(path));
		return job;
	}

	run<Request extends BoardStorageRequest>(request: Request): Promise<BoardStorageResults[Request["type"]]> {
		if (this.#closed) return Promise.reject(new Error("Board storage jobs are closed"));
		const job = this.#tail.then(() => this.#run(request));
		this.#tail = job.catch(() => undefined);
		return job;
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#tail;
	}

	async #run<Request extends BoardStorageRequest>(request: Request): Promise<BoardStorageResults[Request["type"]]> {
		const worker = new Worker(packagedResources.boardWorker ?? new URL("./board-storage-worker.ts", import.meta.url).pathname, {
			workerData: { request, stateNamespace: serverSettings.KEMIRI_STATE_NAMESPACE, sqliteTmpDir: serverSettings.SQLITE_TMPDIR },
		});
		try {
			return await new Promise((resolve, reject) => {
				worker.once("message", reply => "error" in reply ? reject(new Error(reply.error)) : resolve(reply.result));
				worker.once("error", reject);
				worker.once("exit", code => reject(new Error(`Board storage worker exited before replying (${code})`)));
			});
		} finally {
			await worker.terminate();
		}
	}
}
