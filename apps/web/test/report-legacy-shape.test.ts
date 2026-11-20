import { expect, test } from 'bun:test';
import { shapeLegacyReport, type LegacyReportSection, type LegacyReportSegment } from '../src/lib/report-legacy-shape.js';
import fixtures from '../../../packages/protocol/test-vectors/report-legacy-shape-v1.json';

for (const { name, section, markdown, expected } of fixtures as {
	name: string;
	section: LegacyReportSection;
	markdown: string;
	expected: LegacyReportSegment[];
}[]) {
	test(name, () => expect(shapeLegacyReport(section, markdown)).toEqual(expected));
}
