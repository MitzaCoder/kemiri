import { markdownText } from '@kemiri/protocol';

/** The closed door shows the first written items, not a truncated slice of raw Markdown. */
export function reportExcerptLines(source: string, limit: number): string[] {
	const lines = source.split(/\r?\n/);
	const items: string[] = [];
	let fence: string | undefined;
	for (const line of lines) {
		const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			continue;
		}
		if (fence || /^\s*(?:#{1,6}\s|[-*_]{3,}\s*$)/.test(line)) continue;
		const text = markdownText(line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')).trim();
		if (text) items.push(text);
	}
	return items.slice(0, limit);
}
