import { describe, expect, it } from 'bun:test';
import type { BoardTask } from '@kemiri/protocol';
import { buildTaskGraph, reconcileGraphPositions } from '../src/lib/task-graph.ts';
import { settledGraphPositions, interpolateGraphPositions } from '../src/lib/task-graph-layout.ts';
import { fitGraphCamera, loadGraphCamera, saveGraphCamera, placeGraphLabels, boxesOverlap, truncatedGraphTitle } from '../src/lib/task-graph-camera.ts';
import { loadTasksViewMode, saveTasksViewMode } from '../src/lib/kanban.ts';
function task(id:string,parent:string|null=null):BoardTask {
	return {id,revision:1,title:`A deliberately long invented title for ${id} and its nested pieces`,description:'',acceptance:null,refs:[],status:'in_progress',blockedBy:[],blockedReason:null,writeScopes:[],workerIds:[],scheduleId:null,report:{now:'',results:'',next:'',revision:0,updatedAt:null,updatedBy:null},snapshots:0,order:1,createdBy:'coordinator',updatedBy:'coordinator',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',settledAt:null,archived:false,parent};
}
const board=Array.from({length:80},(_,i)=>task(`T${i+1}`,i%8?`T${Math.floor(i/8)*8+1}`:null));
const graph=buildTaskGraph(board,[],[],[]);
describe('graph caption collision and level of detail',()=>{
	it('never overlaps labels or circles, including dense/nested families',()=>{
		const nested=buildTaskGraph([...board,task('T81','T2')],[],[],[]), positions=settledGraphPositions(nested);
		for(const zoom of [.2,.4,.7,1,2]) {
			const labels=[...placeGraphLabels(nested,positions,{x:650,y:850,zoom},1440,1000).values()];
			for(let i=0;i<labels.length;i++) {
				for(let j=i+1;j<labels.length;j++)expect(boxesOverlap(labels[i]!,labels[j]!)).toBe(false);
				for(const p of positions.values())expect(boxesOverlap(labels[i]!,{x:p.x-p.radius-7,y:p.y-p.radius-7,width:p.radius*2+14,height:p.radius*2+14})).toBe(false);
			}
		}
	});
	it('keeps every eligible two-line title, without one enlarged caption hiding its neighbours',()=>{
		const positions=settledGraphPositions(graph);
		for(const zoom of [.6,.7,1,2]) {
			const labels=placeGraphLabels(graph,positions,{x:0,y:0,zoom},1440,900);
			expect(labels.size).toBe(graph.nodes.length);
			for(const label of labels.values())expect(label.lines.length).toBeLessThanOrEqual(2);
		}
	});
	it('hides minor labels at low zoom, truncates only captions, leaves full titles intact',()=>{
		const positions=settledGraphPositions(graph);
		const labels=placeGraphLabels(graph,positions,{x:650,y:850,zoom:.25},1440,1000);
		for(const id of labels.keys())expect(graph.nodes.find(n=>n.id===id)!.radius).toBeGreaterThan(35);
		expect(truncatedGraphTitle(board[0]!.title)).toHaveLength(23);
		expect(graph.nodes[0]!.title).toBe(board[0]!.title);
	});
});
describe('pre-settled stable updates and worker travel',()=>{
	it('never changes existing task coordinates when a task arrives or status changes',()=>{
		const previous=settledGraphPositions(graph);
		const next=settledGraphPositions(buildTaskGraph([...board.map(t=>({...t,status:'review' as const})),task('T81','T2')],[],[],[]),previous);
		for(const [id,p] of previous) {expect(next.get(id)!.x).toBe(p.x);expect(next.get(id)!.y).toBe(p.y);}
	});
	it('adds whole families around retained tasks without overlapping bubbles or captions',()=>{
		const small=buildTaskGraph(board.slice(0,24),[],[],[]),previous=settledGraphPositions(small);
		const positions=settledGraphPositions(graph,previous);
		for(const [id,p] of previous)expect(positions.get(id)).toEqual(p);
		const circles=[...positions.values()];
		for(let i=0;i<circles.length;i++)for(let j=i+1;j<circles.length;j++) {
			const a=circles[i]!,b=circles[j]!;
			expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeGreaterThan(a.radius+b.radius+20);
		}
		const labels=[...placeGraphLabels(graph,positions,{x:0,y:0,zoom:1},1440,900).values()];
		expect(labels).toHaveLength(graph.nodes.length);
		for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++)expect(boxesOverlap(labels[i]!,labels[j]!)).toBe(false);
	});
	it('reanchors a worker when its task changes; interpolates, then removes it',()=>{
		const worker={id:'pip',title:'Care for the lens',status:'running' as const,model:{provider:'faux',modelId:'faux-1'},thinkingLevel:null,isolation:'shared' as const,workspacePath:null,conversationId:2,spawnedByCallId:null,createdAt:'2026-01-01',updatedAt:'2026-01-01',lastReport:null,failure:null,taskId:'T2'};
		const first=settledGraphPositions(buildTaskGraph(board,[],[worker],[]));
		const destination=settledGraphPositions(buildTaskGraph(board,[],[{...worker,taskId:'T18'}],[]),first);
		const from=first.get('worker:pip')!,to=destination.get('worker:pip')!;
		expect(to.parentId).toBe('task:T18');expect(Math.hypot(to.x-from.x,to.y-from.y)).toBeGreaterThan(100);
		const halfway=interpolateGraphPositions(first,destination,.35).get('worker:pip')!;
		expect(Math.hypot(halfway.x-from.x,halfway.y-from.y)).toBeGreaterThan(0);
		expect(Math.hypot(halfway.x-to.x,halfway.y-to.y)).toBeGreaterThan(0);
		expect(interpolateGraphPositions(first,destination,1)).toEqual(destination);
		expect(settledGraphPositions(buildTaskGraph(board,[],[{...worker,status:'done'}],[]),destination).has('worker:pip')).toBe(false);
	});
	it('perches workers and background jobs on the task rim, including multiple crew and retained updates',()=>{
		const worker={id:'one',title:'One',status:'running' as const,model:{provider:'faux',modelId:'faux-1'},thinkingLevel:null,isolation:'shared' as const,workspacePath:null,conversationId:2,spawnedByCallId:null,createdAt:'2026-01-01',updatedAt:'2026-01-01',lastReport:null,failure:null,taskId:'T1'};
		const thread={id:'crew',title:'Crew',main:false,archived:false,status:'running',taskId:'T1',ownedTasks:['T1']} as import('@kemiri/protocol').ThreadSummary;
		const graph=buildTaskGraph(board,[],[worker,{...worker,id:'two'}],[thread]);
		const first=settledGraphPositions(graph),next=settledGraphPositions(graph,first);
		for(const positions of [reconcileGraphPositions(graph),first,next]) {
			const parent=positions.get('task:T1')!;
			for(const node of graph.nodes.filter(n=>n.kind!=='task')) {
				const p=positions.get(node.id)!;
				expect(Math.hypot(p.x-parent.x,p.y-parent.y)).toBeCloseTo(parent.radius+node.radius*.55,6);
			}
			expect(positions.get('worker:one')).not.toEqual(positions.get('worker:two'));
		}
	});
	it('precomputes deterministic finite positions and does not mutate its previous map',()=>{
		const previous=reconcileGraphPositions(graph), copy=structuredClone(previous);
		const settled=settledGraphPositions(graph,previous);expect(previous).toEqual(copy);
		expect([...settled.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
	});
});
describe('project-local framing and view choice',()=>{
	it('fits every active node with padding on desktop and phone',()=>{
		const positions=settledGraphPositions(graph);
		for(const [w,h] of [[1440,750],[390,600]]) {
			const camera=fitGraphCamera(positions,w!,h!);
			for(const p of positions.values()) {
				expect(Math.abs(p.x-camera.x)*camera.zoom+p.radius*camera.zoom).toBeLessThan(w!/2);
				expect(Math.abs(p.y-camera.y)*camera.zoom+p.radius*camera.zoom).toBeLessThan(h!/2);
			}
		}
	});
	it('isolates camera and mode by backend/project and ignores malformed storage',()=>{
		const saved=new Map<string,string>(),storage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>{saved.set(k,v);}};
		saveGraphCamera('example:one',{x:100,y:-20,zoom:.8},storage);
		expect(loadGraphCamera('example:one',storage)).toEqual({x:100,y:-20,zoom:.8});expect(loadGraphCamera('example:two',storage)).toBeNull();
		saveTasksViewMode('graph',storage,'example:one');saveTasksViewMode('board',storage,'example:two');
		expect(loadTasksViewMode(storage,'example:one')).toBe('graph');expect(loadTasksViewMode(storage,'example:two')).toBe('board');
		expect(loadGraphCamera('bad',{getItem:()=>'{'})).toBeNull();expect(loadGraphCamera('bad',{getItem:()=>'{"x":0,"y":0,"zoom":-2}'})).toBeNull();
		expect(loadGraphCamera('bad',{getItem:()=>{throw new Error('disabled');}})).toBeNull();
	});
	it('has sensible empty framing and tolerates full storage',()=>{
		expect(fitGraphCamera(new Map(),390,600)).toEqual({x:0,y:0,zoom:1});
		expect(()=>saveGraphCamera('example',{x:0,y:0,zoom:1},{setItem:()=>{throw new Error('full');}})).not.toThrow();
	});
});
