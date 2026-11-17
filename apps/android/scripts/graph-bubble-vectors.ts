import { makeGraphFixture, FIXTURE_NOW } from '../../web/test/fixtures/task-graph-busy.ts';
import { buildTaskGraph, graphLabel, graphNeighborhood, reconcileGraphPositions, stepGraphLayout, visibleGraphEdges, type GraphPosition, type TaskGraph } from '../../web/src/lib/task-graph.ts';
import { settledGraphPositions, interpolateGraphPositions } from '../../web/src/lib/task-graph-layout.ts';
import { fitGraphCamera, placeGraphLabels } from '../../web/src/lib/task-graph-camera.ts';
import { graphFoldGroups, graphFoldExpansion, graphFoldPosition, liveTaskGraph, revealGraphTask, renderedGraphNodes, type GraphFoldKind } from '../../web/src/lib/task-graph-live.ts';
import { graphCounts, graphCaptionScale, graphEdgeSegment } from '../../web/src/lib/task-graph-presentation.ts';
import { graphCrewMotion, graphCrewInView, interpolateCrewHandoff, departingGraphCrew, graphReportCues } from '../../web/src/lib/graph-worker-motion.ts';
import { workerMotion, workerMotionDelay } from '../../web/src/lib/worker-motion.ts';
import type { BoardTask, BoardQuestion, WorkerSummary } from '@kemiri/protocol';

