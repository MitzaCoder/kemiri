<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import { harness } from '#lib/harness.svelte.js';
	import { artifactTitle } from '#lib/artifacts.js';
	import { draftKey } from '#lib/drafts.js';
	import { projectHref, threadHref } from '#lib/backends.js';
	import { moveReviewToDraft } from '#lib/artifact-review-draft.js';
	import { quoteFromSelection, selectionInWholeWords } from '#lib/chat/quotes.js';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import ArtifactCommentCard from './ArtifactCommentCard.svelte';
	import ArtifactCommentPreview from './ArtifactCommentPreview.svelte';
	import { ArtifactReviewSubmission, reviewThreadId, artifactReviewKey, loadArtifactReview, saveArtifactReview, formatArtifactReview, precedingArtifactHeading, reviewText, reviewLocation, validateArtifactSelection, type ArtifactSelection, type ReviewComment, type ReviewIntent } from '#lib/artifact-review.js';
	import { SELECTION_RECT, validateArtifactRects, watchAnchorsMessage, reviewPins, placeReviewCard, blockPath, textOffset, anchorClientRect, type ReviewRect } from '#lib/artifact-review-anchors.js';

	let { artifact, client, layout, surface, textRoot, frame, anchorKind, onclose }: {
		artifact: Artifact; client: HarnessClient; layout?: HTMLElement; surface?: HTMLElement;
		textRoot?: HTMLElement; frame?: HTMLIFrameElement; anchorKind: 'p' | 'm' | 's'; onclose?: () => void;
	} = $props();
	const pageView = $derived(anchorKind === 'p');
	const backend = $derived(harness.backends.find(backend => backend.client === client));
	const key = untrack(() => artifactReviewKey(backend?.id ?? page.params.backend ?? '', artifact.projectId, artifact.id, artifact.version ?? 1));
	const restored = untrack(() => loadArtifactReview(localStorage, key));
	let comments = $state(restored.comments);
	let overall = $state(restored.overall);
	let editor = $state<{ selection: ArtifactSelection; index?: number; inTray: boolean }>();
	let intent = $state<ReviewIntent>();
	let note = $state('');
	let editorOrigin: HTMLElement | undefined;
	let trayOpen = $state(false);
	let picking = $state(false);
	let sending = $state(false);
	let problem = $state('');
	let status = $state('');
	let stored = $state(true);
	let commentCounter: HTMLButtonElement;
	let coarsePointer = $state(false);
	let hoverPointer = $state(false);
	let sheet = $state(false);
	const coarse = $derived(coarsePointer || (sheet && !hoverPointer));
	let frameRects = $state<ReadonlyMap<string, ReviewRect>>(new Map());
	let documentRects = $state<ReadonlyMap<string, ReviewRect>>(new Map());
	let liveRange: Range | undefined;
	let layer = $state({ x: 0, y: 0, width: 0, height: 0, insetY: 0 });
	let cardHeight = $state(0), cardWidth = $state(0);
	let previewHeight = $state(0), previewWidth = $state(0);
	let preview = $state<{ anchor: string; pinned: boolean }>();
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressPinFocus = false;
	let selecting = false;
	let selectionTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshFrame = 0;
	const submission = new ArtifactReviewSubmission();
	const surfaceRects = $derived(pageView ? frameRects : documentRects);
	const offsetRects = $derived.by(() => {
		if (!layer.insetY) return surfaceRects;
		return new Map([...surfaceRects].map(([key, rect]) => [key, { ...rect, y: rect.y - layer.insetY }]));
	});
	const pins = $derived(reviewPins(comments, offsetRects, layer));
	const previewPin = $derived(pins.find(pin => pin.anchor === preview?.anchor));
	const editRect = $derived(editor && offsetRects.get(editor.index === undefined ? SELECTION_RECT : editor.selection.anchor ?? ''));
	const outline = $derived(editor && !editor.inTray ? editRect : previewPin?.rect);
	const cardPosition = $derived(placeReviewCard(editRect ?? { x: 0, y: 0, width: 0, height: 0 }, layer, { width: cardWidth, height: cardHeight }));
	const previewPosition = $derived(previewPin && placeReviewCard({ x: previewPin.x - previewWidth + 22, y: previewPin.y - 22, width: 44, height: 44 }, layer, { width: previewWidth, height: previewHeight }, 2));
	const watched = $derived(watchAnchorsMessage(comments));

	$effect(() => { stored = saveArtifactReview(localStorage, key, { comments, overall }); });
	$effect(() => {
		const viewer = frame;
		if (!pageView || !viewer) return;
		const watch = () => viewer.contentWindow?.postMessage(watched, '*');
		const reload = () => {
			frameRects = new Map();
			closePreview();
			picking = false;
			if (editor && !editor.inTray && editor.index === undefined) {
				if (editorTouched()) { editor.inTray = true; trayOpen = true; }
				else dismissEditor(false, false);
			}
			watch();
		};
		// The effect reports comment changes; the load listener also covers srcdoc reloads (theme changes).
		watch();
		viewer.addEventListener('load', reload);
		return () => viewer.removeEventListener('load', reload);
	});
	$effect(() => {
		const root = textRoot;
		const viewer = surface;
		const parent = layout;
		anchorKind;
		if (!viewer || !parent) return;
		const observer = new ResizeObserver(scheduleGeometry);
		for (const element of new Set([viewer, parent, ...(root ? [root] : [])])) observer.observe(element);
		return () => observer.disconnect();
	});
	$effect(() => { comments; textRoot; surface; anchorKind; scheduleGeometry(); });
	$effect(() => {
		anchorKind;
		untrack(() => {
			closePreview();
			if (editor && !editor.inTray) {
				if (editorTouched()) { editor.inTray = true; trayOpen = true; }
				else dismissEditor(false);
			}
			picking = false;
			liveRange = undefined;
			frameRects = new Map();
			documentRects = new Map();
		});
	});
	$effect(() => { if (preview && !previewPin) closePreview(); });

	function scheduleGeometry(): void {
		if (refreshFrame) return;
		refreshFrame = requestAnimationFrame(() => {
			refreshFrame = 0;
			if (!layout || !surface) { layer = { x: 0, y: 0, width: 0, height: 0, insetY: 0 }; return; }
			const parent = layout.getBoundingClientRect(), bounds = surface.getBoundingClientRect();
			// Offset and scale cancel out a dialog transform. Frame rectangles already use layout pixels.
			const scaleX = parent.width / layout.clientWidth || 1, scaleY = parent.height / layout.clientHeight || 1;
			const viewport = window.visualViewport;
			const top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
			const bottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
			layer = { x: (bounds.left - parent.left) / scaleX, y: (top - parent.top) / scaleY, width: surface.clientWidth, height: Math.max(0, (bottom - top) / scaleY), insetY: (top - bounds.top) / scaleY };
			sheet = layout.clientWidth < 640;
			if (!textRoot || anchorKind === 'p') return;
			const relative = (rect: ReviewRect) => ({ x: (rect.x - bounds.x) / scaleX, y: (rect.y - bounds.y) / scaleY, width: rect.width / scaleX, height: rect.height / scaleY });
			const rects = new Map<string, ReviewRect>();
			for (const { anchor } of comments) {
				if (!anchor || rects.has(anchor)) continue;
				const rect = anchorClientRect(textRoot, anchorKind, anchor);
				if (rect) rects.set(anchor, relative(rect));
			}
			if (liveRange && textRoot.contains(liveRange.commonAncestorContainer)) rects.set(SELECTION_RECT, relative(liveRange.getBoundingClientRect()));
			documentRects = rects;
		});
	}

	export function cancelTransient(): boolean {
		if (editor) { dismissEditor(); return true; }
		if (preview) { closePreview(true); return true; }
		if (picking) { frame?.contentWindow?.postMessage('kemiri:cancel-artifact-pick', '*'); picking = false; return true; }
		return false;
	}
	onMount(() => {
		const pointer = matchMedia('(pointer: coarse)');
		const hover = matchMedia('(hover: hover)');
		const pointerChanged = () => { coarsePointer = pointer.matches; hoverPointer = hover.matches; };
		pointerChanged();
		const message = (event: MessageEvent) => {
			if (!pageView) return;
			const rects = validateArtifactRects(event.source, frame?.contentWindow, event.data);
			if (rects) { frameRects = rects; return; }
			const selected = validateArtifactSelection(event.source, frame?.contentWindow, event.data);
			if (!selected) return;
			picking = false;
			select(selected.text ? selected : undefined);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && cancelTransient()) { event.preventDefault(); event.stopImmediatePropagation(); }
		};
		const outsidePreview = (event: PointerEvent) => {
			if (preview && !(event.target instanceof Element && event.target.closest('[data-review-pin-group]'))) closePreview();
		};
		const blur = () => closePreview();
		pointer.addEventListener('change', pointerChanged);
		hover.addEventListener('change', pointerChanged);
		window.addEventListener('message', message);
		window.addEventListener('keydown', escape, true);
		window.addEventListener('pointerdown', outsidePreview, true);
		window.addEventListener('blur', blur);
		window.addEventListener('scroll', scheduleGeometry, true);
		window.addEventListener('resize', scheduleGeometry);
		window.visualViewport?.addEventListener('resize', scheduleGeometry);
		window.visualViewport?.addEventListener('scroll', scheduleGeometry);
		return () => {
			pointer.removeEventListener('change', pointerChanged);
			hover.removeEventListener('change', pointerChanged);
			window.removeEventListener('message', message);
			window.removeEventListener('keydown', escape, true);
			window.removeEventListener('pointerdown', outsidePreview, true);
			window.removeEventListener('blur', blur);
			window.removeEventListener('scroll', scheduleGeometry, true);
			window.removeEventListener('resize', scheduleGeometry);
			window.visualViewport?.removeEventListener('resize', scheduleGeometry);
			window.visualViewport?.removeEventListener('scroll', scheduleGeometry);
			cancelAnimationFrame(refreshFrame);
			clearTimeout(previewTimer);
			clearTimeout(selectionTimer);
		};
	});

	function selectionChanged(): void {
		if (pageView || selecting) return;
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(readSelection, 60);
	}
	function readSelection(): void {
		if (pageView || selecting || !textRoot || editorTouched()) return;
		const selected = document.getSelection();
		if (!selected?.rangeCount || selected.isCollapsed) {
			// Moving focus to the comment input must not dismiss the card it just opened.
			if (!(document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest('[data-review-editor]'))) select();
			return;
		}
		const range = selected.getRangeAt(0);
		if (!textRoot.contains(range.startContainer) || !textRoot.contains(range.endContainer)) { select(); return; }
		const edge = (node: Node, offset: number) => node instanceof Text ? { text: node.data, offset } : undefined;
		const text = reviewText(quoteFromSelection(selectionInWholeWords(selected.toString(), edge(range.startContainer, range.startOffset), edge(range.endContainer, range.endOffset))), 4000);
		const locator = anchorKind === 'm' ? blockPath(textRoot, range.startContainer) : String(textOffset(textRoot, range));
		liveRange = text ? range.cloneRange() : undefined;
		scheduleGeometry();
		select(text ? { text, section: precedingArtifactHeading(textRoot, range.startContainer), ...(locator ? { anchor: `${anchorKind}:${locator}` } : {}) } : undefined);
	}
	function editorTouched(): boolean { return editor?.index !== undefined || intent !== undefined || note !== ''; }
	function select(selection?: ArtifactSelection): void {
		if (sending || editorTouched()) return;
		if (!selection) { if (editor) dismissEditor(false); return; }
		closePreview();
		if (!editor) editorOrigin = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : commentCounter;
		editor = { selection, inTray: false };
		if (sheet) trayOpen = false;
	}
	function edit(index: number): void {
		const comment = comments[index];
		if (!comment || editor || sending) return;
		editorOrigin = preview ? pinButton(preview.anchor) ?? undefined : document.activeElement instanceof HTMLElement ? document.activeElement : commentCounter;
		closePreview();
		intent = comment.intent;
		note = comment.note;
		editor = { selection: comment, index, inTray: !comment.anchor || !surfaceRects.has(comment.anchor) };
		if (editor.inTray) trayOpen = true;
		else if (sheet) trayOpen = false;
	}
	function dismissEditor(restoreFocus = true, clearSelection = true): void {
		editor = undefined;
		intent = undefined;
		note = '';
		liveRange = undefined;
		if (clearSelection) {
			if (pageView) frame?.contentWindow?.postMessage('kemiri:clear-artifact-selection', '*');
			else document.getSelection()?.removeAllRanges();
		}
		if (restoreFocus && !coarse) {
			suppressPinFocus = true;
			(editorOrigin?.isConnected ? editorOrigin : commentCounter)?.focus({ preventScroll: true });
			suppressPinFocus = false;
		}
		editorOrigin = undefined;
	}
	function saveComment(): void {
		if (!editor || (!intent && !note.trim()) || sending || (editor.index === undefined && comments.length >= 100)) return;
		const comment = { ...editor.selection, intent, note: reviewText(note, 4000) };
		const editingIndex = editor.index;
		comments = editingIndex === undefined ? [...comments, comment] : comments.map((saved, index) => index === editingIndex ? comment : saved);
		dismissEditor(); status = ''; problem = '';
	}
	function deleteComment(index: number): void {
		if (editor || sending) return;
		const anchor = comments[index]?.anchor;
		comments = comments.filter((_, at) => at !== index);
		if (preview && anchor) {
			closePreview();
			void tick().then(() => {
				if (!coarse) (pinButton(anchor) ?? commentCounter)?.focus({ preventScroll: true });
				else if (pinButton(anchor)) openPreview(anchor, true);
			});
		}
	}
	function pinButton(anchor: string): HTMLButtonElement | null | undefined {
		return layout?.querySelector<HTMLButtonElement>(`[data-review-pin="${anchor}"]`);
	}
	function openPreview(anchor: string, pinned = false): void {
		clearTimeout(previewTimer);
		if (editor || sending) return;
		preview = { anchor, pinned: pinned || (preview?.anchor === anchor && preview.pinned) };
		if (sheet) trayOpen = false;
	}
	function closePreview(restoreFocus = false): void {
		clearTimeout(previewTimer);
		if (!preview) return;
		const anchor = preview.anchor;
		preview = undefined;
		if (restoreFocus) {
			suppressPinFocus = true;
			pinButton(anchor)?.focus({ preventScroll: true });
			suppressPinFocus = false;
		}
	}
	function leavePreview(event: PointerEvent): void {
		if (event.pointerType !== 'mouse') return;
		clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			if (!preview?.pinned && !document.activeElement?.closest('[data-review-pin-group]')) closePreview();
		}, 240);
	}
	function togglePicking(): void {
		if (editor) return;
		closePreview();
		picking = !picking;
		frame?.contentWindow?.postMessage(picking ? 'kemiri:pick-artifact-block' : 'kemiri:cancel-artifact-pick', '*');
		if (picking) frame?.focus();
	}
	function formatted(): string { return formatArtifactReview({ title: artifactTitle(artifact), id: artifact.id, version: artifact.version ?? 1, name: artifact.name }, { comments, overall }); }
	function clear(): void { submission.accepted(); comments = []; overall = ''; dismissEditor(false); closePreview(); }
	const recipient = $derived(reviewThreadId(artifact.taskId, page.params.threadId));
	async function send(): Promise<void> {
		if (sending) return;
		sending = true; problem = ''; status = '';
		const text = formatted();
		try {
			await client.submit(artifact.projectId, text, { whenBusy: 'steer', taskId: artifact.taskId ?? undefined, threadId: recipient, keepDraft: true, requestId: submission.requestIdFor(text) });
			clear(); status = 'Sent. The review appears in chat.';
		} catch (error) { problem = `${error instanceof Error ? error.message : String(error)} Your comments are kept. Try Send again.`; }
		finally { sending = false; }
	}
	async function draft(): Promise<void> {
		problem = '';
		try {
			if (!backend) throw new Error('The backend is unavailable.');
			moveReviewToDraft(localStorage, window, draftKey(backend.id, artifact.projectId, recipient), formatted(), artifact.taskId ?? undefined);
			clear(); onclose?.();
			await goto(recipient ? threadHref(backend.id, artifact.projectId, recipient) : projectHref(backend.id, artifact.projectId));
			await tick();
			requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
		} catch (error) { problem = error instanceof Error ? error.message : String(error); }
	}
