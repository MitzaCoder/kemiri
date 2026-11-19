import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { LIVE_PLAN_MAX_STEPS, LIVE_PLAN_STEP_MAX_CHARS, type BoardLivePlanStep } from "@kemiri/protocol";
import type { AcpUpdate } from "./acp-client.ts";

export const ACP_TOOL_ENTRY = "kemiri.acp-tool";
const TOOL_LABELS = {
 read: "Reading a file", edit: "Editing a file", delete: "Deleting a file", move: "Moving a file",
 search: "Searching", execute: "Running a command", think: "Thinking", fetch: "Fetching content",
 switch_mode: "Switching mode", other: "Using an agent tool",
} as const;
type ToolKind = keyof typeof TOOL_LABELS;
type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type AcpToolSnapshot = { kind: ToolKind; status: ToolStatus; paths: string[]; changedPaths: string[] };
export type AcpToolStep = AcpToolSnapshot & { callId: string; turnId: string; at: number };
export type AcpActivityUpdate = { plan: BoardLivePlanStep[] } | { callId: string; kind?: ToolKind; status?: ToolStatus; paths: string[]; diffPaths: string[]; at: number };

export function acpToolStep(entry: Pick<EntryRecord, "kind" | "data">): AcpToolStep | undefined {
 return entry.kind === ACP_TOOL_ENTRY ? entry.data as AcpToolStep : undefined;
}
export const acpToolLabel = (kind: ToolKind) => TOOL_LABELS[kind];

function object(value: unknown): Record<string, unknown> | undefined {
 return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function acpActivityUpdate(update: AcpUpdate, cwd: string): AcpActivityUpdate | undefined {
 if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
  const plan: BoardLivePlanStep[] = [];
  for (const entry of update.entries) {
   const fields = object(entry);
   const status = fields?.status === "completed" ? "done" : fields?.status === "in_progress" ? "doing" : fields?.status === "pending" ? "todo" : undefined;
   const text = typeof fields?.content === "string" ? fields.content.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, LIVE_PLAN_STEP_MAX_CHARS) : "";
   if (text && status) plan.push({ text, status });
   if (plan.length === LIVE_PLAN_MAX_STEPS) break;
  }
  if (plan.length || !update.entries.length) return { plan };
 }
 if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
 if (typeof update.toolCallId !== "string" || !update.toolCallId || update.toolCallId.length > 1024) return;
 const collectPaths = (entries: unknown, diffs = false) => Array.isArray(entries) ? entries.slice(0, 64).flatMap(entry => {
  const fields = object(entry);
  const path = fields?.path;
  if (diffs && fields?.type !== "diff" || typeof path !== "string" || !path.trim() || path.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(path)) return [];
  // Normalize absolute and relative paths from the same workspace to the same identity.
  return [relative(cwd, resolve(cwd, path))].filter(Boolean);
 }) : [];
 const kind = typeof update.kind === "string" && Object.hasOwn(TOOL_LABELS, update.kind) ? update.kind as ToolKind : undefined;
 const status = update.status === "pending" || update.status === "in_progress" || update.status === "completed" || update.status === "failed" ? update.status : undefined;
 return { callId: createHash("sha256").update(update.toolCallId).digest("hex"), ...(kind ? { kind } : {}), ...(status ? { status } : {}),
  paths: collectPaths(update.locations), diffPaths: collectPaths(update.content, true), at: Date.now() };
}
