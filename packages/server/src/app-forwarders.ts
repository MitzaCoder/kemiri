import { createConnection, createServer, type Socket } from "node:net";
import type { AppRecord } from "./app-registry-document.ts";
import { appForwarderPort } from "./app-port-reservations.ts";

/** Preserve the HTTP stream unchanged, including Upgrade and backpressure. Bind IPv4 loopback only. */
export async function listenAppForwarder(port: number, appPort: number) {
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, client => {
		const upstream = createConnection({ host: "127.0.0.1", port: appPort, allowHalfOpen: true });
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.on("error", () => { client.destroy(); upstream.destroy(); });
			socket.on("close", () => {
				sockets.delete(socket);
				if (!socket.readableEnded || !socket.writableFinished) (socket === client ? upstream : client).destroy();
			});
		}
		client.pipe(upstream).pipe(client);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	return { port: (server.address() as { port: number }).port, close() {
		server.close();
		for (const socket of sockets) socket.destroy();
	} };
}

type Forwarder = { projectId: string; appId: string; appPort: number; close(): void };
export class AppForwarders {
	readonly #byHttpsPort = new Map<number, Forwarder>();

	async assign(httpsPort: number, app: AppRecord): Promise<boolean> {
		const forwarder = this.#byHttpsPort.get(httpsPort);
		if (forwarder) return forwarder.projectId === app.projectId && forwarder.appId === app.appId && forwarder.appPort === app.port;
		try {
			const listener = await listenAppForwarder(appForwarderPort(httpsPort), app.port);
			this.#byHttpsPort.set(httpsPort, { projectId: app.projectId, appId: app.appId, appPort: app.port, close: listener.close });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
			throw error;
		}
	}

	keep(projectId: string, records: readonly AppRecord[]) {
		for (const [port, forwarder] of this.#byHttpsPort) {
			if (forwarder.projectId === projectId && !records.some(record => record.appId === forwarder.appId && record.reservedHttpsPort === port &&
				record.mode === "tailscale-reserved" && record.state === "live" && !record.stoppedAt && record.url)) {
				forwarder.close();
				this.#byHttpsPort.delete(port);
			}
		}
	}

	close() {
		for (const forwarder of this.#byHttpsPort.values()) forwarder.close();
		this.#byHttpsPort.clear();
	}
}
