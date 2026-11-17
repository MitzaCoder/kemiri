import { describe, expect, it } from 'bun:test';
import type { BoardQuestion, BoardTask, ThreadSummary, WorkerSummary } from '@kemiri/protocol';
import { buildTaskGraph, graphLabel, graphNeighborhood, visibleGraphEdges, graphWorkerRests, reconcileGraphPositions, stepGraphLayout } from '../src/lib/task-graph.ts';
import { loadTasksViewMode } from '../src/lib/kanban.ts';
function task(id:string, extra:Partial<BoardTask>={}):BoardTask {
	return {id,revision:1,title:`Invented ${id}`,description:'',acceptance:null,refs:[],status:'todo',blockedBy:[],blockedReason:null,writeScopes:[],workerIds:[],scheduleId:null,report:{now:'',results:'',next:'',revision:0,updatedAt:null,updatedBy:null},snapshots:0,order:Number(id.slice(1)),createdBy:'coordinator',updatedBy:'coordinator',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',settledAt:null,archived:false,...extra};
}
const worker = (extra:Partial<WorkerSummary>={}):WorkerSummary => ({id:'sprout',title:'Check shapes',status:'running',model:{provider:'faux',modelId:'faux-1'},thinkingLevel:null,isolation:'shared',workspacePath:null,conversationId:2,spawnedByCallId:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',lastReport:null,failure:null,taskId:'T2',...extra});
const thread:ThreadSummary = {id:'studio',title:'Shape studio',status:'running',main:false,startedBy:'main',scheduleId:null,conversationId:3,model:null,thinkingLevel:null,onFinish:'record',runningWorkers:2,taskId:'T1',ownedTasks:['T1'],openQuestions:0,current:null,summary:null,failure:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',finishedAt:null,archived:false};
const tasks = [task('T1'),task('T2',{parent:'T1',blockedBy:['T5']}),task('T3',{parent:'T2'}),task('T4',{foundWhile:'T1',related:['T5']}),task('T5',{related:['T4']}),task('T6',{status:'done'}),task('T7',{archived:true})];
const build = () => buildTaskGraph(tasks,[],[],[]);
describe('task graph building',()=>{
	it('shows active by default and closed only when asked, never archived',()=>{
		expect(build().nodes.map(n=>n.id)).toEqual(['task:T1','task:T2','task:T3','task:T4','task:T5']);
		expect(buildTaskGraph(tasks,[],[],[],true).nodes.map(n=>n.id)).toContain('task:T6');
		expect(buildTaskGraph(tasks,[],[],[],true).nodes.map(n=>n.id)).not.toContain('task:T7');
	});
	it('keeps all four edges, related once and blocker direction intact',()=>{
		const graph=build(); expect(graph.edges.filter(e=>e.kind==='related')).toHaveLength(1);
		expect(new Set(graph.edges.map(e=>e.kind))).toEqual(new Set(['parent','blockedBy','foundWhile','related']));
		expect(graph.edges.find(e=>e.kind==='blockedBy')).toMatchObject({from:'task:T2',to:'task:T5'});
	});
	it('omits dangling edges without hiding the task',()=>{
		const graph=buildTaskGraph([task('T1',{parent:'missing',blockedBy:['missing']})],[],[],[]);
		expect(graph.edges).toHaveLength(0);expect(graph.nodes).toHaveLength(1);
	});
	it('highlights nested family, blockers and attached workers but not unrelated origin',()=>{
		const graph=buildTaskGraph(tasks,[],[worker()],[]);
		expect([...graphNeighborhood(graph,'task:T3')].sort()).toEqual(['task:T1','task:T2','task:T3','task:T5','worker:sprout']);
	});
	it('uses taskId first, historical workerIds as fallback, and thread grouping',()=>{
		const graph=buildTaskGraph([task('T1',{workerIds:['sprout']}),task('T2')],[],[worker({threadId:'studio'})],[thread]);
		expect(graph.nodes.find(n=>n.kind==='worker')?.parent).toBe('task:T2');
		expect(graph.edges).toHaveLength(0);
		expect(buildTaskGraph([task('T1',{workerIds:['sprout']})],[],[worker({taskId:null})],[]).nodes.find(n=>n.kind==='worker')?.parent).toBe('task:T1');
		expect(graph.nodes.find(n=>n.kind==='thread')?.parent).toBe('task:T1');
	});
	it('keeps idle workers, omits done workers and main thread characters',()=>{
		const graph=buildTaskGraph(tasks,[],[worker({status:'idle'}),worker({id:'old',status:'done'})],[{...thread,id:'main',main:true}]);
		expect(graph.nodes.filter(n=>n.kind!=='task').map(n=>n.id)).toEqual(['worker:sprout']);
	});
	it('marks review, open questions and worker failure and speaks status/progress',()=>{
		const question = {taskId:'T1',status:'open'} as BoardQuestion;
		const graph=buildTaskGraph([task('T1'),task('T2'),task('T3',{status:'review',subtaskCount:{done:1,total:3}})],[question],[worker({status:'failed'})],[]);
		expect(graph.nodes.filter(n=>n.kind==='task').every(n=>n.attention)).toBe(true);
		expect(graph.nodes.find(n=>n.kind==='worker')?.attention).toBe(false);
		expect(graph.nodes.find(n=>n.id==='task:T2')?.status).toBe('failed');
		expect(graphLabel(graph.nodes[2]!)).toContain('1 of 3 subtasks done');
	});
	it('rests idle and failed workers only when their task is closed, archived, hidden or absent, without a clock',()=>{
		const board=[task('T1'),task('T2',{status:'done'}),task('T3',{archived:true}),task('T4',{status:'dropped'})];
		const crew=['T1','T2','T3','T4','missing',null].flatMap(taskId=>['idle','failed','running'].map(status=>worker({id:`${taskId}-${status}`,taskId,status:status as WorkerSummary['status']})));
		for(const showClosed of [false,true]) {
			const graph=buildTaskGraph(board,[],crew,[],showClosed);
			expect(graph.resting).toHaveLength(10);
			expect(graph.resting.every(w=>w.status!=='running'&&w.taskId!=='T1')).toBe(true);
			expect(graph.nodes.filter(n=>n.kind==='worker')).toHaveLength(8);
			expect(buildTaskGraph(board,[],crew,[],showClosed,true).nodes.filter(n=>n.kind==='worker')).toHaveLength(18);
		}
		expect(graphWorkerRests(worker({status:'idle',updatedAt:'2099-01-01'}),board[0],new Set())).toBe(true);
		expect(buildTaskGraph([task('T1',{workerIds:['sprout']})],[],[worker({status:'idle',taskId:null})],[]).resting).toHaveLength(0);
	});
	it('shows parent and blocked-by by default; optional links only around focus or with All links',()=>{
		const graph=build();
		expect(new Set(visibleGraphEdges(graph).map(e=>e.kind))).toEqual(new Set(['parent','blockedBy']));
		expect(visibleGraphEdges(graph,null,true)).toEqual(graph.edges);
		expect(visibleGraphEdges(graph,'task:T3').some(e=>e.kind==='foundWhile')).toBe(true);
		expect(visibleGraphEdges(graph,'task:T4').filter(e=>['related','foundWhile'].includes(e.kind))).toHaveLength(2);
		expect(visibleGraphEdges(graph,'task:T6').some(e=>['related','foundWhile'].includes(e.kind))).toBe(false);
	});
	it('remembers graph mode',()=>{
		expect(loadTasksViewMode({getItem:()=> 'graph'})).toBe('graph');
	});
});
describe('stable bounded graph layout',()=>{
	it('is deterministic and settles quickly with finite coordinates',()=>{
		const graph=build();const a=reconcileGraphPositions(graph),b=reconcileGraphPositions(graph);
		expect(a).toEqual(b);for(let i=0;i<110;i++)stepGraphLayout(a);
		expect(stepGraphLayout(a)).toBeLessThan(0.2);expect([...a.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
	});
	it('retains positions exactly on board replacement and insertion',()=>{
		const graph=build(), previous=reconcileGraphPositions(graph);for(let i=0;i<110;i++)stepGraphLayout(previous);
		const updated=buildTaskGraph([...tasks].reverse().concat(task('T8',{parent:'T1'})),[],[],[]);
		const next=reconcileGraphPositions(updated,previous);
		for(const [id,p] of previous)expect(next.get(id)).toEqual(p);
		expect(next.has('task:T8')).toBe(true);
	});
	it('nests children near parents, removes absent nodes, respects pinning',()=>{
		const graph=build(),p=reconcileGraphPositions(graph); const root=p.get('task:T1')!,child=p.get('task:T2')!;
		expect(Math.hypot(root.x-child.x,root.y-child.y)).toBeLessThan(235);
		const start={...child};stepGraphLayout(p,'task:T2');expect(child.x).toBe(start.x);expect(child.y).toBe(start.y);
		expect(reconcileGraphPositions({nodes:[],edges:[],resting:[]},p).size).toBe(0);
	});
	it('handles malformed cycles defensively and 80 tasks plus 10 workers',()=>{
		const board=Array.from({length:80},(_,i)=>task(`T${i+1}`,{parent:i%8 ? `T${Math.floor(i/8)*8+1}` : null}));
		const graph=buildTaskGraph(board,[],Array.from({length:10},(_,i)=>worker({id:`helper-${i}`,taskId:`T${i+1}`})),[]);
		const p=reconcileGraphPositions(graph);for(let i=0;i<110;i++)stepGraphLayout(p);expect(p.size).toBe(90);
		const cyclic=buildTaskGraph([task('T1',{parent:'T2'}),task('T2',{parent:'T1'})],[],[],[]);expect(reconcileGraphPositions(cyclic).size).toBe(2);
	});
});
