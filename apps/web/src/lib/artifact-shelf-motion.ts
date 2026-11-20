/** FLIP across shelf parents, where Svelte's keyed-list animation cannot follow an object. */
export function shelfObjectPositions(shelves: HTMLElement | undefined) {
	if (!shelves || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
	return new Map([...shelves.querySelectorAll<HTMLElement>('[data-shelf-object]')].map(node => [node.dataset.shelfObject, node.getBoundingClientRect()]));
}

export function flyShelfObjects(shelves: HTMLElement | undefined, previous: ReturnType<typeof shelfObjectPositions>) {
	if (!shelves || !previous || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	for (const node of shelves.querySelectorAll<HTMLElement>('[data-shelf-object]')) {
		const first = previous.get(node.dataset.shelfObject);
		if (!first) continue;
		const last = node.getBoundingClientRect();
		const x = first.left - last.left, y = first.top - last.top;
		if (Math.abs(x) + Math.abs(y) < 1) continue;
		node.getAnimations().forEach(animation => animation.cancel());
		const scale = Math.max(.5, Math.min(2, first.width / last.width));
		node.animate([{ transform: `translate(${x}px, ${y}px) scale(${scale})` }, { transform: 'none' }], { duration: 430, easing: 'cubic-bezier(.2,.75,.25,1)' });
	}
}
