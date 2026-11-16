import { cardRefOf } from "./ref-card.js";
import { taskIdFromHref } from "./task-chat.js";

/** The reference link eligible for a preview, respecting task-navigation containers. */
export function refCardAnchor(target: EventTarget | null, pageHref: string): HTMLAnchorElement | undefined {
	if (!(target instanceof Element) || target.closest("[data-ref-card]") !== null) return undefined;
	const anchor = target.closest("a[href]");
	if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("data-no-ref-card")) return undefined;
	if (cardRefOf(anchor.href) !== undefined) return anchor;
	// Rows/cards already navigate to the task. Do not intercept their hover, focus or touch click.
	if (anchor.closest("[data-no-task-preview]") !== null) return undefined;
	return taskIdFromHref(anchor.href, pageHref) === undefined ? undefined : anchor;
}
