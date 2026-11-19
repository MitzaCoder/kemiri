import { defineExtension, wrapTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { COMMAND_INTENT_MAX_CHARS } from "./task-live-run.ts";

/** Extend the registered bash schema without changing command execution or output handling. */
export const workerCommandIntent = defineExtension({
 name: "worker-command-intent",
 wraps: [wrapTool(createBashTool() as ToolRegistration, tool => {
  const parameters = tool.parameters as { properties: Record<string, unknown> };
  return { ...tool, parameters: Type.Unsafe({
   ...parameters,
   properties: { ...parameters.properties, intent: Type.String({
    maxLength: COMMAND_INTENT_MAX_CHARS,
    description: "Optional few words on what the command is for, shown on the task. Use prose, not command text or secrets.",
   }) },
  }) };
 })],
});
