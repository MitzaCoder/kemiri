/** Cancel while waiting for a serial operation. Once it starts, the operation owns cancellation. */
export function afterQueuedOperation<T>(previous: Promise<unknown>, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return previous.then(work);
	return new Promise((resolve, reject) => {
		const cancel = () => reject(signal.reason);
		if (signal.aborted) return cancel();
		signal.addEventListener("abort", cancel, { once: true });
		void previous.then(async () => {
			signal.removeEventListener("abort", cancel);
			if (signal.aborted) return;
			try { resolve(await work()); }
			catch (error) { reject(error); }
		}, reject);
	});
}