</script>

<svelte:document onselectionchange={selectionChanged} onpointerdowncapture={event => {
	selecting = !pageView && event.target instanceof Node && (textRoot?.contains(event.target) ?? false);
}} onpointerupcapture={() => { if (selecting) { selecting = false; selectionChanged(); } }} onpointercancelcapture={() => { selecting = false; }} />

{#snippet commentCard()}
	{#if editor}
		<ArtifactCommentCard selection={editor.selection} editing={editor.index !== undefined} {coarse} autofocus={!coarse} disabled={sending || (editor.index === undefined && comments.length >= 100)} bind:intent bind:note onsave={saveComment} oncancel={() => dismissEditor()} />
	{/if}
{/snippet}
{#snippet layerBox()}
	<!-- The rectangle is clipped to this layer, not trusted as host coordinates. -->
	{#if outline}<div class="target-outline" style:left={`${outline.x}px`} style:top={`${outline.y}px`} style:width={`${outline.width}px`} style:height={`${outline.height}px`}></div>{/if}
{/snippet}

{#if layer.width > 16 && layer.height > 16}
	{@const layerStyle = `left:${layer.x}px;top:${layer.y}px;width:${layer.width}px;height:${layer.height}px`}
	<div class="review-layer pin-layer" style={layerStyle} data-artifact-review>
		{#if previewPin}{@render layerBox()}{/if}
		{#each pins as pin (pin.anchor)}
			{@const expanded = previewPin?.anchor === pin.anchor}
			{@const count = pin.comments.length}
			<div role="group" data-review-pin-group onpointerenter={() => clearTimeout(previewTimer)} onpointerleave={leavePreview} onfocusout={event => {
				if (expanded && !preview?.pinned && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) closePreview();
			}}>
				<button type="button" class="review-pin" style:left={`${pin.x}px`} style:top={`${pin.y}px`} data-review-pin={pin.anchor}
					aria-label={`${count} ${count === 1 ? 'comment' : 'comments'} on ${comments[pin.comments[0]!]?.text.slice(0, 75) ?? 'this part'}`} aria-expanded={expanded} disabled={!!editor || sending}
					onpointerenter={event => { if (event.pointerType === 'mouse' && !coarse) openPreview(pin.anchor); }}
					onfocus={() => { if (!coarse && !suppressPinFocus) openPreview(pin.anchor); }}
					onclick={() => { if (expanded && (coarse || preview?.pinned)) closePreview(); else openPreview(pin.anchor, true); }}>
					<span><MessageSquareIcon size={12} aria-hidden="true" />{count}</span>
				</button>
				{#if expanded && previewPosition}
					<div class="review-popup preview-popup" style:left={`${previewPosition.left}px`} style:top={`${previewPosition.top}px`} bind:offsetWidth={previewWidth} bind:offsetHeight={previewHeight}>
						<ArtifactCommentPreview {comments} indexes={pin.comments} onedit={edit} ondelete={deleteComment} />
					</div>
				{/if}
			</div>
		{/each}
	</div>
	{#if editor && !editor.inTray}
		<div class="review-layer editor-layer" style={layerStyle} data-artifact-review>
			{@render layerBox()}
			<div class="review-popup editor-popup" data-review-editor style:left={`${cardPosition.left}px`} style:top={`${cardPosition.top}px`} bind:offsetWidth={cardWidth} bind:offsetHeight={cardHeight}>
				{@render commentCard()}
			</div>
		</div>
	{/if}
{/if}
<div class="review-controls" data-artifact-review>
	{#if pageView}<button type="button" aria-pressed={picking} disabled={sending || !!editor || !frame} onclick={togglePicking}>{picking ? 'Cancel picking' : 'Pick a block'}</button>{/if}
	{#if picking}<span class="pick-hint" role="status">Pick a block, or use ↓ ↑ then Enter. Escape cancels.</span>{/if}
	<button bind:this={commentCounter} type="button" aria-expanded={trayOpen} onclick={() => {
		closePreview();
		if (editor?.inTray && trayOpen) dismissEditor();
		else if (sheet && editor && !trayOpen) return;
		trayOpen = !trayOpen;
	}}>Comments · {comments.length}</button>
</div>
{#if trayOpen}
	<aside class="review-panel" aria-label="Artifact review" data-artifact-review>
		<header><div><strong>Your comments · {comments.length}</strong><p>Version {artifact.version ?? 1} · only on this device</p></div><Button variant="ghost" size="icon-sm" class="self-start" aria-label="Close comments" title="Close comments" onclick={() => { trayOpen = false; if (editor?.inTray) dismissEditor(); }}><XIcon /></Button></header>
		<div class="review-scroll">
			{#if editor?.inTray}<div class="tray-editor" data-review-editor>{@render commentCard()}</div>{/if}
			{#if !comments.length && !editor}<p class="hint">Select a sentence{pageView ? ', or pick any visible block' : ''}. Your comments gather here before you send.</p>{/if}
			<ol>{#each comments as comment, index}<li><strong>{index + 1}. {comment.intent ?? 'Note'}</strong><p class="location">{reviewLocation(comment)}</p><blockquote>{comment.text}</blockquote>{#if comment.note}<p class="comment-note">{comment.note}</p>{/if}<div class="buttons"><button type="button" disabled={sending || !!editor} onclick={() => edit(index)}>Edit<span class="sr-only"> comment {index + 1}</span></button><button type="button" disabled={sending || !!editor} onclick={() => deleteComment(index)}>Remove<span class="sr-only"> comment {index + 1}</span></button></div></li>{/each}</ol>
			<label>About the whole page (optional)<textarea bind:value={overall} disabled={sending} maxlength="4000" rows="2" placeholder="The bigger picture…"></textarea></label>
		</div>
		<footer>
			{#if !stored}<p role="alert">Storage unavailable. Keep this viewer open until you send.</p>{/if}
			{#if problem}<p role="alert">{problem}</p>{/if}
			<p role="status">{status}</p>
			<button type="button" class="primary" disabled={sending || !!editor || (!comments.length && !overall.trim())} onclick={() => void send()}>{sending ? 'Sending…' : `Send ${comments.length} comments`}</button>
			<button type="button" disabled={sending || !!editor || (!comments.length && !overall.trim())} onclick={() => void draft()}>Add to chat draft</button>
		</footer>
	</aside>
{/if}

<style>
	button { cursor:pointer; border:1px solid var(--chat-border); background:var(--chat-surface); color:var(--chat-fg); border-radius:8px; padding:8px 11px; font-size:12px; line-height:1.35; min-height:36px; }
	button:hover { background:var(--chat-surface-2); }
	button:focus-visible, textarea:focus-visible { outline:2px solid var(--accent-2); outline-offset:2px; }
	button:disabled { opacity:.5; cursor:default; }
	.primary, button[aria-pressed=true] { background:var(--chat-surface-2); color:var(--accent-2); border-color:var(--accent-2); font-weight:600; }
	.review-controls { position:absolute; z-index:5; bottom:12px; left:12px; display:flex; flex-wrap:wrap; gap:6px; max-width:calc(100% - 24px); padding:5px; background:var(--chat-bg); border:1px solid var(--chat-border); border-radius:12px; box-shadow:0 3px 16px #0002; }
	.pick-hint { font-size:12px; align-self:center; max-width:240px; color:var(--chat-fg-muted); }
	.review-panel { flex:0 0 320px; width:320px; max-width:100%; min-height:0; display:flex; flex-direction:column; background:var(--chat-bg); border-left:1px solid var(--chat-border); color:var(--chat-fg); font-size:13px; z-index:6; }
	header { display:flex; justify-content:space-between; gap:8px; padding:16px 14px 12px; border-bottom:1px solid var(--chat-border); }
	header p, .location { font-size:11px; color:var(--chat-fg-muted); margin:4px 0; }
	.review-scroll { min-height:0; flex:1; overflow:auto; padding:14px; overscroll-behavior:contain; }
	ol { list-style:none; margin:0; padding:0; }
	li, .tray-editor { padding:0 0 16px; margin-bottom:16px; border-bottom:1px solid var(--chat-border); }
	blockquote { max-height:112px; overflow:auto; border-left:2px solid var(--accent-2); margin:8px 0; padding-left:10px; color:var(--chat-fg-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
	.buttons { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
	label { display:block; font-size:12px; color:var(--chat-fg-muted); }
	textarea { display:block; width:100%; border:1px solid var(--chat-border); border-radius:8px; padding:10px; margin-top:6px; background:var(--chat-surface); color:var(--chat-fg); resize:vertical; font-size:14px; }
	.comment-note { white-space:pre-wrap; overflow-wrap:anywhere; }
	.hint { color:var(--chat-fg-muted); line-height:1.6; }
	footer { padding:12px 14px; border-top:1px solid var(--chat-border); display:grid; gap:8px; }
	footer p { font-size:12px; margin:0; }
	footer p:empty { display:none; }
	.review-layer { position:absolute; overflow:hidden; pointer-events:none; }
	.pin-layer { z-index:4; }
	.editor-layer { z-index:7; }
	.target-outline { position:absolute; outline:2px solid var(--tone-primary); outline-offset:-2px; background:color-mix(in srgb,var(--tone-primary) 10%,transparent); border-radius:5px; }
	button.review-pin { position:absolute; transform:translate(-50%,-50%); width:44px; height:44px; display:grid; place-items:center; padding:0; border:0; background:transparent; pointer-events:auto; }
	.review-pin span { display:flex; align-items:center; gap:3px; min-height:25px; padding:1px 6px; background:var(--tone-primary); border:2px solid var(--chat-bg); border-radius:14px 14px 14px 4px; color:var(--tone-primary-fg); font-weight:700; box-shadow:0 2px 7px #0004; }
	.review-pin:hover span, .review-pin[aria-expanded=true] span { box-shadow:0 0 0 3px color-mix(in srgb,var(--tone-primary) 32%,transparent), 0 2px 7px #0004; }
	.review-popup { position:absolute; pointer-events:auto; max-height:calc(100% - 16px); overflow:auto; overscroll-behavior:contain; border:1px solid var(--tone-border-strong); border-radius:14px; background:var(--chat-bg); color:var(--chat-fg); box-shadow:0 8px 24px #0004,0 2px 6px #0002; }
	.editor-popup { width:min(360px,calc(100% - 16px)); }
	.preview-popup { width:min(320px,calc(100% - 16px)); z-index:1; }
	@container artifact-review (max-width:639px) { .editor-popup, .preview-popup { width:calc(100% - 16px); } }
	@container artifact-review (max-width:639px) { .review-panel { position:absolute; bottom:0; left:0; width:100%; height: min(74dvh, 650px); border:1px solid var(--chat-border); border-radius:16px 16px 0 0; box-shadow:0 -6px 32px #0003; padding-bottom:env(safe-area-inset-bottom); } }
</style>
