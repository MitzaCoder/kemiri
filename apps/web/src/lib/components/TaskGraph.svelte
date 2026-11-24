<script lang="ts">
	import { taskCoordinatorInAllView, useCoordinatorTaskView, tasksInCoordinatorView, questionsInCoordinatorView } from '#lib/coordinator-task-view.js';
	import { coordinatorColor, coordinatorMark } from '#lib/coordinators.js';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CheckIcon from '@lucide/svelte/icons/check';
	import BanIcon from '@lucide/svelte/icons/ban';
	import { taskRowActivity } from '#lib/task-activity.js';
	import { taskPartProgress } from '#lib/task-parts.js';
	import { activityMinute } from '#lib/activity-minute.js';
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import type { ThreadSummary, WorkerSummary } from '@kemiri/protocol';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { buildTaskGraph, graphLabel, graphNeighborhood, visibleGraphEdges, placeGraphCrewOnRims, type GraphPosition, type TaskGraph } from '#lib/task-graph.js';
	import { settledGraphPositions } from '#lib/task-graph-layout.js';
	import { graphCounts, graphCaptionScale, graphEdgeSegment } from '#lib/task-graph-presentation.js';
	import { graphFoldGroups, liveTaskGraph, revealGraphTask, graphFoldExpansion, graphFoldPosition, renderedGraphNodes, loadGraphMode, saveGraphMode, type GraphMode, type GraphFoldKind } from '#lib/task-graph-live.js';
	import { fitGraphCamera, loadGraphCamera, saveGraphCamera, placeGraphLabels, type GraphCamera } from '#lib/task-graph-camera.js';

	let { board, scope, backendId, projectId, workers = [], threads = [], taskHref, selectedTaskId = null, viewSwitch }: {
		board:ProjectBoard | undefined; scope:string; backendId:string; projectId:string; workers?:readonly WorkerSummary[]; threads?:readonly ThreadSummary[];
		selectedTaskId?:string | null; taskHref:(id:string)=>string; viewSwitch:Snippet;
	} = $props();
	import GraphMascotDefs from './graph/GraphMascotDefs.svelte';
	import GraphMascot from './graph/GraphMascot.svelte';
	import GraphCrew from './graph/GraphCrew.svelte';
	import GraphReport from './graph/GraphReport.svelte';
	import GraphPeekHost from './graph/GraphPeekHost.svelte';
	import { graphPeekWorkerFolds } from '#lib/graph-peek.js';
	import { workerMotionBudget } from '#lib/worker-motion.js';
	import { crewHandoffMs, crewFinishMs, graphCrewMotion, graphCrewInView, departingGraphCrew, interpolateCrewHandoff, graphReportCues, type GraphReportCue } from '#lib/graph-worker-motion.js';
	import type { GraphNode } from '#lib/task-graph.js';
	const componentId = $props.id();
	const gradientPrefix = 'graph-mascot-' + componentId;
	let departures = $state(new Map<string, GraphNode>());
	let showClosed = $state(false);
	let showResting = $state(false), allLinks = $state(false), showLegend = $state(false);
	let viewOpen = $state(false), restingOpen = $state(false);
	const getTaskView = useCoordinatorTaskView();
	const coordinatorView = $derived(getTaskView?.());
	const scopedTasks = $derived(tasksInCoordinatorView(board?.tasks ?? [], coordinatorView));
	const scopedQuestions = $derived(questionsInCoordinatorView(board?.board?.questions ?? [], coordinatorView));
	const source = $derived(buildTaskGraph(scopedTasks, scopedQuestions, workers.filter(worker => !coordinatorView || !worker.taskId || scopedTasks.some(task => task.id === worker.taskId)), threads, showClosed, showResting));
	let graph = $state<TaskGraph>({nodes:[],edges:[],resting:[]});
	let mode = $state<GraphMode>('live');
	let expandedFolds = $state(new Set<GraphFoldKind>());
	let foldPosition = $state<GraphPosition | null>(null);
	const folds = $derived(graphFoldGroups(graph,board?.board?.questions ?? []));
	const shownGraph = $derived(liveTaskGraph(graph,folds,mode,expandedFolds,showResting));
	let positions = $state(new Map<string,GraphPosition>());
	let camera = $state<GraphCamera>({x:0,y:0,zoom:1});
	let svg:SVGSVGElement | null = $state(null);
	let stage:HTMLDivElement | null = $state(null);
	let peekHost:GraphPeekHost | undefined = $state();
	let peekTaskId=$state<string | null>(null), linkedTaskId=$state<string | null>(null);
	let workerToReveal=$state<string | null>(null);
	let width=$state(0), height=$state(0), reduced=$state(false), mounted=$state(false);
	const renderedNodes = $derived(renderedGraphNodes(shownGraph, [...departures.values()]));
	const crewStates = $derived(new Map(renderedNodes.filter(node => node.kind !== 'task').map(node => [node.id, departures.has(node.id) ? 'done' as const : graphCrewMotion(node, board?.tasks ?? [], board?.board?.questions ?? [])])));
	const motionBudget = $derived(workerMotionBudget(renderedNodes.filter(node => node.kind !== 'task').map(node => ({ id: node.id, state: crewStates.get(node.id)!, inView: graphCrewInView(positions.get(node.id), camera, width, height) })), camera.zoom, reduced));
	let framed=false, frame=0;
	let enterDuration=$state(0);
	function arrive(_node:Element,options:{duration:number}) {return {duration:options.duration,css:(t:number)=>`opacity:${t}`};}
	const departureTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let destination=new Map<string,GraphPosition>();
	function storage():Storage | undefined {try{return localStorage;}catch{return undefined;}}
	let focused=$state<string | null>(null);
	const neighborhoodTask=$derived(peekTaskId ? `task:${peekTaskId}` : focused ?? (linkedTaskId ? `task:${linkedTaskId}` : selectedTaskId ? `task:${selectedTaskId}` : null));
	const edges=$derived(visibleGraphEdges(shownGraph,neighborhoodTask,allLinks));
	const counts=$derived(graphCounts(source));
	function idleAge(worker:WorkerSummary, now:number):string {
		const minutes=Math.max(0, Math.floor((now-Date.parse(worker.updatedAt))/60_000));
		return !Number.isFinite(minutes) ? '' : minutes<60 ? `${minutes} min` : minutes<1440 ? `${Math.floor(minutes/60)} h` : `${Math.floor(minutes/1440)} d`;
	}
	const highlighted=$derived(graphNeighborhood(shownGraph,neighborhoodTask));
	// Reserve every All-view title, so even captions stay fixed when a chip opens.
	const labels=$derived([...placeGraphLabels(graph,positions,camera,width,height)].filter(([id])=>shownGraph.nodes.some(node=>node.id===id)));
	const viewBox=$derived(`${camera.x-width/camera.zoom/2} ${camera.y-height/camera.zoom/2} ${Math.max(1,width)/camera.zoom} ${Math.max(1,height)/camera.zoom}`);
	let reportCues=$state<GraphReportCue[]>([]);
	const seenReports=new Map<string,string | null>();
	const reportTimers=new Set<ReturnType<typeof setTimeout>>();
	let saveTimer:ReturnType<typeof setTimeout> | undefined;
	let drag:{id:string | null;x:number;y:number;moved:boolean} | null=null;
	const pointers=new Map<number,{x:number;y:number}>();
	let pinchDistance=0;

	function remember() {
		clearTimeout(saveTimer);
		saveTimer=setTimeout(()=>{saveGraphCamera(scope,camera,storage());saveTimer=undefined;},180);
	}
	function framingPositions() {
		return new Map([...positions,...(foldPosition ? [['folds',foldPosition] as const] : [])]);
	}
	function changeMode(next:GraphMode) { mode=next;saveGraphMode(scope,next,storage()); }
	function toggleFold(kind:GraphFoldKind) {
		if(expandedFolds.has(kind)) expandedFolds=graphFoldExpansion(graph,folds,expandedFolds,kind);
		else expandedFolds=graphFoldExpansion(graph,folds,new Set([...expandedFolds,kind]));
	}
	function fit(rememberChoice=true) {
		camera=fitGraphCamera(framingPositions(),width,height);
		if(rememberChoice) remember();
	}
	function frameFirstGraph() {
		if(framed || !width || !height || !positions.size) return;
		camera=loadGraphCamera(scope,storage()) ?? fitGraphCamera(framingPositions(),width,height);
		framed=true;
	}
	function publish(next:TaskGraph) {
		cancelAnimationFrame(frame);
		const from = positions;
		const target = settledGraphPositions(next, from, width / Math.max(1, height));
		const leaving = reduced || camera.zoom < .5 ? [] : departingGraphCrew(graph, next, workers, threads)
			.filter(node => graphCrewInView(from.get(node.id), camera, width, height));
		for (const node of leaving) {
			departures.set(node.id, node);
			clearTimeout(departureTimers.get(node.id));
			departureTimers.set(node.id, setTimeout(() => {
				departures.delete(node.id); departures = new Map(departures);
				positions = new Map([...positions].filter(([id]) => id !== node.id || source.nodes.some(node => node.id === id)));
				if (!source.nodes.some(next => next.id === node.id)) destination.delete(node.id);
				departureTimers.delete(node.id);
			}, node.status === 'stopped' ? 400 : crewFinishMs));
		}
		for (const node of next.nodes) {
			departures.delete(node.id); clearTimeout(departureTimers.get(node.id)); departureTimers.delete(node.id);
		}
		departures = reduced || camera.zoom < .5 ? new Map() : new Map(departures);
		const departingPositions = [...from].filter(([id]) => departures.has(id));
		destination = new Map([...departingPositions, ...target]);
		positions = destination;
		if(graphFoldGroups(next,board?.board?.questions ?? []).length) foldPosition=graphFoldPosition(target,foldPosition);
		frameFirstGraph();
		enterDuration = reduced || camera.zoom < .5 || from.size === 0 ? 0 : 300;
		graph = next;
		if (reduced || camera.zoom < .5 || from.size === 0) return;
		const traveling = [...target].some(([id, position]) => { const old = from.get(id); return old && Math.hypot(old.x - position.x, old.y - position.y) > .1; });
		if (!traveling) return;
		const start = performance.now();
		const animate = (now:number) => {
			const progress = Math.min(1, (now - start) / crewHandoffMs);
			positions = new Map([...departingPositions, ...interpolateCrewHandoff(from, target, progress)]);
			if (progress < 1) frame = requestAnimationFrame(animate);
		};
		positions = new Map([...departingPositions, ...interpolateCrewHandoff(from, target, 0)]);
		frame = requestAnimationFrame(animate);
	}
	// Yield the first frame to the view switch. Solve only once, before publishing SVG, not on every paint.
	$effect(()=>{
		const next=source;
		if(!mounted || !width || !height) return;
		const timer=setTimeout(()=>untrack(()=>publish(next)),untrack(()=>positions.size ? 0 : 160));
		return ()=>clearTimeout(timer);
	});
	$effect(()=>{
		const groups=folds, selected=selectedTaskId, fullGraph=graph;
		untrack(()=>{expandedFolds=graphFoldExpansion(fullGraph,groups,revealGraphTask(groups,expandedFolds,selected));});
	});
	$effect(() => {
		const cues = graphReportCues(seenReports, workers, shownGraph);
		untrack(() => {
			for (const cue of cues) if (!reduced && camera.zoom >= .5
				&& graphCrewInView(positions.get(cue.workerId), camera, width, height)
				&& graphCrewInView(positions.get(cue.taskId), camera, width, height)) {
				reportCues = [...reportCues, cue];
				const timer = setTimeout(() => { reportCues = reportCues.filter(report => report.id !== cue.id); reportTimers.delete(timer); }, 1200);
				reportTimers.add(timer);
			}
		});
		for (const worker of workers) seenReports.set(worker.id, worker.lastReport);
	});
	onMount(()=>{
		mode=loadGraphMode(scope,storage());
		const media=matchMedia('(prefers-reduced-motion: reduce)');reduced=media.matches;
		const motionChange=()=>{reduced=media.matches;if(reduced) {cancelAnimationFrame(frame);stopTransientMotion();}};
		media.addEventListener('change',motionChange);
		const observer=new ResizeObserver(([entry])=>{if(!entry)return;width=entry.contentRect.width;height=entry.contentRect.height;frameFirstGraph();});
		if(svg) observer.observe(svg);
		mounted=true;
		return ()=>{
			observer.disconnect();media.removeEventListener('change',motionChange);cancelAnimationFrame(frame);for(const timer of departureTimers.values())clearTimeout(timer);
			if(saveTimer) {clearTimeout(saveTimer);saveGraphCamera(scope,camera,storage());}
			for(const timer of reportTimers)clearTimeout(timer);
		};
	});
	function stopTransientMotion() {
		cancelAnimationFrame(frame);
		positions = new Map([...destination].filter(([id]) => !departures.has(id)));
		destination = positions;
		departures = new Map(); reportCues = [];
		for (const timer of departureTimers.values()) clearTimeout(timer);
		departureTimers.clear();
	}
	$effect(() => { if (reduced || camera.zoom < .5) untrack(stopTransientMotion); });
	function changeZoom(factor:number) {camera={...camera,zoom:Math.max(.08,Math.min(4,camera.zoom*factor))};remember();}
	function pointerDown(event:PointerEvent) {
		if(event.button!==0)return;
		pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
		if(pointers.size===2) {const [a,b]=[...pointers.values()];pinchDistance=Math.hypot(a!.x-b!.x,a!.y-b!.y);drag=null;return;}
		const id=(event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;
		drag={id,x:event.clientX,y:event.clientY,moved:false};
	}
	function pointerMove(event:PointerEvent) {
		if(!pointers.has(event.pointerId))return;
		pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
		if(pointers.size===2) {const [a,b]=[...pointers.values()];const distance=Math.hypot(a!.x-b!.x,a!.y-b!.y);if(pinchDistance)changeZoom(distance/pinchDistance);pinchDistance=distance;return;}
		if(!drag)return;
		const dx=(event.clientX-drag.x)/camera.zoom,dy=(event.clientY-drag.y)/camera.zoom;
		if(!drag.moved&&Math.hypot(dx,dy)*camera.zoom<4)return;
		if(!drag.moved) {svg?.setPointerCapture(event.pointerId);cancelAnimationFrame(frame);focused=null;}
		drag.moved=true;
		if(drag.id) {for(const [id,p] of positions)if(id===drag.id||p.parentId===drag.id) {p.x+=dx;p.y+=dy;p.anchorX=p.x;p.anchorY=p.y;}placeGraphCrewOnRims(graph,positions);positions=new Map(positions);destination=positions;}
		else {camera={...camera,x:camera.x-dx,y:camera.y-dy};remember();}
		drag.x=event.clientX;drag.y=event.clientY;
	}
	function pointerUp(event:PointerEvent) {pointers.delete(event.pointerId);pinchDistance=0;if(drag?.moved)setTimeout(()=>{drag=null;},0);else drag=null;}
	function wheel(event:WheelEvent) {event.preventDefault();changeZoom(Math.exp(-event.deltaY*.0015));}
	/** Reveal a folded worker without changing the launch context of its transcript. */
	function openWorkerPeek(workerId:string) {
		if(source.resting.some(worker=>worker.id===workerId)) showResting=true;
		expandedFolds=graphPeekWorkerFolds(graph,folds,expandedFolds,workerId);
		workerToReveal=workerId;
	}
	$effect(()=>{
		if(!workerToReveal) return;
		const id=`worker:${workerToReveal}`, position=positions.get(id);
		if(!position || !shownGraph.nodes.some(node=>node.id===id)) return;
		untrack(()=>{
			camera={x:position.x,y:position.y,zoom:Math.max(.8,camera.zoom)};
			focused=id; workerToReveal=null; remember();
			void tick().then(()=>peekHost?.openWorker(id.slice('worker:'.length)));
		});
	});
	function edgePath(from:string,to:string):string {
		const a=positions.get(from),b=positions.get(to);if(!a||!b)return '';
		const segment=graphEdgeSegment(a,b);
		return `M ${segment.x1} ${segment.y1} L ${segment.x2} ${segment.y2}`;
	}
</script>

<svelte:window onkeydown={event=>{if(event.key==='Escape'){viewOpen=false;restingOpen=false;}}}/>

<section data-no-task-preview class="task-graph" class:motion-still={reduced||camera.zoom<.5} aria-label="Task graph">
	<div class="graph-toolbar">
		{@render viewSwitch()}
		<span class="graph-counts">{counts.open} open · {counts.working} working · {counts.attention} need attention</span>
		<div class="graph-mode" role="group" aria-label="Task visibility">
			<button aria-pressed={mode==='live'} onclick={()=>changeMode('live')}>Live</button><button aria-pressed={mode==='all'} onclick={()=>changeMode('all')}>All</button>
		</div>
		<div class="view-menu">
			<button class="menu-toggle" aria-expanded={viewOpen} onclick={()=>{viewOpen=!viewOpen;restingOpen=false;}}>View ▾</button>
			{#if viewOpen}<div class="menu-panel" role="group" aria-label="Graph view options">
				<label><input type="checkbox" bind:checked={showClosed}/> Closed tasks</label>
				<label><input type="checkbox" bind:checked={showResting}/> Resting workers on the graph</label>
				<label><input type="checkbox" bind:checked={allLinks}/> All links</label>
				<label><input type="checkbox" bind:checked={showLegend}/> Legend</label>
			</div>{/if}
		</div>
	</div>
	<div class="graph-stage" bind:this={stage}>
		{#if shownGraph.resting.length}<div class="resting-workers">
			<button class="resting-chip" aria-expanded={restingOpen} onclick={()=>{restingOpen=!restingOpen;viewOpen=false;}}>Resting · {shownGraph.resting.length}</button>
			{#if restingOpen}<div class="resting-panel" role="region" aria-label="Resting workers">
				<strong>Resting workers</strong>
				<ul>{#each shownGraph.resting as worker (worker.id)}
					{@const task=board?.tasks.find(task=>task.id===worker.taskId || (!worker.taskId && task.workerIds.includes(worker.id)))}
					<li><button type="button" aria-haspopup="dialog" data-node={`worker:${worker.id}`} data-resting-worker class:failed={worker.status==='failed'}><svg width="24" height="24" viewBox="0 0 24 24" class="resting-mascot" aria-hidden="true"><GraphMascot state={worker.status==='failed'?'failed':'sleeping'} size={24} still reducedMotion {gradientPrefix}/></svg><b>{worker.id}</b><span>{task ? `${task.id} · ${task.title}` : worker.taskId ? `${worker.taskId} · task unavailable` : 'No task'}</span><small>{worker.status==='failed'?'Failed':'Idle'} · {idleAge(worker,$activityMinute)}</small></button></li>
				{/each}</ul>
			</div>{/if}
		</div>{/if}
		<div class="graph-controls"><button onclick={()=>changeZoom(.8)} aria-label="Zoom out">−</button><button onclick={()=>changeZoom(1.25)} aria-label="Zoom in">+</button><button onclick={()=>fit()}>Fit</button></div>
		{#if showLegend}<div class="legend" aria-label="Relationship legend"><span>— Subtask</span><span>┄ Blocked by →</span><span>·· Found while</span><span>╌ Related</span></div>{/if}
		<!-- Pointer gestures only move the camera or nodes; tasks remain ordinary keyboard links. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<svg bind:this={svg} class="graph-canvas" {viewBox} role="group" aria-label="Interactive task graph. Drag to pan; pinch or use zoom buttons. Tab to nodes, Enter opens a task or worker preview. List has all task details." onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp} onwheel={wheel}>
			<GraphMascotDefs {gradientPrefix}/>
			<defs><marker id="task-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker><radialGradient id="task-graph-shine" cx="30%" cy="20%"><stop offset="0%" stop-color="white" stop-opacity=".45"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs>
			{#each shownGraph.nodes.filter(n=>n.kind==='task'&&n.radius>35&&!n.parent) as node (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}<path class="cluster" class:dimmed={!highlighted.has(node.id)} transform="translate({p.x} {p.y}) scale(1.15)" d="M -190 -35 C -220 -190 -45 -215 30 -190 C 210 -225 245 -40 185 60 C 190 215 -20 230 -90 165 C -210 165 -245 60 -190 -35"/>{/if}
			{/each}
			{#each edges as edge (edge.id)}
				<path class="edge {edge.kind}" class:edge-focused={neighborhoodTask===edge.from||neighborhoodTask===edge.to} class:dimmed={!highlighted.has(edge.from)||!highlighted.has(edge.to)} d={edgePath(edge.from,edge.to)} marker-end={edge.kind==='blockedBy'?'url(#task-graph-arrow)':undefined}/>
			{/each}
			{#each renderedNodes as node (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}
					{@const coordinator = node.task ? taskCoordinatorInAllView(node.task, coordinatorView) : undefined}
					<g transform="translate({p.x} {p.y})" class="node-position" class:dimmed={!highlighted.has(node.id)&&!departures.has(node.id)} in:arrive|global={{duration:enterDuration}} out:fade|global={{duration:reduced||camera.zoom<.5||departures.has(node.id)?0:280}}>
						<a href={node.kind==='task'?taskHref(node.task!.id):undefined} role={node.kind==='task'?undefined:'button'} aria-haspopup={node.kind==='task'?undefined:'dialog'} tabindex="0" aria-label={`${graphLabel(node)}${coordinator ? ` · Coordinator: ${coordinator.title}` : ''}`} data-node={node.id} onmouseenter={()=>focused=node.id} onmouseleave={()=>focused=null} onfocus={()=>focused=node.id} onblur={()=>focused=null} onclick={(event)=>{if(drag?.moved)event.preventDefault();}}>
							<g class="node {node.kind} status-{node.status}" class:closed={node.kind==='task'&&(node.status==='done'||node.status==='dropped')}>
								{#if node.kind==='task'&&node.attention}<circle class="attention-halo" r={node.radius+12}/>{/if}
								{#if node.kind==='task'}
									<circle class="task-body" r={node.radius}/><circle r={node.radius-2} fill="url(#task-graph-shine)"/>
									{@const parts=taskPartProgress(node.task!)}
									{#if parts}
										{@const total=parts.segments.reduce((sum,segment)=>sum+segment.count,0)}
										<circle class="progress-track" r={node.radius+5}/>
										{#each parts.segments as segment,i}<circle class="progress part-{segment.tone}" r={node.radius+5} pathLength="100" stroke-dasharray="{Math.max(.3,segment.count/total*100-1.5)} 100" stroke-dashoffset={-parts.segments.slice(0,i).reduce((sum,part)=>sum+part.count,0)/total*100} transform="rotate(-90)"/>{/each}
									{:else if node.task?.subtaskCount?.total}<circle class="progress-track" r={node.radius+5}/><circle class="progress part-done" r={node.radius+5} pathLength="100" stroke-dasharray="{node.task.subtaskCount.done/node.task.subtaskCount.total*100} 100" transform="rotate(-90)"/>{/if}
									{@const activity=taskRowActivity(node.task!,board?.activityEnabled===true,board?.tasks??[])}
									{@const kind=node.task?.state?.kind ?? ({failure:'failed',question:'answer_needed',review:'review',working:'working',deploy:'working',waiting:'waiting_outside',blocked:'blocked_by_task',done:'done',dropped:'dropped'} as Record<string,string>)[activity?.kind??''] ?? node.status}
									{@const StateIcon=({failed:TriangleAlertIcon,blocked:TriangleAlertIcon,answer_needed:CircleHelpIcon,steps_needed:ListChecksIcon,clarifying:CircleHelpIcon,review:EyeIcon,paused:PauseIcon,blocked_by_task:LockIcon,waiting_outside:ClockIcon,waiting:ClockIcon,todo:CircleIcon,done:CheckIcon,dropped:BanIcon} as Record<string,typeof CircleIcon>)[kind]}
									{#if StateIcon}<StateIcon x={-10} y={-10} width={20} height={20} class="state-glyph" aria-hidden="true"/>{:else}<circle class="working-dot" r="6"/>{/if}
									{#if coordinator}
										<g aria-hidden="true" transform="translate({node.radius * .46} {-node.radius * .56})" style:--coordinator-color={coordinatorColor(coordinator)}>
											<circle class="graph-coordinator-mark" r="6"/>
											<text class="graph-coordinator-initial" y="3">{coordinatorMark(coordinator.title)}</text>
										</g>
									{/if}
									<title>{activity?.text ?? graphLabel(node)}{coordinator ? ` · Coordinator: ${coordinator.title}` : ''}</title>
								{:else}
									<GraphCrew {node} state={crewStates.get(node.id)!} allowance={motionBudget.get(node.id)!} zoom={camera.zoom} {reduced} departing={departures.has(node.id)} {gradientPrefix}/>
								{/if}
							</g>
						</a>
					</g>
				{/if}
			{/each}
			{#if !reduced && camera.zoom >= .5}{#each reportCues as cue (cue.id)}
				{@const from=positions.get(cue.workerId)}{@const to=positions.get(cue.taskId)}
				{#if from&&to&&shownGraph.nodes.some(node=>node.id===cue.workerId)&&shownGraph.nodes.some(node=>node.id===cue.taskId)}<GraphReport {from} {to}/>{/if}
			{/each}{/if}
			{#each shownGraph.nodes.filter(n=>n.kind==='task') as node (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}<g class="task-caption" class:dimmed={!highlighted.has(node.id)} transform="translate({p.x} {p.y+node.radius+12*graphCaptionScale(camera.zoom)}) scale({graphCaptionScale(camera.zoom)})">
					<rect class="graph-task-id-chip" x={-(node.task!.id.length*7+14)/2} y="-8" width={node.task!.id.length*7+14} height="18" rx="6"/><text class="task-id" y="5">{node.task!.id}</text>
				</g>{/if}
			{/each}
			{#each labels as [id,label] (id)}<text class="graph-label" class:dimmed={!highlighted.has(id)} x={label.x+label.width/2} y={label.y+12*label.scale} font-size={12*label.scale} stroke-width={4*label.scale}>{#each label.lines as line,i}<tspan x={label.x+label.width/2} dy={i?16*label.scale:0}>{line}</tspan>{/each}</text>{/each}
			{#if mode==='live' && folds.length && foldPosition}
				{@const chipWidth=Math.min(folds.length*170,width-24)}
				<foreignObject x={-chipWidth/2} y="-22" width={chipWidth} height="44" transform="translate({foldPosition.x} {foldPosition.y}) scale({1/camera.zoom})">
					<div class="fold-chips">{#each folds as fold (fold.kind)}<button class="fold-chip" aria-expanded={expandedFolds.has(fold.kind)} aria-label={`${fold.label} · ${fold.taskIds.length}`} onpointerdown={event=>event.stopPropagation()} onclick={()=>toggleFold(fold.kind)}>{fold.label} · {fold.taskIds.length} <span aria-hidden="true">{expandedFolds.has(fold.kind)?'▾':'▸'}</span></button>{/each}</div>
				</foreignObject>
			{/if}
		</svg>
		{#if board?.loaded&&graph.nodes.length===0}<p class="empty-graph">No active tasks. Show closed or use List.</p>{/if}
		<GraphPeekHost bind:this={peekHost} {stage} {board} {workers} {threads} {backendId} {projectId} {taskHref} {viewBox} {positions}
			visibleNodeIds={new Set(shownGraph.nodes.map(node=>node.id))}
			onTaskChange={taskId=>peekTaskId=taskId} onShowLinked={taskId=>linkedTaskId=taskId} onWorker={openWorkerPeek} />
	</div>
</section>

<style>
	.task-graph{--graph-todo:var(--chat-fg-subtle);--graph-working:var(--task-status-working);--graph-blocked:var(--tone-danger);--graph-review:var(--task-status-review);--graph-waiting:var(--chat-fg-subtle);display:flex;flex-direction:column;min-height:0;height:100%;color:var(--chat-fg);background:var(--chat-bg);overflow:hidden}
	.graph-mode{display:flex;border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-surface);padding:2px;flex-shrink:0}.graph-mode button{padding:6px 10px;border-radius:12px;cursor:pointer;min-height:32px}.graph-mode button[aria-pressed=true]{background:var(--chat-surface-2);color:var(--chat-fg);box-shadow:0 1px 3px color-mix(in srgb,var(--chat-fg) 12%,transparent);font-weight:650}.fold-chips{display:flex;gap:8px;padding:2px}.fold-chip{flex:1;min-width:0;min-height:40px;border:1px solid var(--chat-border);border-radius:20px;background:var(--chat-surface);color:var(--chat-fg);font-size:14px;cursor:pointer}.fold-chip:hover,.fold-chip[aria-expanded=true]{background:var(--chat-surface-2)}.fold-chip:focus-visible,.graph-mode button:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
	.graph-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 16px;border-bottom:1px solid var(--chat-border);font-size:12px;z-index:4}.graph-counts{color:var(--chat-fg-muted);font-size:11px}.view-menu{position:relative;margin-left:auto}.menu-toggle,.resting-chip{border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-surface);padding:7px 12px;font-size:12px;cursor:pointer}.menu-panel{position:absolute;right:0;top:calc(100% + 8px);width:260px;max-width:calc(100vw - 30px);background:var(--chat-surface);border:1px solid var(--chat-border);border-radius:12px;box-shadow:var(--tone-shadow);padding:6px;z-index:5}.menu-panel label{display:flex;align-items:center;gap:8px;padding:10px 8px;min-height:40px;cursor:pointer}input{accent-color:var(--graph-working)}
	.resting-workers{position:absolute;left:12px;bottom:12px;z-index:3}.resting-panel{position:absolute;bottom:calc(100% + 8px);left:0;width:310px;max-width:calc(100vw - 32px);max-height:55vh;overflow:auto;padding:12px;border:1px solid var(--chat-border);border-radius:14px;background:var(--chat-surface);box-shadow:var(--tone-shadow);font-size:12px}.resting-panel ul{list-style:none;padding:0;margin:6px 0 0}.resting-mascot{position:absolute;left:8px;top:8px}.resting-panel li>button{width:100%;text-align:left;cursor:pointer;position:relative;padding-left:40px!important;display:flex;flex-direction:column;gap:3px;padding:8px;border-radius:8px}.resting-panel li>button:hover{background:var(--chat-surface-2)}.resting-panel span,.resting-panel small{color:var(--chat-fg-muted)}.resting-panel .failed small{color:var(--graph-blocked)}
	.graph-controls{position:absolute;bottom:12px;right:12px;display:flex;gap:4px;z-index:2}.graph-controls button{height:34px;min-width:34px;border:1px solid var(--chat-border);border-radius:10px;background:var(--chat-surface);font-size:14px;padding:0 8px;cursor:pointer}.graph-controls button:hover{background:var(--chat-surface-2)}
	.graph-stage{position:relative;flex:1;min-height:220px;overflow:hidden;animation:arrive .5s ease-out}.graph-canvas{width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;background:radial-gradient(ellipse at 40% 35%,color-mix(in srgb,var(--graph-working) 5%,transparent),transparent 65%)}.graph-canvas:active{cursor:grabbing}.dimmed{opacity:.15;transition:opacity .2s}.node-position{transition:opacity .2s}.node{--node-color:var(--graph-todo)}.status-working,.status-clarifying,.status-in_progress,.status-running{--node-color:var(--graph-working)}.status-blocked,.status-failed{--node-color:var(--graph-blocked)}.status-answer_needed,.status-steps_needed,.status-review{--node-color:var(--graph-review)}.status-paused{--node-color:var(--chat-fg-subtle)}.status-blocked_by_task,.status-waiting_outside,.status-waiting{--node-color:var(--chat-fg-subtle)}.status-done{--node-color:var(--tone-success)}.closed{opacity:.35}
	.cluster{fill:color-mix(in srgb,var(--chat-fg-subtle) 5%,var(--chat-bg));stroke:color-mix(in srgb,var(--chat-fg-subtle) 14%,transparent);stroke-width:1}
	.edge{fill:none;stroke:var(--chat-fg-subtle);stroke-width:1.6;opacity:.45}.edge.parent{stroke:var(--graph-working);stroke-width:2}.edge.foundWhile{stroke:var(--graph-waiting);stroke-dasharray:2 6;stroke-linecap:round}.edge.blockedBy{stroke:var(--chat-fg-subtle);stroke-width:1.8;stroke-dasharray:5 5}.edge.blockedBy.edge-focused{stroke:var(--graph-blocked);opacity:.85;animation:blocked-dashes 2.4s linear infinite}.motion-still .edge.blockedBy.edge-focused{animation:none}.edge.related{stroke:var(--graph-review);stroke-dasharray:8 6}.edge.dimmed{opacity:.08}
	.task-body{fill:color-mix(in srgb,var(--node-color) 23%,var(--chat-bg));stroke:var(--node-color);stroke-width:2}.task-id{font-size:12px;font-weight:600;font-family:var(--font-mono);fill:light-dark(#4338ca,#c7d2fe);text-anchor:middle;pointer-events:none}.graph-task-id-chip{fill:color-mix(in srgb,var(--accent-2) 12%,var(--chat-bg));pointer-events:none}:global([data-theme="neutral"]) .task-id{fill:var(--chat-fg)}.graph-label{fill:var(--chat-fg);stroke:var(--chat-bg);paint-order:stroke;text-anchor:middle;font-weight:550;pointer-events:none;stroke-linejoin:round}.progress-track{fill:none;stroke:var(--chat-border);stroke-width:3}.progress{fill:none;stroke:var(--graph-working);stroke-width:3;stroke-linecap:round}.attention-halo{fill:color-mix(in srgb,var(--node-color) 4%,transparent);stroke:var(--node-color);stroke-width:2;opacity:.4;}
	a[role=button]:focus-visible{outline:2px solid var(--accent-2);outline-offset:3px}.resting-panel li>button:focus-visible{outline:2px solid var(--accent-2)}
	.graph-coordinator-mark{fill:color-mix(in srgb,var(--coordinator-color) 22%,var(--chat-bg))}.graph-coordinator-initial{fill:color-mix(in srgb,var(--coordinator-color) 62%,var(--chat-fg));font-size:8px;font-weight:750;text-anchor:middle}
	a{cursor:pointer;outline:none}a:focus-visible .task-body{stroke:var(--chat-fg);stroke-width:4}a:hover .task-body{stroke-width:3}

	.empty-graph{position:absolute;top:45%;width:100%;text-align:center;font-size:13px;color:var(--chat-fg-muted);pointer-events:none}
	.legend{position:absolute;top:12px;left:12px;display:flex;flex-wrap:wrap;gap:12px;max-width:calc(100% - 24px);border:1px solid var(--chat-border);border-radius:10px;padding:8px 12px;background:var(--chat-surface);font-size:11px;color:var(--chat-fg-muted);z-index:2}
	.part-done{stroke:var(--task-status-done)}.part-working{stroke:var(--task-status-working)}.part-needs-you{stroke:var(--task-status-review)}.part-other{stroke:var(--chat-fg-subtle)}:global(.state-glyph){color:var(--node-color)}.working-dot{fill:var(--node-color);animation:working-pulse 3s ease-in-out infinite}.task-caption{pointer-events:none}@keyframes working-pulse{50%{opacity:.4}}
	@keyframes arrive{from{opacity:0}to{opacity:1}}@keyframes blocked-dashes{to{stroke-dashoffset:-20}}
	@media(max-width:640px){.graph-toolbar{gap:8px;padding:8px 10px}.graph-counts{order:3;flex-basis:100%;font-size:11px}.graph-controls button,.menu-toggle,.resting-chip{min-height:40px;min-width:40px}.graph-controls{gap:3px}}
	@media(prefers-reduced-motion:reduce){.graph-stage,.node-position,.attention-halo,.working-dot,.edge.blockedBy.edge-focused{animation:none}.dimmed,.node-position{transition:none}}
</style>
