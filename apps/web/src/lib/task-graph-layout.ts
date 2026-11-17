import { placeGraphCrewOnRims, reconcileGraphPositions, stepGraphLayout, type GraphPosition, type TaskGraph } from './task-graph.ts';
/** Solve before publishing SVG nodes. Existing tasks never move on watch updates, including insertions. */
export function settledGraphPositions(graph:TaskGraph,previous=new Map<string,GraphPosition>(),aspect=1):Map<string,GraphPosition> {
	const positions=reconcileGraphPositions(graph,previous,aspect);
	const pinned=new Set(graph.nodes.filter(n=>previous.has(n.id)&&(n.kind==='task'||previous.get(n.id)?.parentId===n.parent)).map(n=>n.id));
	const retained=new Map([...positions].filter(([id])=>pinned.has(id)).map(([id,p])=>[id,{...p}]));
	for(let tick=0;tick<70;tick++) {const energy=stepGraphLayout(positions,pinned);if(tick>20&&energy<.05)break;}
	for(const [id,p] of retained)positions.set(id,p);
	// Reserve retained bubbles first, including their below-bubble captions. New families must not
	// squeeze between pinned tasks or keep pushing one another around an occupied slot.
	const tasks=graph.nodes.filter(node=>node.kind==='task');
	const occupied=tasks.filter(node=>pinned.has(node.id)).map(node=>positions.get(node.id)!);
	for(const node of tasks.filter(node=>!pinned.has(node.id))) {
		const p=positions.get(node.id)!,x=p.x,y=p.y;
		const free=(x:number,y:number)=>occupied.every(other=>Math.abs(x-other.x)>=200 || Math.abs(y-other.y)>=p.radius+other.radius+90);
		if(!free(x,y)) {
			search: for(let ring=1;ring<=graph.nodes.length;ring++) {
				for(let dy=-ring;dy<=ring;dy++) for(let dx=-ring;dx<=ring;dx++) {
					if(Math.max(Math.abs(dx),Math.abs(dy))!==ring)continue;
					const candidateX=x+dx*50,candidateY=y+dy*50;
					if(free(candidateX,candidateY)) {p.x=candidateX;p.y=candidateY;break search;}
				}
			}
		}
		p.anchorX=p.x;p.anchorY=p.y;
		occupied.push(p);
	}
	placeGraphCrewOnRims(graph, positions);
	return positions;
}
/** Cubic ease-out, also used for actual live worker reassignment, never CSS-only edge teleporting. */
export function interpolateGraphPositions(from:Map<string,GraphPosition>,to:Map<string,GraphPosition>,progress:number):Map<string,GraphPosition> {
	const amount=1-Math.pow(1-Math.max(0,Math.min(1,progress)),3);
	return new Map([...to].map(([id,p])=>{const start=from.get(id);return [id,progress>=1 ? {...p} : start?{...p,x:start.x+(p.x-start.x)*amount,y:start.y+(p.y-start.y)*amount}:{...p,y:p.y+(1-amount)*12}];}));
}
