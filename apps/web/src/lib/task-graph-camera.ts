import type { GraphPosition, TaskGraph } from './task-graph.ts';

export type GraphCamera = { x:number; y:number; zoom:number };
export const GRAPH_CAMERA_KEY = 'task-graph.camera.v1:';
export function loadGraphCamera(scope:string, storage?:Pick<Storage,'getItem'>):GraphCamera | null {
	try {
		const camera = JSON.parse(storage?.getItem(GRAPH_CAMERA_KEY+encodeURIComponent(scope)) ?? 'null');
		return camera && [camera.x,camera.y,camera.zoom].every(Number.isFinite) && camera.zoom >= 0.08 && camera.zoom <= 4 ? camera : null;
	} catch { return null; }
}
export function saveGraphCamera(scope:string, camera:GraphCamera, storage?:Pick<Storage,'setItem'>):void {
	try { storage?.setItem(GRAPH_CAMERA_KEY+encodeURIComponent(scope),JSON.stringify(camera)); } catch { /* Optional device preference. */ }
}
export function fitGraphCamera(positions:Map<string,GraphPosition>,width:number,height:number):GraphCamera {
	if (!positions.size) return {x:0,y:0,zoom:1};
	const points=[...positions.values()];
	const left=Math.min(...points.map(p=>p.x-Math.max(80,p.radius)))-30, right=Math.max(...points.map(p=>p.x+Math.max(80,p.radius)))+30;
	const top=Math.min(...points.map(p=>p.y-p.radius))-48, bottom=Math.max(...points.map(p=>p.y+p.radius))+100;
	const padding=width<600 ? 24 : 48;
	return {x:(left+right)/2,y:(top+bottom)/2,zoom:Math.max(.08,Math.min(1.4,(width-padding*2)/(right-left),(height-padding*2)/(bottom-top)))};
}
export type GraphLabelBox = {x:number;y:number;width:number;height:number;text:string;lines:string[];scale:number};
export function boxesOverlap(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}):boolean {
	return a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
}
export function truncatedGraphTitle(title:string):string {return title.length>23 ? title.slice(0,22)+'…' : title;}
/** Two short lines, with the full title retained on the link and tooltip. */
export function graphTitleLines(title:string):string[] {
	const words=title.split(/\s+/), lines:string[]=[];
	let line='';
	for(const word of words) {
		if(line && (line+' '+word).length>24) {lines.push(line);line=word;} else line+=(line?' ':'')+word;
	}
	if(line)lines.push(line);
	return lines.slice(0,2).map((line,index)=>line.length>24 || (index===1 && lines.length>2) ? line.slice(0,23)+'…' : line);
}
/** Captions stay below their bubbles. IDs are always drawn separately, even below 60% zoom. */
export function placeGraphLabels(graph:TaskGraph,positions:Map<string,GraphPosition>,camera:GraphCamera,_width:number,_height:number):Map<string,GraphLabelBox> {
	const labels=new Map<string,GraphLabelBox>();
	const preferredScale=Math.max(1,.85/camera.zoom);
	for(const node of graph.nodes) {
		if(node.kind!=='task' || (camera.zoom<.6 && node.radius<=35))continue;
		const p=positions.get(node.id);if(!p)continue;
		const lines=graphTitleLines(node.title);
		labels.set(node.id,{x:p.x-80,y:p.y+p.radius+12+18*preferredScale,width:160,height:lines.length*16,text:node.title,lines,scale:1});
	}
	// Reserve every eligible title before enlarging any one of them. A long early title must not hide its neighbours.
	for(const [id,base] of labels) {
		const occupied=[...positions].filter(([key])=>key!==id).map(([,p])=>({x:p.x-p.radius-7,y:p.y-p.radius-7,width:p.radius*2+14,height:p.radius*2+14}));
		const otherLabels=[...labels].filter(([key])=>key!==id).map(([,box])=>box);
		if(camera.zoom<.6 && occupied.some(box=>boxesOverlap(base,box))) {labels.delete(id);continue;}
		for(let scale=preferredScale;scale>1;scale=Math.max(1,scale-.15)) {
			const box={...base,x:base.x+80-80*scale,width:160*scale,height:base.lines.length*16*scale,scale};
			if(![...occupied,...otherLabels].some(other=>boxesOverlap(box,other))) {labels.set(id,box);break;}
		}
	}
	return labels;
}
