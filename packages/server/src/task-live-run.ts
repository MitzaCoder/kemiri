import { posix } from "node:path";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { BoardLivePulse } from "@kemiri/protocol";

const TOOL_LABELS: Readonly<Record<string, string>> = {
 bash: "Running a command", powershell: "Running a command", edit: "Editing a file",
 write: "Writing a file", read: "Reading a file", artifact_save: "Saving files",
 task_progress: "Recording progress", codemode: "Running tools",
};

/** Never display arguments, output, paths or streamed text. Command classes are fixed strings. */
function toolLabel(name: string, args: Record<string, unknown> | undefined): string {
 if (name === "bash" && typeof args?.command === "string" &&
     /^(?:bun|npm|pnpm|yarn) (?:run )?test(?:\s|$)|^(?:cargo test|go test|pytest)(?:\s|$)/.test(args.command.trim())) return "Running tests";
 return Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name]! : "Using a tool";
}

function isCommitCommand(command: unknown): boolean {
 if (typeof command !== "string") return false;
 // Deliberately recognize a direct command only. A compound shell's exit status need not be the commit's.
 const words = command.trim().match(/(?:"[^"$`]*"|'[^']*'|[^\s;|&<>`$()\\"'])+/g);
 if (!words || /[;|&<>`$()#\\\n]/.test(command.replace(/'[^']*'|"[^"$`]*"/g, ""))) return false;
 const [vcs, subcommand, ...args] = words;
 return (vcs === "git" && subcommand === "commit" && !args.some(arg => ["--dry-run", "--help", "-h"].includes(arg))) ||
  (vcs === "jj" && (subcommand === "commit" || subcommand === "describe" && args.some(arg => /^-m.|^--message=/.test(arg) || arg === "-m" || arg === "--message")));
}

function nestedArgs(args: string): Record<string, unknown> {
 try { return JSON.parse(args) ?? {}; } catch {
  // A long edit can clip the display receipt after its leading path. Accept only a complete JSON string.
  const path = /^\{\s*"path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(args)?.[1];
  try { return path ? { path: JSON.parse(path) } : {}; } catch { return {}; }
 }
}

/** One run's transcript projection. Call/result matching ensures failed edits and commands are not counted as changes. */
export class TaskLiveRun {
 readonly #calls = new Map<string, string>();
 #nestedSteps = 0;
 readonly #settledCodemode = new Set<string>();
 readonly #pending = new Map<string, "commit" | { path: string }>();
 readonly changedPaths = new Set<string>();
 readonly commitIds = new Set<string>();
 commitsWithoutId = 0;
 #pulseKey: string | undefined;
 pulse: BoardLivePulse | undefined;
 get steps(): number { return this.#calls.size + this.#nestedSteps; }

 #changedPath(name: string, args: Record<string, unknown>): string | undefined {
  return (name === "edit" || name === "write") && typeof args.path === "string" && args.path ? posix.normalize(args.path) : undefined;
 }

 add(entry: Pick<EntryRecord, "model">): void {
  for (const message of entry.model ?? []) {
   if (message.role === "assistant") for (const call of message.content) {
    if (call.type !== "toolCall" || this.#calls.has(call.id)) continue;
    this.#calls.set(call.id, toolLabel(call.name, call.arguments));
    const path = this.#changedPath(call.name, call.arguments);
    if (path) this.#pending.set(call.id, { path });
    if ((call.name === "bash" || call.name === "powershell") && isCommitCommand(call.arguments.command)) this.#pending.set(call.id, "commit");
   }
   if (message.role !== "toolResult") continue;
   const details = message.details;
   if (message.toolName === "codemode" && details && typeof details === "object" && "calls" in details && Array.isArray(details.calls) && !this.#settledCodemode.has(message.toolCallId)) {
    this.#settledCodemode.add(message.toolCallId);
    // Codemode persists its nested call receipts in the parent result. No additional tool write is needed.
    for (const nested of details.calls) {
     if (nested === null || typeof nested !== "object" || typeof nested.name !== "string" || typeof nested.args !== "string") continue;
     this.#nestedSteps += 1;
     if (nested.status !== "ok") continue;
     const args = nestedArgs(nested.args);
     const path = this.#changedPath(nested.name, args);
     if (path) this.changedPaths.add(path);
     if ((nested.name === "bash" || nested.name === "powershell") && isCommitCommand(args.command)) this.commitsWithoutId += 1;
    }
   }
   const call = this.#pending.get(message.toolCallId);
   this.#pending.delete(message.toolCallId);
   if (!call || message.isError) continue;
   if (call !== "commit") this.changedPaths.add(call.path);
   else {
    const output = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const commitId = /^(?:\[[^\]\n]+ |Parent commit\s+\(@-\)\s*:\s+[a-z]+ )([0-9a-f]{7,64})(?:\]|\s)/m.exec(output)?.[1];
    if (commitId) this.commitIds.add(commitId);
    else this.commitsWithoutId += 1;
   }
  }
 }

 /** Identity ignores streamed output and partial tokens. The clock starts when the slot is first observed. */
 updatePulse(live: Readonly<LiveState> | null, now: string): void {
  const nested = live?.nestedTools?.findLast(slot => slot.status === "running");
  const slot = nested ?? live?.tools?.find(slot => slot.status === "running");
  const writing = live?.generation?.message?.content.some(part => part.type === "text" && !!part.text);
  const key = slot ? `tool:${slot.taskId}:${slot.callId}` : live?.generation ? writing ? "writing" : "thinking" : undefined;
  if (key === this.#pulseKey) return;
  this.#pulseKey = key;
  this.pulse = !key ? undefined : slot ? { label: nested ? toolLabel(slot.name, nested.arguments) : this.#calls.get(slot.callId) ?? toolLabel(slot.name, undefined),
    // Registered names, not call arguments. Some extensions supply arbitrary names; reject those shapes.
    ...(/^[a-z][a-z0-9_-]{0,63}$/.test(slot.name) ? { tool: slot.name } : {}), since: now }
   : { label: writing ? "Writing" : "Thinking", since: now };
 }
}
