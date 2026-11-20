/**
 * Markdown to independent, sanitized blocks.
 *
 * Each top-level token renders on its own and is cached by its source, so a
 * streaming reply only re-renders the block that is still arriving. Code fences
 * are handed to the highlighter instead of being rendered here.
 *
 * DOMPurify runs over every rendered token: model output is untrusted.
 */
import DOMPurify from "dompurify";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import remend from "remend";
import { isTaskSelfReference } from '../task-reference-highlight.js';
import { linkTaskMentions } from "../task-chat.ts";

type SelfReferenceToken = { selfReferenceId?: string };

function selfReferenceMarkup(taskId: string): string {
	// Self-reference IDs have already been validated as T + digits by isTaskSelfReference.
	return `<span class="task-self-reference" role="img" aria-label="this task, ${taskId}" data-task-id="${taskId}" tabindex="0">this task</span>`;
}

const renderer = {
	link(this: Renderer, token: Tokens.Link & SelfReferenceToken) {
		return token.selfReferenceId === undefined ? Renderer.prototype.link.call(this, token) : selfReferenceMarkup(token.selfReferenceId);
	},
	codespan(this: Renderer, token: Tokens.Codespan & SelfReferenceToken) {
		return token.selfReferenceId === undefined ? Renderer.prototype.codespan.call(this, token) : selfReferenceMarkup(token.selfReferenceId);
	},
	// Wide tables scroll horizontally instead of stretching the chat column.
	table(this: Renderer, token: Tokens.Table) {
		return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>`;
	},
};
const marked = new Marked({ gfm: true, renderer });
// User text uses the same blocks and sanitiser, but chat newlines are intentional and HTML is literal text.
const userMarkdown = new Marked({ gfm: true, breaks: true, renderer: {
	...renderer,
	html({ text }: Tokens.HTML | Tokens.Tag) {
		return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	},
} });

let purifyConfigured = false;

function purify(html: string): string {
	if (!purifyConfigured) {
		DOMPurify.addHook("afterSanitizeAttributes", (node) => {
			// In-page anchors and task links open in place; anything else leaves the app in a new tab.
			const href = node.getAttribute("href") ?? "";
			if (node.tagName === "A" && !href.startsWith("#") && !href.startsWith("?task=")) {
				node.setAttribute("target", "_blank");
				node.setAttribute("rel", "noopener noreferrer");
			}
		});
		purifyConfigured = true;
	}
	return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

export type Block =
	| { kind: "html"; key: string; html: string }
	| { kind: "code"; key: string; lang: string; code: string; closed: boolean };

const TABLE_ROW = /^\s*\|.*$/;
const DELIMITER_CELL = /^\s*:?-*:?\s*$/;

function cells(row: string): string[] {
	return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

/**
 * While streaming, a table only parses once its `|---|` delimiter row is
 * complete. Until then, give a trailing header row a complete delimiter so the
 * table renders immediately instead of showing raw pipes.
 */
export function completeStreamingTable(text: string): string {
	const lines = text.split("\n");
	let start = lines.length;
	while (start > 0 && TABLE_ROW.test(lines[start - 1])) start--;
	const rows = lines.slice(start);
	if (rows.length === 0 || rows.length > 2 || (start > 0 && lines[start - 1].trim() !== "")) {
		return text;
	}
	if (inFence(lines.slice(0, start))) return text;

	const header = rows[0];
	const columns = cells(header).filter((cell, i, all) => cell.trim() || i < all.length - 1).length;
	if (columns < 2) return text;
	if (rows.length === 2) {
		const delimiterCells = cells(rows[1]);
		if (!delimiterCells.every((cell) => DELIMITER_CELL.test(cell))) return text;
		if (delimiterCells.length >= columns && delimiterCells.every((cell) => cell.includes("-"))) {
			return text;
		}
	}

	const delimiter = `|${" --- |".repeat(columns)}`;
	const closedHeader = header.trimEnd().endsWith("|") ? header : `${header} |`;
	return [...lines.slice(0, start), closedHeader, delimiter].join("\n");
}

function inFence(lines: string[]): boolean {
	let open = false;
	for (const line of lines) if (/^ {0,3}(```|~~~)/.test(line)) open = !open;
	return open;
}

