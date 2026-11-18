import { expect, it } from "bun:test";
import { countChatDetailTurn, detectMissingChatDetail, type ChatDetailCounts } from "../src/task-chat-detail.ts";

const steps = `1. Open the settings panel and select the project profile.
2. Set the refresh interval to 35 minutes.
3. Save the new profile using the green button.
4. Reload the dashboard and confirm the interval.`;

it("compares each numbered step with normalized task prose, including partial repeats and changed exact values", () => {
 expect(detectMissingChatDetail(steps, ["Open the SETTINGS panel and choose the project profile.", "Set the refresh interval to 45 minutes."])).toMatchObject({ steps: 3 });
 expect(detectMissingChatDetail(steps, [steps])).toBeUndefined();
 expect(detectMissingChatDetail(steps, [steps.replace("35", "45")])).toMatchObject({ steps: 1 });
 expect(detectMissingChatDetail("1. First\n2. Second\n\nSeparate paragraph.\n\n1. Third\n2. Fourth", [])).toBeUndefined();
 expect(detectMissingChatDetail(steps.split("\n").map(line => `> ${line}`).join("\n"), [])).toBeUndefined();
 expect(detectMissingChatDetail(`1) Open the panel\n   and select the amber tab.\n\n2) Select a profile.\n3) Save it.`, ["Open the panel and select the amber tab."])).toMatchObject({ steps: 2 });
});

it("compares code case-sensitively after normalizing only whitespace and ignores non-command inline values", () => {
 const code = "```json\n{ \"profile\": 35 }\n```";
 expect(detectMissingChatDetail(code, ["~~~json\n{   \"profile\":  35 }\n~~~"])).toBeUndefined();
 expect(detectMissingChatDetail(code, [code.replace("35", "45")])).toMatchObject({ code: true });
 const command = "Run `example-cli check --profile amber`.";
 expect(detectMissingChatDetail(command, ["```sh\nexample-cli  check --profile amber\nexample-cli status\n```"])).toBeUndefined();
 expect(detectMissingChatDetail(command, ["`example-cli check --profile amberish`"])).toMatchObject({ command: true });
 expect(detectMissingChatDetail(command, ["`example-cli check --profile Amber`"])).toMatchObject({ command: true });
 expect(detectMissingChatDetail("The setting is `refresh interval` and the value is `35`.", [])).toBeUndefined();
});

it("requires at least 800 prose characters, under a third written, and missing substance", () => {
 const sentence = "The amber profile retains the fixture settings while the violet dashboard resets its selection. ";
 const long = sentence.repeat(9).trim();
 expect(long.length).toBeGreaterThan(800);
 expect(detectMissingChatDetail(long, [], Math.floor(long.length / 3) - 1)).toMatchObject({ prose: true });
 expect(detectMissingChatDetail(long, [], Math.ceil(long.length / 3))).toBeUndefined();
 expect(detectMissingChatDetail(long, [sentence])).toBeUndefined();
 expect(detectMissingChatDetail(long.slice(0, 799), [])).toBeUndefined();
});

it("retains only the last 30 UTC calendar days of numeric totals", () => {
 const counts: ChatDetailCounts = {};
 const day = Date.parse("2026-03-01T23:55:00Z");
 countChatDetailTurn(counts, day, true);
 countChatDetailTurn(counts, day, false);
 expect(counts["2026-03-01"]).toEqual({ flagged: 1, clean: 1 });
 countChatDetailTurn(counts, day + 5 * 60_000, false);
 expect(counts["2026-03-02"]).toEqual({ flagged: 0, clean: 1 });
 countChatDetailTurn(counts, day + 30 * 86_400_000, true);
 expect(Object.keys(counts)).toEqual(["2026-03-02", "2026-03-31"]);
});
