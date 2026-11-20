import type { BackendConnection } from './harness.svelte.js';
export const DISCUSSION_CHAT = Symbol('artifact discussion chat');
export type DiscussionChat = { backend: BackendConnection; projectId: string; relevant: (taskId: string, at: number) => boolean };
