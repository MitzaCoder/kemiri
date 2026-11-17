<script lang="ts">
	import CircleIcon from '@lucide/svelte/icons/circle';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CheckIcon from '@lucide/svelte/icons/check';
	import BanIcon from '@lucide/svelte/icons/ban';
	import { taskRowActivity } from '#lib/task-activity.js';
	import { taskPartProgress } from '#lib/task-parts.js';
	import { activityMinute } from '#lib/activity-minute.js';
	import { taskDisplayWords } from '#lib/tasks.js';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import type { ThreadSummary, WorkerSummary } from '@kemiri/protocol';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { buildTaskGraph, graphLabel, graphNeighborhood, visibleGraphEdges, placeGraphCrewOnRims, type GraphPosition, type TaskGraph } from '#lib/task-graph.js';
	import { settledGraphPositions, interpolateGraphPositions } from '#lib/task-graph-layout.js';
	import { fitGraphCamera, loadGraphCamera, saveGraphCamera, placeGraphLabels, type GraphCamera } from '#lib/task-graph-camera.js';

	let { board, scope, workers = [], threads = [], taskHref, workerHref, selectedTaskId = null, viewSwitch }: {
		board:ProjectBoard | undefined; scope:string; workers?:readonly WorkerSummary[]; threads?:readonly ThreadSummary[];
		selectedTaskId?:string | null; taskHref:(id:string)=>string; workerHref?:(worker:WorkerSummary)=>string; viewSwitch:Snippet;
	} = $props();
	let showClosed = $state(false);
	let showResting = $state(false), allLinks = $state(false), showLegend = $state(false);
	let viewOpen = $state(false), restingOpen = $state(false);
	const source = $derived(buildTaskGraph(board?.tasks ?? [], board?.board?.questions ?? [], workers, threads, showClosed, showResting));
	let graph = $state<TaskGraph>({nodes:[],edges:[],resting:[]});
	let positions = $state(new Map<string,GraphPosition>());
	let camera = $state<GraphCamera>({x:0,y:0,zoom:1});
	let svg:SVGSVGElement | null = $state(null);
	let width=$state(0), height=$state(0), reduced=$state(false), mounted=$state(false);
	let framed=false, frame=0;
	let enterDuration=$state(0);
	function arrive(_node:Element,options:{duration:number}) {return {duration:options.duration,css:(t:number)=>`opacity:${t}`};}
	let departureTimer:ReturnType<typeof setTimeout> | undefined;
	let destination=new Map<string,GraphPosition>();
	function storage():Storage | undefined {try{return localStorage;}catch{return undefined;}}
	let focused=$state<string | null>(null);
	const neighborhoodTask=$derived(focused ?? (selectedTaskId ? `task:${selectedTaskId}` : null));
	const edges=$derived(visibleGraphEdges(graph,neighborhoodTask,allLinks));
	const openTasks=$derived(source.nodes.filter(n=>n.kind==='task' && !['done','dropped'].includes(n.task!.status)));
	const workingCount=$derived(openTasks.filter(n=>['working','in_progress','clarifying'].includes(n.status)).length);
	const needCount=$derived(openTasks.filter(n=>n.attention).length);
	function idleAge(worker:WorkerSummary, now:number):string {
		const minutes=Math.max(0, Math.floor((now-Date.parse(worker.updatedAt))/60_000));
		return !Number.isFinite(minutes) ? '' : minutes<60 ? `${minutes} min` : minutes<1440 ? `${Math.floor(minutes/60)} h` : `${Math.floor(minutes/1440)} d`;
	}
	const highlighted=$derived(graphNeighborhood(graph,neighborhoodTask));
	const labels=$derived(placeGraphLabels(graph,positions,camera,width,height));
	const focusNode=$derived(graph.nodes.find(n=>n.id===focused));
	const focusPosition=$derived(focused ? positions.get(focused) : undefined);
	const tooltipX=$derived(focusPosition ? Math.max(130,Math.min(width-130,(focusPosition.x-camera.x)*camera.zoom+width/2)) : 0);
	const tooltipY=$derived(focusPosition ? Math.max(90,(focusPosition.y-camera.y)*camera.zoom+height/2-35) : 0);
	const viewBox=$derived(`${camera.x-width/camera.zoom/2} ${camera.y-height/camera.zoom/2} ${Math.max(1,width)/camera.zoom} ${Math.max(1,height)/camera.zoom}`);
	let reports=$state<Record<string,string>>({});
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
	function fit(rememberChoice=true) {
		camera=fitGraphCamera(positions,width,height);
		if(rememberChoice) remember();
	}
	function frameFirstGraph() {
		if(framed || !width || !height || !positions.size) return;
		camera=loadGraphCamera(scope,storage()) ?? fitGraphCamera(positions,width,height);
		framed=true;
	}
	function publish(next:TaskGraph) {
		cancelAnimationFrame(frame);
		clearTimeout(departureTimer);
		const from=positions;
		const target=settledGraphPositions(next,from,width/Math.max(1,height));
		destination=target;
		positions=target;
		frameFirstGraph();
		enterDuration=reduced || from.size===0 ? 0 : 300;
		graph=next;
		if(reduced || from.size===0) return;
		const departing=[...from].filter(([id])=>!target.has(id));
		const traveling=[...target].some(([id,p])=>{const old=from.get(id);return old && Math.hypot(old.x-p.x,old.y-p.y)>.1;});
		if(!traveling) {
			if(departing.length) {positions=new Map([...departing,...target]);departureTimer=setTimeout(()=>{positions=target;},320);}
			return;
		}
		const start=performance.now();
		const animate=(now:number)=>{
			const progress=Math.min(1,(now-start)/650);
			positions=progress<1 ? new Map([...departing,...interpolateGraphPositions(from,target,progress)]) : target;
			if(progress<1) frame=requestAnimationFrame(animate);
		};
		positions=new Map([...departing,...interpolateGraphPositions(from,target,0)]);
		frame=requestAnimationFrame(animate);
	}
	// Yield the first frame to the view switch. Solve only once, before publishing SVG, not on every paint.
	$effect(()=>{
		const next=source;
		if(!mounted || !width || !height) return;
		const timer=setTimeout(()=>untrack(()=>publish(next)),untrack(()=>positions.size ? 0 : 160));
		return ()=>clearTimeout(timer);
	});
	$effect(()=>{
		for(const worker of workers) {
			if(seenReports.has(worker.id) && worker.lastReport && seenReports.get(worker.id)!==worker.lastReport) {
				untrack(()=>{reports={...reports,[worker.id]:worker.updatedAt};});
				const timer=setTimeout(()=>{const next={...reports};delete next[worker.id];reports=next;reportTimers.delete(timer);},1800);
				reportTimers.add(timer);
			}
			seenReports.set(worker.id,worker.lastReport);
		}
	});
	onMount(()=>{
		const media=matchMedia('(prefers-reduced-motion: reduce)');reduced=media.matches;
		const motionChange=()=>{reduced=media.matches;if(reduced) {cancelAnimationFrame(frame);positions=destination;}};
		media.addEventListener('change',motionChange);
		const observer=new ResizeObserver(([entry])=>{if(!entry)return;width=entry.contentRect.width;height=entry.contentRect.height;frameFirstGraph();});
		if(svg) observer.observe(svg);
		mounted=true;
		return ()=>{
			observer.disconnect();media.removeEventListener('change',motionChange);cancelAnimationFrame(frame);clearTimeout(departureTimer);
			if(saveTimer) {clearTimeout(saveTimer);saveGraphCamera(scope,camera,storage());}
			for(const timer of reportTimers)clearTimeout(timer);
		};
	});
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
		if(drag.id) {for(const [id,p] of positions)if(id===drag.id||p.parentId===drag.id) {p.x+=dx;p.y+=dy;p.anchorX=p.x;p.anchorY=p.y;}placeGraphCrewOnRims(graph,positions);positions=new Map(positions);}
		else {camera={...camera,x:camera.x-dx,y:camera.y-dy};remember();}
		drag.x=event.clientX;drag.y=event.clientY;
	}
	function pointerUp(event:PointerEvent) {pointers.delete(event.pointerId);pinchDistance=0;if(drag?.moved)setTimeout(()=>{drag=null;},0);else drag=null;}
	function wheel(event:WheelEvent) {event.preventDefault();changeZoom(Math.exp(-event.deltaY*.0015));}
	function edgePath(from:string,to:string):string {
		const a=positions.get(from),b=positions.get(to);if(!a||!b)return '';
		const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
		return `M ${a.x+dx/d*(a.radius+5)} ${a.y+dy/d*(a.radius+5)} L ${b.x-dx/d*(b.radius+9)} ${b.y-dy/d*(b.radius+9)}`;
	}