function isClosedFence(token: Tokens.Code): boolean {
	const raw = token.raw.trimEnd();
	const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
	if (!fence) return true; // indented code block
	const lastLine = raw.slice(raw.lastIndexOf("\n") + 1).trim();
	return raw.includes("\n") && lastLine.startsWith(fence[0]) && lastLine.length >= fence.length;
}

/** Rendered HTML of top-level tokens, keyed by their raw source. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 2000;

function renderToken(token: Token, userMessage: boolean, taskMentions = false): string {
	const key = `${userMessage}\u0000${token.type}\u0000${taskMentions ? JSON.stringify(token) : token.raw}`;
	let html = cache.get(key);
	if (html === undefined) {
		html = purify((userMessage ? userMarkdown : marked).parser([token]));
		if (cache.size >= CACHE_LIMIT) cache.clear();
		cache.set(key, html);
	}
	return html;
}

/** Link only parsed text, never code, destinations, HTML, images or existing link labels. */
function linkTaskTokens(tokens: Token[], title: (id: string) => string | undefined, streamingTail?: string, openTaskId?: string): void {
	for (const token of tokens) {
		if (token.type === "link" || token.type === "codespan") {
			const id = token.type === "link" ? /^\?task=(T\d+)$/.exec(token.href)?.[1] : token.text;
			if (id !== undefined && isTaskSelfReference(id, openTaskId)) (token as SelfReferenceToken).selfReferenceId = id;
			continue;
		}
		if (["image", "code", "html", "escape"].includes(token.type)) continue;
		if (token.type === "table") {
			for (const cell of [...token.header, ...token.rows.flat()]) linkTaskTokens(cell.tokens, title, streamingTail, openTaskId);
		} else if (token.type === "list") {
			for (const item of token.items) linkTaskTokens(item.tokens, title, streamingTail, openTaskId);
		} else if ("tokens" in token && token.tokens !== undefined) {
			linkTaskTokens(token.tokens, title, streamingTail, openTaskId);
		} else if (token.type === "text") {
			const linked = linkTaskMentions(token.text, { title, streaming: streamingTail !== undefined && streamingTail.endsWith(token.raw) });
			if (linked !== token.text) {
				token.tokens = marked.Lexer.lexInline(linked);
				linkTaskTokens(token.tokens, title, streamingTail, openTaskId);
			}
		}
	}
}

/**
 * Split markdown into independently rendered top-level blocks.
 *
 * While streaming, unterminated inline syntax is completed first (remend), so
 * partial bold, links or code spans render as they will when finished. A
 * block's HTML only changes when its own source does, so earlier blocks are not
 * re-rendered as text streams in.
 */
export function toBlocks(source: string, streaming: boolean, userMessage = false, taskTitle?: (id: string) => string | undefined, openTaskId?: string): Block[] {
	const text = streaming ? completeStreamingTable(remend(source, { linkMode: "text-only" })) : source;
	const tokens = (userMessage ? userMarkdown : marked).lexer(text);
	const taskMentions = taskTitle !== undefined || openTaskId !== undefined;
	if (taskMentions) linkTaskTokens(tokens, id => isTaskSelfReference(id, openTaskId) ? '' : taskTitle?.(id), streaming ? source : undefined, openTaskId);
	const blocks: Block[] = [];

	for (const token of tokens) {
		if (token.type === "space") continue;
		const key = String(blocks.length);
		if (token.type === "code") {
			blocks.push({
				kind: "code",
				key,
				lang: token.lang ?? "",
				code: token.text,
				closed: !streaming || isClosedFence(token as Tokens.Code),
			});
		} else {
			blocks.push({ kind: "html", key, html: renderToken(token, userMessage, taskMentions) });
		}
	}
	return blocks;
}

/** Render inline Markdown without interpreting its source as a new block. */
export function renderInline(source: string, taskTitle?: (id: string) => string | undefined, openTaskId?: string): string {
	const tokens = marked.Lexer.lexInline(source, marked.defaults);
	if (taskTitle !== undefined || openTaskId !== undefined) {
		linkTaskTokens(tokens, id => isTaskSelfReference(id, openTaskId) ? '' : taskTitle?.(id), undefined, openTaskId);
	}
	return purify(marked.Parser.parseInline(tokens, marked.defaults));
}
