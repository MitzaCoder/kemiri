import { expect, test } from "bun:test";
import { fuzzyMatch } from "../src/search-fuzzy.ts";
import vectors from "../test-vectors/task-search.json";

for (const { text, query, score, ranges } of vectors.fuzzy) {
	test(`file search uses task fuzzy scores for ${JSON.stringify([text, query])}`, () => {
		const match = fuzzyMatch(text, query);
		if (score === null) expect(match).toBeUndefined();
		else {
			expect(match?.score).toBeCloseTo(score);
			expect(ranges).toEqual(match?.ranges ?? []);
		}
	});
}
