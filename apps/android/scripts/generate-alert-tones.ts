/** Regenerate both SoundPool samples with Bun. All samples are mono 16-bit PCM. */
const sampleRate = 24_000;
function note(hz: number, seconds: number, gain: number): number[] {
	const length = Math.floor(sampleRate * seconds);
	return Array.from({ length }, (_, i) => {
		const attack = Math.min(i / (sampleRate * 0.008), 1);
		const release = (1 - i / length) ** 1.6;
		return Math.round(32767 * gain * attack * release * Math.sin(2 * Math.PI * hz * i / sampleRate));
	});
}

async function writeTone(name: string, samples: number[]): Promise<void> {
	const wav = Buffer.alloc(44 + 2 * samples.length);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(samples.length * 2, 40);
	samples.forEach((sample, i) => wav.writeInt16LE(sample, 44 + i * 2));
	await Bun.write(new URL(`../app/src/main/res/raw/alert_${name}.wav`, import.meta.url), wav);
}

await writeTone("urgent", [...note(660, 0.12, 0.52), ...new Array<number>(720).fill(0), ...note(880, 0.15, 0.52)]);
await writeTone("soft", note(330, 0.16, 0.32));
