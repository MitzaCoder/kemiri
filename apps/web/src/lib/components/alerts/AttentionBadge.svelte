<script lang="ts">
	import { onMount } from 'svelte';
	import { alerts } from '#lib/alerts.svelte.js';
	import { harness } from '#lib/harness.svelte.js';
	import { latestInboxRows } from '#lib/alert-inbox.js';
	import { needsYouLinks } from '#lib/sidebar-attention.js';
	import { attentionBadge, attentionTabTitle, URGENT_FAVICON } from '#lib/attention-badge.js';

	const badge = $derived(attentionBadge(needsYouLinks(harness.backends), latestInboxRows(alerts.rows), alerts.tabTitleAndIconCount));
	const count = $derived(badge.count);
	const urgent = $derived(badge.urgent);
	let baseTitle = $state<string>();
	let shownTitle: string | undefined;
	let setFavicon = $state<((urgent: boolean) => void) | undefined>();

	onMount(() => {
		baseTitle = document.title;
		const observer = new MutationObserver(() => {
			if (document.title !== shownTitle) baseTitle = document.title;
		});
		observer.observe(document.head, { subtree: true, childList: true, characterData: true });
		const icons = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map(link => ({
			link, href: link.getAttribute('href'), type: link.getAttribute('type'), sizes: link.getAttribute('sizes'),
		}));
		const updateFavicon = (hasUrgent: boolean) => {
			for (const { link, href, type, sizes } of icons) {
				for (const [key, value] of [['href', hasUrgent ? URGENT_FAVICON : href], ['type', hasUrgent ? 'image/svg+xml' : type], ['sizes', hasUrgent ? 'any' : sizes]] as const) {
					if (value === null) link.removeAttribute(key);
					else if (link.getAttribute(key) !== value) link.setAttribute(key, value);
				}
			}
		};
		setFavicon = updateFavicon;
		return () => {
			observer.disconnect();
			if (baseTitle !== undefined && document.title === shownTitle) document.title = baseTitle;
			updateFavicon(false);
		};
	});

	$effect(() => {
		if (baseTitle === undefined) return;
		// Project data can update the route title and the count in the same render, before the observer runs.
		const currentTitle = document.title;
		const routeTitle = currentTitle === shownTitle ? baseTitle : currentTitle;
		if (routeTitle !== baseTitle) baseTitle = routeTitle;
		shownTitle = attentionTabTitle(routeTitle, count);
		if (currentTitle !== shownTitle) document.title = shownTitle;
	});
	$effect(() => setFavicon?.(urgent));
	$effect(() => {
		// The installed badge uses the same count. Browser support and permissions vary.
		if (count > 0) void navigator.setAppBadge?.(count).catch(() => {});
		else void navigator.clearAppBadge?.().catch(() => {});
	});
</script>