</script>

<svelte:window onkeydown={event=>{if(event.key==='Escape'){viewOpen=false;restingOpen=false;}}}/>

<section data-no-task-preview class="task-graph" aria-label="Task graph">
	<div class="graph-toolbar">
		{@render viewSwitch()}
		<span class="graph-counts">{openTasks.length} open · {workingCount} working · {needCount} need attention</span>
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
	<div class="graph-stage">
		{#if source.resting.length}<div class="resting-workers">
			<button class="resting-chip" aria-expanded={restingOpen} onclick={()=>{restingOpen=!restingOpen;viewOpen=false;}}>Resting · {source.resting.length}</button>
			{#if restingOpen}<div class="resting-panel" role="region" aria-label="Resting workers">
				<strong>Resting workers</strong>
				<ul>{#each source.resting as worker (worker.id)}
					{@const task=board?.tasks.find(task=>task.id===worker.taskId || (!worker.taskId && task.workerIds.includes(worker.id)))}
					<li><a href={workerHref?.(worker)} class:failed={worker.status==='failed'}><b>{worker.id}</b><span>{task ? `${task.id} · ${task.title}` : worker.taskId ? `${worker.taskId} · task unavailable` : 'No task'}</span><small>{worker.status==='failed'?'Failed':'Idle'} · {idleAge(worker,$activityMinute)}</small></a></li>
				{/each}</ul>
			</div>{/if}
		</div>{/if}
		<div class="graph-controls"><button onclick={()=>changeZoom(.8)} aria-label="Zoom out">−</button><button onclick={()=>changeZoom(1.25)} aria-label="Zoom in">+</button><button onclick={()=>fit()}>Fit</button></div>
		{#if showLegend}<div class="legend" aria-label="Relationship legend"><span>— Subtask</span><span>┄ Blocked by →</span><span>·· Found while</span><span>╌ Related</span></div>{/if}
		<!-- Pointer gestures only move the camera or nodes; tasks remain ordinary keyboard links. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<svg bind:this={svg} class="graph-canvas" {viewBox} role="group" aria-label="Interactive task graph. Drag to pan; pinch or use zoom buttons. Tab to nodes, Enter opens a task. List has all task details." onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp} onwheel={wheel}>
			<defs><marker id="task-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker><radialGradient id="task-graph-shine" cx="30%" cy="20%"><stop offset="0%" stop-color="white" stop-opacity=".45"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs>
			{#each graph.nodes.filter(n=>n.kind==='task'&&n.radius>35&&!n.parent) as node (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}<path class="cluster" class:dimmed={!highlighted.has(node.id)} transform="translate({p.x} {p.y}) scale(1.15)" d="M -190 -35 C -220 -190 -45 -215 30 -190 C 210 -225 245 -40 185 60 C 190 215 -20 230 -90 165 C -210 165 -245 60 -190 -35"/>{/if}
			{/each}
			{#each edges as edge (edge.id)}
				<path class="edge {edge.kind}" class:edge-focused={neighborhoodTask===edge.from||neighborhoodTask===edge.to} class:dimmed={!highlighted.has(edge.from)||!highlighted.has(edge.to)} d={edgePath(edge.from,edge.to)} marker-end={edge.kind==='blockedBy'?'url(#task-graph-arrow)':undefined}/>
			{/each}
			{#each graph.nodes as node,index (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}
					<g transform="translate({p.x} {p.y})" class="node-position" class:dimmed={!highlighted.has(node.id)} in:arrive|global={{duration:enterDuration}} out:fade|global={{duration:reduced?0:280}}>
						<a href={node.kind==='task'?taskHref(node.task!.id):undefined} role={node.kind==='task'?undefined:'img'} tabindex="0" aria-label={graphLabel(node)} data-node={node.id} onmouseenter={()=>focused=node.id} onmouseleave={()=>focused=null} onfocus={()=>focused=node.id} onblur={()=>focused=null} onclick={(event)=>{if(drag?.moved)event.preventDefault();}}>
							<g class="node {node.kind} status-{node.status}" class:closed={node.status==='done'||node.status==='dropped'} class:reporting={!!reports[node.worker?.id??'']} style="--delay:{index*-.37}s">
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
									{@const StateIcon=({failed:TriangleAlertIcon,blocked:TriangleAlertIcon,answer_needed:CircleHelpIcon,clarifying:CircleHelpIcon,review:EyeIcon,paused:PauseIcon,blocked_by_task:LockIcon,waiting_outside:ClockIcon,waiting:ClockIcon,todo:CircleIcon,done:CheckIcon,dropped:BanIcon} as Record<string,typeof CircleIcon>)[kind]}
									{#if StateIcon}<StateIcon x={-10} y={-10} width={20} height={20} class="state-glyph" aria-hidden="true"/>{:else}<circle class="working-dot" r="6"/>{/if}
									<title>{activity?.text ?? graphLabel(node)}</title>
								{:else}
									<g class="creature" class:busy={node.status==='running'} class:resting={node.status==='idle'}>
										<ellipse class="creature-shadow" cy={node.radius+7} rx={node.radius*.8} ry="5"/>
										<path class="antenna" d="M 0 -20 Q -10 -42 3 -39"/><circle class="antenna-tip" cx="3" cy="-39" r="4"/>
										<rect class="creature-body" x={-node.radius} y={-node.radius} width={node.radius*2} height={node.radius*2} rx={node.radius*.7}/>
										{#if node.status==='idle'}<path class="face" d="M -12 -2 q 4 5 8 0 M 4 -2 q 4 5 8 0"/><text class="sleep" x="24" y="-23">z</text>{:else}<ellipse class="eye" cx="-8" cy="-3" rx="3" ry="4"/><ellipse class="eye" cx="8" cy="-3" rx="3" ry="4"/>{/if}
										<path class="face" d="M -4 7 Q 0 11 4 7"/><circle class="cheek" cx="-14" cy="6" r="4"/><circle class="cheek" cx="14" cy="6" r="4"/>
										{#if node.status==='running'}<g class="working-hands"><path d="M -25 15 l 12 7 M 25 15 l -12 7"/><rect x="-16" y="19" width="32" height="11" rx="3"/><path d="M -9 24 h 5 M 0 24 h 5"/></g>{/if}
									</g>
								{/if}
							</g>
						</a>
					</g>
				{/if}
			{/each}
			{#each graph.nodes.filter(n=>n.kind==='task') as node (node.id)}
				{@const p=positions.get(node.id)}
				{#if p}<g class="task-caption" class:dimmed={!highlighted.has(node.id)} transform="translate({p.x} {p.y+node.radius+12*Math.max(1,.85/camera.zoom)}) scale({Math.max(1,.85/camera.zoom)})">
					<rect class="graph-task-id-chip" x={-(node.task!.id.length*7+14)/2} y="-8" width={node.task!.id.length*7+14} height="18" rx="6"/><text class="task-id" y="5">{node.task!.id}</text>
				</g>{/if}
			{/each}
			{#each [...labels] as [id,label] (id)}<text class="graph-label" class:dimmed={!highlighted.has(id)} x={label.x+label.width/2} y={label.y+12*label.scale} font-size={12*label.scale} stroke-width={4*label.scale}>{#each label.lines as line,i}<tspan x={label.x+label.width/2} dy={i?16*label.scale:0}>{line}</tspan>{/each}</text>{/each}
		</svg>
		{#if board?.loaded&&graph.nodes.length===0}<p class="empty-graph">No active tasks. Show closed or use List.</p>{/if}
		{#if focusNode&&focusPosition}<div class="node-tooltip" role="tooltip" style="left:{tooltipX}px;top:{tooltipY}px"><strong>{focusNode.title}</strong><span>{focusNode.task?.id ?? focusNode.worker?.id ?? focusNode.thread?.id} · {focusNode.task ? taskDisplayWords(focusNode.task, board?.tasks ?? []) : focusNode.status.replaceAll('_',' ')}{focusNode.attention?' · needs you':''}{focusNode.task?.subtaskCount?` · ${focusNode.task.subtaskCount.done}/${focusNode.task.subtaskCount.total} subtasks done`:''}</span></div>{/if}
	</div>
</section>

<style>
	.task-graph{--graph-todo:var(--chat-fg-subtle);--graph-working:var(--task-status-working);--graph-blocked:var(--tone-danger);--graph-review:var(--task-status-review);--graph-waiting:var(--chat-fg-subtle);display:flex;flex-direction:column;min-height:0;height:100%;color:var(--chat-fg);background:var(--chat-bg);overflow:hidden}
	.graph-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 16px;border-bottom:1px solid var(--chat-border);font-size:12px;z-index:4}.graph-counts{color:var(--chat-fg-muted);font-size:11px}.view-menu{position:relative;margin-left:auto}.menu-toggle,.resting-chip{border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-surface);padding:7px 12px;font-size:12px;cursor:pointer}.menu-panel{position:absolute;right:0;top:calc(100% + 8px);width:260px;max-width:calc(100vw - 30px);background:var(--chat-surface);border:1px solid var(--chat-border);border-radius:12px;box-shadow:var(--tone-shadow);padding:6px;z-index:5}.menu-panel label{display:flex;align-items:center;gap:8px;padding:10px 8px;min-height:40px;cursor:pointer}input{accent-color:var(--graph-working)}
	.resting-workers{position:absolute;left:12px;bottom:12px;z-index:3}.resting-panel{position:absolute;bottom:calc(100% + 8px);left:0;width:310px;max-width:calc(100vw - 32px);max-height:55vh;overflow:auto;padding:12px;border:1px solid var(--chat-border);border-radius:14px;background:var(--chat-surface);box-shadow:var(--tone-shadow);font-size:12px}.resting-panel ul{list-style:none;padding:0;margin:6px 0 0}.resting-panel a{display:flex;flex-direction:column;gap:3px;padding:8px;border-radius:8px}.resting-panel a:hover{background:var(--chat-surface-2)}.resting-panel span,.resting-panel small{color:var(--chat-fg-muted)}.resting-panel .failed small{color:var(--graph-blocked)}
	.graph-controls{position:absolute;bottom:12px;right:12px;display:flex;gap:4px;z-index:2}.graph-controls button{height:34px;min-width:34px;border:1px solid var(--chat-border);border-radius:10px;background:var(--chat-surface);font-size:14px;padding:0 8px;cursor:pointer}.graph-controls button:hover{background:var(--chat-surface-2)}
	.graph-stage{position:relative;flex:1;min-height:220px;overflow:hidden;animation:arrive .5s ease-out}.graph-canvas{width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;background:radial-gradient(ellipse at 40% 35%,color-mix(in srgb,var(--graph-working) 5%,transparent),transparent 65%)}.graph-canvas:active{cursor:grabbing}.dimmed{opacity:.15;transition:opacity .2s}.node-position{transition:opacity .2s}.node{--node-color:var(--graph-todo)}.status-working,.status-clarifying,.status-in_progress,.status-running{--node-color:var(--graph-working)}.status-blocked,.status-failed{--node-color:var(--graph-blocked)}.status-answer_needed,.status-review{--node-color:var(--graph-review)}.status-paused{--node-color:var(--chat-fg-subtle)}.status-blocked_by_task,.status-waiting_outside,.status-waiting{--node-color:var(--chat-fg-subtle)}.status-done{--node-color:var(--tone-success)}.closed{opacity:.35}
	.cluster{fill:color-mix(in srgb,var(--chat-fg-subtle) 5%,var(--chat-bg));stroke:color-mix(in srgb,var(--chat-fg-subtle) 14%,transparent);stroke-width:1}
	.edge{fill:none;stroke:var(--chat-fg-subtle);stroke-width:1.6;opacity:.45}.edge.parent{stroke:var(--graph-working);stroke-width:2}.edge.foundWhile{stroke:var(--graph-waiting);stroke-dasharray:2 6;stroke-linecap:round}.edge.blockedBy{stroke:var(--chat-fg-subtle);stroke-width:1.8;stroke-dasharray:5 5}.edge.blockedBy.edge-focused{stroke:var(--graph-blocked);opacity:.85}.edge.related{stroke:var(--graph-review);stroke-dasharray:8 6}.edge.dimmed{opacity:.08}
	.task-body{fill:color-mix(in srgb,var(--node-color) 23%,var(--chat-bg));stroke:var(--node-color);stroke-width:2}.task-id{font-size:12px;font-weight:600;font-family:var(--font-mono);fill:light-dark(#4338ca,#c7d2fe);text-anchor:middle;pointer-events:none}.graph-task-id-chip{fill:color-mix(in srgb,var(--accent-2) 12%,var(--chat-bg));pointer-events:none}:global([data-theme="neutral"]) .task-id{fill:var(--chat-fg)}.graph-label{fill:var(--chat-fg);stroke:var(--chat-bg);paint-order:stroke;text-anchor:middle;font-weight:550;pointer-events:none;stroke-linejoin:round}.progress-track{fill:none;stroke:var(--chat-border);stroke-width:3}.progress{fill:none;stroke:var(--graph-working);stroke-width:3;stroke-linecap:round}.attention-halo{fill:color-mix(in srgb,var(--node-color) 4%,transparent);stroke:var(--node-color);stroke-width:2;opacity:.4;}
	a{cursor:pointer;outline:none}a:focus-visible .task-body,a:focus-visible .creature-body{stroke:var(--chat-fg);stroke-width:4}a:hover .task-body{stroke-width:3}
	.creature-body{fill:color-mix(in srgb,var(--node-color) 60%,var(--chat-bg));stroke:var(--node-color);stroke-width:2}.thread .creature-body{fill:color-mix(in srgb,var(--graph-review) 55%,var(--chat-bg));stroke:var(--graph-review)}.eye{fill:var(--chat-fg);animation:blink 6s infinite;transform-origin:center;transform-box:fill-box}.face,.antenna{fill:none;stroke:var(--chat-fg);stroke-width:2;stroke-linecap:round}.antenna-tip{fill:var(--graph-waiting)}.reporting .antenna-tip{animation:report 1.6s ease-out}.cheek{fill:var(--graph-blocked);opacity:.6}.creature-shadow{fill:var(--chat-fg);opacity:.08}.working-hands{stroke:var(--chat-fg);stroke-width:2;fill:var(--chat-surface-2);animation:typing .55s ease-in-out infinite alternate;transform-origin:center}.busy{animation:busy 2.5s ease-in-out infinite;animation-delay:var(--delay)}.resting{animation:breathe 5s ease-in-out infinite;transform-origin:center}.sleep{font-size:18px;fill:var(--chat-fg-subtle)}
	.node-tooltip{position:absolute;transform:translate(-50%,-100%);width:240px;max-width:calc(100% - 20px);border:1px solid var(--chat-border);border-radius:12px;padding:10px 12px;background:var(--chat-surface);box-shadow:var(--tone-shadow);pointer-events:none;z-index:2;font-size:13px;overflow-wrap:anywhere}.node-tooltip strong{display:block;font-weight:600}.node-tooltip span{display:block;margin-top:4px;font-size:11px;color:var(--chat-fg-muted)}.empty-graph{position:absolute;top:45%;width:100%;text-align:center;font-size:13px;color:var(--chat-fg-muted);pointer-events:none}
	.legend{position:absolute;top:12px;left:12px;display:flex;flex-wrap:wrap;gap:12px;max-width:calc(100% - 24px);border:1px solid var(--chat-border);border-radius:10px;padding:8px 12px;background:var(--chat-surface);font-size:11px;color:var(--chat-fg-muted);z-index:2}
	.part-done{stroke:var(--task-status-done)}.part-working{stroke:var(--task-status-working)}.part-needs-you{stroke:var(--task-status-review)}.part-other{stroke:var(--chat-fg-subtle)}:global(.state-glyph){color:var(--node-color)}.working-dot{fill:var(--node-color);animation:working-pulse 3s ease-in-out infinite}.task-caption{pointer-events:none}@keyframes working-pulse{50%{opacity:.4}}
	@keyframes arrive{from{opacity:0}to{opacity:1}}@keyframes busy{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg) translateY(-2px)}}@keyframes typing{to{transform:translateY(1.5px) rotate(2deg)}}@keyframes breathe{50%{transform:scale(1.025) translateY(-1px)}}@keyframes blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.15)}}@keyframes report{25%{fill:var(--graph-working);r:7}100%{r:4}}
	@media(max-width:640px){.graph-toolbar{gap:8px;padding:8px 10px}.graph-counts{order:3;flex-basis:100%;font-size:11px}.graph-controls button,.menu-toggle,.resting-chip{min-height:40px;min-width:40px}.graph-controls{gap:3px}}
	@media(prefers-reduced-motion:reduce){.graph-stage,.node-position,.busy,.resting,.eye,.working-hands,.attention-halo,.working-dot,.reporting .antenna-tip{animation:none}.dimmed,.node-position{transition:none}}
</style>