// The actual web functions are the oracle; no copied expected arithmetic.
const fixture = makeGraphFixture();
const base = fixture.board.tasks[0]!;
const task = (id:string, patch:Partial<BoardTask> = {}):BoardTask => ({...base,id,title:`Task ${id}`,parent:null,status:'todo',blockedBy:[],related:[],foundWhile:null,workerIds:[],subtaskCount:undefined,...patch});
const worker = (id:string, taskId:string|null, status:WorkerSummary['status']):WorkerSummary => ({...fixture.workers[0]!,id,taskId,status});
type Input = ReturnType<typeof makeGraphFixture>;
const cases:{name:string;input:Input;showClosed?:boolean;showResting?:boolean;aspect?:number;retain?:boolean}[] = [
	{name:'busy hidden desktop',input:fixture,aspect:1.8},
	{name:'busy closed phone',input:fixture,showClosed:true,aspect:390/700},
];
const resting:Input={...fixture,board:{...fixture.board,tasks:[task('T1'),task('T2',{status:'done'}),task('T3',{archived:true}),task('T4',{workerIds:['fallback']})],questions:[]},threads:[],workers:[worker('idle-closed','T2','idle'),worker('idle-absent',null,'idle'),worker('failed-absent','missing','failed'),worker('failed-closed','T2','failed'),worker('idle-archived','T3','idle'),worker('failed-open','T1','failed'),worker('fallback',null,'running'),worker('running-absent',null,'running'),worker('done','T1','done'),worker('stopped','T1','stopped')]};
cases.push({name:'resting hidden',input:resting},{name:'resting shown closed',input:resting,showClosed:true,showResting:true});
const foldInput:Input={...fixture,board:{...fixture.board,tasks:[task('T1',{status:'in_progress',blockedBy:['T2']}),task('T2',{blockedBy:['T3']}),task('T3'),task('T4'),task('T5',{status:'waiting',blockedBy:['T4']}),task('T6',{related:['T4'],foundWhile:'T1'}),task('T7'),task('T8',{parent:'T7'}),task('T9')],questions:[]},workers:[worker('idle','T4','idle'),worker('busy','T9','running')],threads:[]};
cases.push({name:'fold dependencies and idle crew',input:foldInput});
const derived:Input={...resting,workers:[],board:{...resting.board,tasks:['failed','answer_needed','review','working','clarifying','paused','blocked_by_task','todo','waiting_outside','done','dropped'].map((kind,i)=>task(`T${i+1}`,{state:{kind:kind as NonNullable<BoardTask['state']>['kind'],group:['failed','answer_needed','review'].includes(kind)?'needs_you':['done','dropped'].includes(kind)?'closed':kind==='todo'?'todo':['working','clarifying','paused'].includes(kind)?'in_progress':'waiting',refs:kind==='blocked_by_task'?['T1']:[],since:FIXTURE_NOW},status:['done','dropped'].includes(kind)?kind as 'done'|'dropped':'todo'})),questions:[]}};
cases.push({name:'derived states',input:derived,showClosed:true});
const sequence=makeGraphFixture(18);
cases.push({name:'sequence initial',input:sequence});
let arrival:Input={...sequence,board:{...sequence.board,tasks:[...sequence.board.tasks,task('T19',{parent:'T1'}),task('T20'),task('T21',{parent:'T20'})]}};
cases.push({name:'sequence new task and family',input:arrival,retain:true});
arrival={...arrival,board:{...arrival.board,tasks:arrival.board.tasks.map(t=>t.id==='T3'?{...t,status:'done'}:t)},workers:arrival.workers.map(w=>w.id==='fern'?{...w,taskId:'T21',lastReport:'Synthetic parity check passed.'}:w)};
cases.push({name:'sequence closing and reassignment',input:arrival,retain:true});
// Cycles and missing ancestors exercise recursion defense; IDs cover lexicographic sibling order.
cases.push({name:'cycles and absent parent',input:{...resting,workers:[],board:{...resting.board,tasks:[task('T1',{parent:'T2'}),task('T2',{parent:'T1'}),task('T10',{parent:'missing'}),task('T11',{parent:'T10'}),task('T12',{parent:'T10'})],questions:[]}}});
cases.push({name:'identifier ordering and Unicode',input:{...resting,board:{...resting.board,tasks:[task('T1',{title:'A long\u00a0title with enough words for two lines and truncation'}),task('T2',{parent:'T1'}),task('T10',{parent:'T1'}),...['','Waiting forever','Waiting for a check'].map((note,i)=>task(`T${i+20}`,{state:{kind:'waiting_outside',group:'waiting',refs:[],since:FIXTURE_NOW},waiting:{note,since:FIXTURE_NOW,until:null,by:'coordinator'}}))],questions:[]},workers:['alpha_1','alpha-1','alpha1','Alpha1','crew-🌱'].map(id=>worker(id,'T1','idle'))}});
const positionsJSON=(p:ReadonlyMap<string,GraphPosition>)=>Object.fromEntries(p);
const graphJSON=(graph:TaskGraph)=>({nodes:graph.nodes.map(n=>({id:n.id,kind:n.kind,title:n.title,status:n.status,parent:n.parent,attention:n.attention,radius:n.radius,label:graphLabel(n)})),edges:graph.edges,resting:graph.resting.map(w=>w.id)});
const inputs: {tasks:BoardTask[];questions:BoardQuestion[];workers:WorkerSummary[];threads:Input['threads']}[]=[];
let previous=new Map<string,GraphPosition>(),previousGraph:TaskGraph={nodes:[],edges:[],resting:[]},previousFold:GraphPosition|null=null;
const scenarios=cases.map(({name,input,showClosed=false,showResting=false,aspect=1,retain=false})=>{
	if(!retain){previous=new Map();previousGraph={nodes:[],edges:[],resting:[]};previousFold=null;}
	const graph=buildTaskGraph(input.board.tasks,input.board.questions,input.workers,input.threads,showClosed,showResting);
	const reconciled=reconcileGraphPositions(graph,previous,aspect);
	const stepped=new Map([...reconciled].map(([id,p])=>[id,{...p}]));
	const pinned=new Set(previous.keys());
	const energy=stepGraphLayout(stepped,pinned);
	const positions=settledGraphPositions(graph,previous,aspect);
	const folds=graphFoldGroups(graph,input.board.questions),foldPosition=graphFoldPosition(positions,previousFold);
	const modes=([{mode:'all',expanded:[]},{mode:'live',expanded:[]},{mode:'live',expanded:['todo']},{mode:'live',expanded:['waiting']},{mode:'live',expanded:['todo','waiting']}] as const).filter(({expanded})=>folds.length>0||expanded.length===0).map(({mode,expanded})=>{
		const shown=liveTaskGraph(graph,folds,mode,new Set<GraphFoldKind>(expanded),showResting);
		return {mode,expanded,graph:{nodes:shown.nodes.map(n=>({id:n.id,parent:n.parent})),edges:shown.edges.map(e=>e.id),resting:shown.resting.map(w=>w.id)},edges:[null,'task:T1','task:T4'].flatMap(focus=>[false,true].map(allLinks=>({focus,allLinks,ids:visibleGraphEdges(shown,focus,allLinks).map(e=>e.id),highlighted:[...graphNeighborhood(shown,focus)].sort()})))};
	});
	const views=[{width:390,height:700},{width:1440,height:900}].map(({width,height})=>{
		const framing=new Map([...positions,...(folds.length&&foldPosition?[['folds',foldPosition] as const]:[])]);
		const camera=fitGraphCamera(framing,width,height);
		return {width,height,camera,crewInView:graph.nodes.filter(n=>n.kind!=='task').map(n=>({id:n.id,inView:graphCrewInView(positions.get(n.id),camera,width,height)}))};
	});
	const departures=departingGraphCrew(previousGraph,graph,input.workers,input.threads);
	const serializedInput={tasks:input.board.tasks,questions:input.board.questions,workers:input.workers,threads:input.threads};
	let inputIndex=inputs.findIndex(existing=>JSON.stringify(existing)===JSON.stringify(serializedInput));
	if(inputIndex<0){inputIndex=inputs.length;inputs.push(serializedInput);}
	const result={name,input:inputIndex,showClosed,showResting,aspect,retain,
		graph:graphJSON(graph),counts:graphCounts(graph),positions:positionsJSON(positions),
		...(graph.nodes.length<40?{reconciled:positionsJSON(reconciled),stepped:positionsJSON(stepped),energy,interpolated:positionsJSON(interpolateGraphPositions(previous,positions,.35)),handoff:positionsJSON(interpolateCrewHandoff(previous,positions,.35))}:{}),
		labels:[.35,.8,1.5].map(zoom=>({zoom,captionScale:graphCaptionScale(zoom),boxes:Object.fromEntries(placeGraphLabels(graph,positions,{x:0,y:0,zoom},390,700))})),
		folds,foldPosition,expandedTodo:[...graphFoldExpansion(graph,folds,new Set(['todo']))].sort(),closedTodo:[...graphFoldExpansion(graph,folds,new Set(['todo','waiting']),'todo')].sort(),revealed: [...revealGraphTask(folds,new Set(),'T4')].sort(),modes,views,
		segments:graph.edges.map(e=>({id:e.id,...graphEdgeSegment(positions.get(e.from)!,positions.get(e.to)!)})),
		crew:graph.nodes.filter(n=>n.kind!=='task').map(n=>({id:n.id,motion:graphCrewMotion(n,input.board.tasks,input.board.questions),delay:workerMotionDelay(n.id)})),
		departures:departures.map(n=>n.id),rendered:renderedGraphNodes(graph,departures).map(n=>n.id),reports:graphReportCues(new Map(input.workers.map(w=>[w.id,null])),input.workers,graph)};
	previous=positions;previousGraph=graph;previousFold=foldPosition;
	return result;
});
const motion=['running','idle','failed','done','stopped'].flatMap(status=>[null,'todo','review','done','dropped'].flatMap(taskStatus=>[null,{waitingOn:'agent'},{waitingOn:'user'},{kind:'warning',blocksWork:false},{kind:'warning',blocksWork:true},{status:'answered'}].map(ask=>{
	const t=taskStatus?task('T1',{status:taskStatus as BoardTask['status']}):null;
	const questions:BoardQuestion[]=ask?[{...fixture.board.questions[0]!,taskId:'T1',...ask} as BoardQuestion]:[];
	return {status,taskStatus,ask,motion:workerMotion({status:status as WorkerSummary['status']},t,questions)};
})));
// Camera gestures use the web component's world-centre convention and zoom clamp.
const cameraGestures = [
	{camera:{x:120,y:240,zoom:.4},dx:32,dy:-16,factor:1.25},
	{camera:{x:0,y:0,zoom:.1},dx:-10,dy:10,factor:.1},
	{camera:{x:-50,y:5,zoom:3},dx:0,dy:0,factor:2},
].map(input=>({...input,expected:{x:input.camera.x-input.dx/input.camera.zoom,y:input.camera.y-input.dy/input.camera.zoom,zoom:Math.max(.08,Math.min(4,input.camera.zoom*input.factor))}}));
// One generated scenario per line keeps this large oracle below the repository snapshot limit.
const source='{\n  "version": 1,\n  "inputs": '+JSON.stringify(inputs)+',\n  "scenarios": [\n'+scenarios.map(s=>'    '+JSON.stringify(s)).join(',\n')+'\n  ],\n  "motion": '+JSON.stringify(motion)+',\n  "cameraGestures": '+JSON.stringify(cameraGestures)+'\n}\n';
const path=new URL('../test-vectors/task-graph-bubble-v1.json',import.meta.url);
if(Bun.argv.includes('--check')) {
	if(await Bun.file(path).text()!==source)throw new Error('Bubble graph vectors differ from the web model');
	console.log('Bubble graph vectors match the web model');
}else await Bun.write(path,source);
