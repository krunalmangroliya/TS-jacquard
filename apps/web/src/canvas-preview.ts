import type { Edge, Face, Geometry, Master, Vec2 } from '../../../packages/core/src/types';

export interface Box { minX:number; minY:number; maxX:number; maxY:number }
export interface CanvasTransform { x:number; y:number; ax:number; ay:number; ratio:number; width:number; height:number; gridX:number; gridY:number }
export interface LiveEdit { kind:'node'|'handle'|'object'; nodeId?:string; edgeId?:string; segIndex?:number; key?:'c1'|'c2'; delta:Vec2; nodeIds:Set<string>; edgeIds:Set<string> }
interface SegmentShape { a:Vec2; b:Vec2; c1?:Vec2; c2?:Vec2 }
interface CachedEdge { id:string; path:Path2D; box:Box; segments:SegmentShape[] }
interface CachedFace { face:Face; path:Path2D; box:Box }
interface Attachment { edgeId:string; segment:number; t:number }
interface MovingFace { source:CachedFace; rings:{point:Vec2; attachment?:Attachment}[][]; rigid:boolean; path?:Path2D }
const emptyBox=():Box=>({minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
const include=(box:Box,p:Vec2)=>{box.minX=Math.min(box.minX,p.x);box.minY=Math.min(box.minY,p.y);box.maxX=Math.max(box.maxX,p.x);box.maxY=Math.max(box.maxY,p.y);};
const overlaps=(a:Box,b:Box)=>a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY;
const same=(a?:Vec2,b?:Vec2)=>a===b||!!(a&&b&&a.x===b.x&&a.y===b.y);
const shifted=(p:Vec2,d:Vec2):Vec2=>({x:p.x+d.x,y:p.y+d.y});
export function viewportBox(t:CanvasTransform,pad=12):Box{return{minX:(-t.x-pad)/t.ax,minY:(-t.y-pad)/t.ay,maxX:(t.width-t.x+pad)/t.ax,maxY:(t.height-t.y+pad)/t.ay};}
export class SpatialIndex<T>{
  private cells=new Map<string,T[]>(); private large:T[]=[];
  constructor(private size=96){}
  add(value:T,box:Box){const x0=Math.floor(box.minX/this.size),x1=Math.floor(box.maxX/this.size),y0=Math.floor(box.minY/this.size),y1=Math.floor(box.maxY/this.size);if((x1-x0+1)*(y1-y0+1)>256){this.large.push(value);return;}for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const key=`${x},${y}`,items=this.cells.get(key);if(items)items.push(value);else this.cells.set(key,[value]);}}
  query(box:Box):Set<T>{const found=new Set(this.large);for(let y=Math.floor(box.minY/this.size);y<=Math.floor(box.maxY/this.size);y++)for(let x=Math.floor(box.minX/this.size);x<=Math.floor(box.maxX/this.size);x++)for(const value of this.cells.get(`${x},${y}`)??[])found.add(value);return found;}
}
export function previewControlPoint(geometry:Geometry,edgeId:string,index:number,key:'c1'|'c2',edit?:LiveEdit):Vec2|undefined{
  const edge=geometry.edges[edgeId],point=edge.segments[index][key];if(!point||!edit)return point;const nodeId=edge.nodeIds[key==='c1'?index:index+1];if(edit.nodeIds.has(nodeId))return shifted(point,edit.delta);
  if(edit.kind!=='handle'||nodeId!==edit.nodeId)return point;if(edgeId===edit.edgeId&&index===edit.segIndex&&key===edit.key)return shifted(point,edit.delta);
  const node=geometry.nodes[nodeId];if(node.kind!=='smooth')return point;const selected=geometry.edges[edit.edgeId!]?.segments[edit.segIndex!]?.[edit.key!];if(!selected)return point;const dx=selected.x+edit.delta.x-node.p.x,dy=selected.y+edit.delta.y-node.p.y,length=Math.hypot(dx,dy),radius=Math.hypot(point.x-node.p.x,point.y-node.p.y);return length?{x:node.p.x-dx/length*radius,y:node.p.y-dy/length*radius}:point;
}
/** Sparse, temporary lookup view for another gesture before the queued model arrives.
 * It is never enumerated for persistence or sent to the core worker. */
export function previewMaster(master:Master,edit:LiveEdit):Master{
  const nodes=Object.create(master.geometry.nodes) as Geometry['nodes'],edges=Object.create(master.geometry.edges) as Geometry['edges'];
  for(const id of edit.nodeIds){const node=master.geometry.nodes[id];if(node)nodes[id]={...node,p:shifted(node.p,edit.delta)};}
  for(const id of edit.edgeIds){const edge=master.geometry.edges[id];if(!edge)continue;edges[id]={...edge,segments:edge.segments.map((segment,i)=>({...segment,c1:previewControlPoint(master.geometry,id,i,'c1',edit),c2:previewControlPoint(master.geometry,id,i,'c2',edit)}))};}
  return{...master,geometry:{...master.geometry,nodes,edges}};
}
function segments(edge:Edge,geometry:Geometry,edit?:LiveEdit):SegmentShape[]{
  return edge.segments.map((segment,i)=>{const aId=edge.nodeIds[i],bId=edge.nodeIds[i+1],moveA=!!edit?.nodeIds.has(aId),moveB=!!edit?.nodeIds.has(bId),a=geometry.nodes[aId].p,b=geometry.nodes[bId].p;
    const c1=previewControlPoint(geometry,edge.id,i,'c1',edit),c2=previewControlPoint(geometry,edge.id,i,'c2',edit);
    return{a:edit&&moveA?shifted(a,edit.delta):a,b:edit&&moveB?shifted(b,edit.delta):b,c1,c2};
  });
}
function edgePath(parts:SegmentShape[]):Path2D{const path=new Path2D();if(!parts.length)return path;path.moveTo(parts[0].a.x,parts[0].a.y);for(const part of parts){if(part.c1||part.c2){const c1=part.c1??part.a,c2=part.c2??part.b;path.bezierCurveTo(c1.x,c1.y,c2.x,c2.y,part.b.x,part.b.y);}else path.lineTo(part.b.x,part.b.y);}return path;}
function polygonPath(rings:Vec2[][]):Path2D{const path=new Path2D();for(const ring of rings){if(!ring.length)continue;path.moveTo(ring[0].x,ring[0].y);for(let i=1;i<ring.length;i++)path.lineTo(ring[i].x,ring[i].y);path.closePath();}return path;}
function at(s:SegmentShape,t:number):Vec2{if(!s.c1&&!s.c2)return{x:s.a.x+(s.b.x-s.a.x)*t,y:s.a.y+(s.b.y-s.a.y)*t};const u=1-t,c1=s.c1??s.a,c2=s.c2??s.b;return{x:u*u*u*s.a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*s.b.x,y:u*u*u*s.a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*s.b.y};}
export function designTransform(ctx:CanvasRenderingContext2D,t:CanvasTransform){ctx.setTransform(t.ratio*t.ax,0,0,t.ratio*t.ay,t.ratio*t.x,t.ratio*t.y);}
export function strokePath(ctx:CanvasRenderingContext2D,path:Path2D,edge:Edge,t:CanvasTransform,color:string){if(edge.strokeHidden||edge.width<=0)return;ctx.strokeStyle=color;ctx.lineCap='round';ctx.lineJoin='round';if(edge.widthMode==='design'){ctx.lineWidth=edge.width;ctx.stroke(path);}else{const output=new Path2D();output.addPath(path,new DOMMatrix([t.gridX,0,0,t.gridY,0,0]));ctx.save();ctx.scale(1/t.gridX,1/t.gridY);ctx.lineWidth=Math.max(1,edge.width);ctx.stroke(output);ctx.restore();}}
export class CanvasGeometryCache{
  groundId?:string;
  edges=new Map<string,CachedEdge>();faces=new Map<string,CachedFace>();nodeEdges=new Map<string,Set<string>>();edgeIndex=new SpatialIndex<string>();faceIndex=new SpatialIndex<string>();nodeIndex=new SpatialIndex<string>();owners=new Map<string,Master['objects'][number]>();
  constructor(public master:Master,faces:Face[]){
    for(const object of master.objects)for(const id of object.edgeIds)this.owners.set(id,object);
    for(const edge of Object.values(master.geometry.edges)){const parts=segments(edge,master.geometry),box=emptyBox();for(const part of parts){include(box,part.a);include(box,part.b);if(part.c1)include(box,part.c1);if(part.c2)include(box,part.c2);}const cached={id:edge.id,path:edgePath(parts),box,segments:parts};this.edges.set(edge.id,cached);this.edgeIndex.add(edge.id,box);for(const id of edge.nodeIds){const edges=this.nodeEdges.get(id);if(edges)edges.add(edge.id);else this.nodeEdges.set(id,new Set([edge.id]));}}
    for(const node of Object.values(master.geometry.nodes))this.nodeIndex.add(node.id,{minX:node.p.x,minY:node.p.y,maxX:node.p.x,maxY:node.p.y});
    for(const face of faces){if(!face.outer){this.groundId=face.id;continue;}const box=emptyBox();for(const point of face.outer)include(box,point);const cached={face,path:polygonPath([face.outer,...face.holes]),box};this.faces.set(face.id,cached);this.faceIndex.add(face.id,box);}
  }
  refreshAppearance(master:Master){if(master.objects!==this.master.objects){this.owners.clear();for(const object of master.objects)for(const id of object.edgeIds)this.owners.set(id,object);}this.master=master;}
  visibleEdges(box:Box){return [...this.edgeIndex.query(box)].filter(id=>overlaps(this.edges.get(id)!.box,box));}
  changedEdges(current:Geometry):Set<string>{const changed=new Set<string>();for(const [id,old]of this.edges){const edge=current.edges[id],before=this.master.geometry.edges[id];if(!edge||edge.nodeIds.length!==before.nodeIds.length||edge.segments.length!==before.segments.length){changed.add(id);continue;}if(edge.width!==before.width||edge.colorIndex!==before.colorIndex||edge.strokeHidden!==before.strokeHidden||edge.widthMode!==before.widthMode){changed.add(id);continue;}for(let i=0;i<edge.nodeIds.length;i++)if(!same(current.nodes[edge.nodeIds[i]]?.p,this.master.geometry.nodes[before.nodeIds[i]]?.p)){changed.add(id);break;}if(!changed.has(id))for(let i=0;i<old.segments.length;i++)if(!same(edge.segments[i].c1,before.segments[i].c1)||!same(edge.segments[i].c2,before.segments[i].c2)){changed.add(id);break;}}for(const id of Object.keys(current.edges))if(!this.edges.has(id))changed.add(id);return changed;}
  changedFaces(current:Geometry):Set<string>{const changed=new Set<string>();for(const id of this.faces.keys())if((current.faceColors[id]?.colorIndex??0)!==(this.master.geometry.faceColors[id]?.colorIndex??0))changed.add(id);if(this.groundId&&(current.faceColors[this.groundId]?.colorIndex??0)!==(this.master.geometry.faceColors[this.groundId]?.colorIndex??0))changed.add(this.groundId);return changed;}
}

/** Fast local visual deformation. It never changes persisted faces or exported pixels. */
export class GeometryPreview{
  readonly edgeIds:Set<string>; readonly nodeIds=new Set<string>(); readonly underlay:HTMLCanvasElement; readonly ink:HTMLCanvasElement;
  private movingFaces:MovingFace[]=[]; private rigidPaths=new Map<string,Path2D>(); private rigidInk:{path:Path2D;edge:Edge}[]=[]; private rigidFills=new Map<number,Path2D>(); readonly rigidSelection=new Path2D(); private currentPaths=new Map<string,Path2D>(); private color:(index:number)=>string;
  constructor(private cache:CanvasGeometryCache,private current:Master,private edit:LiveEdit|undefined,private t:CanvasTransform,base:HTMLCanvasElement,changed:Set<string>,exportColors=false,faceChanges=new Set<string>()){
    this.edgeIds=new Set(changed);if(edit)for(const id of edit.edgeIds)this.edgeIds.add(id);
    for(const id of this.edgeIds)for(const nodeId of current.geometry.edges[id]?.nodeIds??[])this.nodeIds.add(nodeId);
    this.color=index=>{const color=current.palette.entries[index]?.[exportColors?'exportRgb':'displayRgb']??current.palette.entries[0][exportColors?'exportRgb':'displayRgb'];return `rgb(${color[0]},${color[1]},${color[2]})`;};
    this.underlay=document.createElement('canvas');this.underlay.width=base.width;this.underlay.height=base.height;this.ink=document.createElement('canvas');this.ink.width=base.width;this.ink.height=base.height;
    const under=this.underlay.getContext('2d')!,ink=this.ink.getContext('2d')!;under.drawImage(base,0,0);
    const bounds=emptyBox(),faceIds=new Set([...faceChanges].filter(id=>cache.faces.has(id)));if(cache.groundId&&faceChanges.has(cache.groundId)){include(bounds,{x:0,y:0});include(bounds,{x:current.bounds.w,y:current.bounds.h});}
    type Sample={edgeId:string;segment:number;a:Vec2;b:Vec2;t0:number;t1:number};const samples=new SpatialIndex<Sample>(16);
    for(const id of this.edgeIds){const old=cache.edges.get(id),edge=current.geometry.edges[id];if(edge)this.currentPaths.set(id,edgePath(segments(edge,current.geometry)));if(!old)continue;include(bounds,{x:old.box.minX,y:old.box.minY});include(bounds,{x:old.box.maxX,y:old.box.maxY});
      // Appearance-only edits cannot deform a face; avoid sampling every curve for them.
      const moves=edit?.edgeIds.has(id)||!edge||old.segments.length!==edge.segments.length||old.segments.some((part,i)=>!same(part.a,current.geometry.nodes[edge.nodeIds[i]]?.p)||!same(part.b,current.geometry.nodes[edge.nodeIds[i+1]]?.p)||!same(part.c1,edge.segments[i].c1)||!same(part.c2,edge.segments[i].c2));if(!moves)continue;
      for(const faceId of cache.faceIndex.query(old.box))if(overlaps(cache.faces.get(faceId)!.box,old.box))faceIds.add(faceId);
      old.segments.forEach((segment,index)=>{
        // Adaptive samples retain each Bezier parameter for the preview deformation.
        const visit=(t0:number,a:Vec2,t1:number,b:Vec2,depth:number)=>{const mid=(t0+t1)/2,m=at(segment,mid),q1=at(segment,(3*t0+t1)/4),q3=at(segment,(t0+3*t1)/4),dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;const distance=(p:Vec2)=>{const k=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(length||1)));return(p.x-a.x-k*dx)**2+(p.y-a.y-k*dy)**2;};if(depth<14&&Math.max(distance(m),distance(q1),distance(q3))>.0016){visit(t0,a,mid,m,depth+1);visit(mid,m,t1,b,depth+1);}else samples.add({edgeId:id,segment:index,a,b,t0,t1},{minX:Math.min(a.x,b.x),minY:Math.min(a.y,b.y),maxX:Math.max(a.x,b.x),maxY:Math.max(a.y,b.y)});};visit(0,segment.a,1,segment.b,0);
      });
    }
    for(const id of faceIds){const source=cache.faces.get(id)!;let moved=faceChanges.has(id),rigid=edit?.kind==='object';const rings=[source.face.outer!,...source.face.holes].map(ring=>ring.map(point=>{let attachment:Attachment|undefined,best=.0225;for(const sample of samples.query({minX:point.x-.15,minY:point.y-.15,maxX:point.x+.15,maxY:point.y+.15})){const dx=sample.b.x-sample.a.x,dy=sample.b.y-sample.a.y,k=Math.max(0,Math.min(1,((point.x-sample.a.x)*dx+(point.y-sample.a.y)*dy)/(dx*dx+dy*dy||1))),distance=(point.x-sample.a.x-k*dx)**2+(point.y-sample.a.y-k*dy)**2;if(distance<best){best=distance;attachment={edgeId:sample.edgeId,segment:sample.segment,t:sample.t0+(sample.t1-sample.t0)*k};}}if(attachment)moved=true;if(!attachment||!edit?.edgeIds.has(attachment.edgeId)||!current.geometry.edges[attachment.edgeId]?.nodeIds.every(id=>edit.nodeIds.has(id)))rigid=false;return{point,attachment};}));if(moved){this.movingFaces.push({source,rings,rigid});include(bounds,{x:source.box.minX,y:source.box.minY});include(bounds,{x:source.box.maxX,y:source.box.maxY});}}
    if(!Number.isFinite(bounds.minX))return;
    const padX=96/t.ax,padY=96/t.ay,visible=viewportBox(t,96);bounds.minX=Math.max(bounds.minX-padX,visible.minX);bounds.maxX=Math.min(bounds.maxX+padX,visible.maxX);bounds.minY=Math.max(bounds.minY-padY,visible.minY);bounds.maxY=Math.min(bounds.maxY+padY,visible.maxY);
    const moving=new Set(this.movingFaces.map(face=>face.source.face.id));
    designTransform(under,t);under.save();under.beginPath();under.rect(0,0,cache.master.bounds.w,cache.master.bounds.h);under.clip();under.beginPath();under.rect(bounds.minX,bounds.minY,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY);under.clip();under.fillStyle=this.color(cache.groundId?current.geometry.faceColors[cache.groundId]?.colorIndex??0:0);under.fillRect(bounds.minX,bounds.minY,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY);
    for(const id of cache.faceIndex.query(bounds)){const face=cache.faces.get(id)!;if(moving.has(id)||!overlaps(face.box,bounds))continue;under.fillStyle=this.color(current.geometry.faceColors[id]?.colorIndex??0);under.fill(face.path,'evenodd');}under.restore();
    designTransform(ink,t);ink.save();ink.beginPath();ink.rect(0,0,cache.master.bounds.w,cache.master.bounds.h);ink.clip();ink.beginPath();ink.rect(bounds.minX,bounds.minY,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY);ink.clip();
    for(const id of cache.visibleEdges(bounds)){if(this.edgeIds.has(id)||cache.owners.get(id)?.hidden)continue;const edge=current.geometry.edges[id];if(edge)strokePath(ink,cache.edges.get(id)!.path,edge,t,this.color(edge.colorIndex??0));}ink.restore();
    const strokeGroups=new Map<string,{path:Path2D;edge:Edge}>();if(edit?.kind==='object')for(const id of edit.edgeIds){const edge=current.geometry.edges[id],path=this.currentPaths.get(id);if(!edge||!path||!edge.nodeIds.every(id=>edit.nodeIds.has(id)))continue;this.rigidPaths.set(id,path);this.rigidSelection.addPath(path);if(edge.strokeHidden||cache.owners.get(id)?.hidden)continue;const key=`${edge.colorIndex}:${edge.widthMode}:${edge.width}:${edge.z}`,group=strokeGroups.get(key)??{path:new Path2D(),edge};group.path.addPath(path);strokeGroups.set(key,group);}this.rigidInk=[...strokeGroups.values()];
    const initialShapes=new Map<string,SegmentShape[]>();for(const id of this.edgeIds){const edge=current.geometry.edges[id];if(edge)initialShapes.set(id,segments(edge,current.geometry));}for(const face of this.movingFaces)if(face.rigid){face.path=this.facePath(face,initialShapes);const color=current.geometry.faceColors[face.source.face.id]?.colorIndex??0,group=this.rigidFills.get(color)??new Path2D();group.addPath(face.path);this.rigidFills.set(color,group);}
  }
  private shapes(edit:LiveEdit|undefined){const shapes=new Map<string,SegmentShape[]>();for(const id of this.edgeIds){const edge=this.current.geometry.edges[id];if(edge&&!this.rigidPaths.has(id))shapes.set(id,segments(edge,this.current.geometry,edit));}return shapes;}
  private facePath(face:MovingFace,shapes:Map<string,SegmentShape[]>):Path2D{return polygonPath(face.rings.map(ring=>ring.map(vertex=>{const a=vertex.attachment,s=a&&shapes.get(a.edgeId)?.[a.segment];return s&&a?at(s,a.t):vertex.point;})));}
  draw(ctx:CanvasRenderingContext2D,edit=this.edit,exportColors=false){
    const t=this.t,colors=this.current.palette.entries;this.color=index=>{const c=colors[index]?.[exportColors?'exportRgb':'displayRgb']??colors[0][exportColors?'exportRgb':'displayRgb'];return`rgb(${c[0]},${c[1]},${c[2]})`;};
    ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(this.underlay,0,0);designTransform(ctx,t);ctx.save();ctx.beginPath();ctx.rect(0,0,this.current.bounds.w,this.current.bounds.h);ctx.clip();const shapes=this.shapes(edit);
    if(edit&&this.rigidFills.size){ctx.save();ctx.translate(edit.delta.x,edit.delta.y);for(const[color,path]of this.rigidFills){ctx.fillStyle=this.color(color);ctx.fill(path,'evenodd');}ctx.restore();}for(const face of this.movingFaces){if(face.rigid)continue;ctx.fillStyle=this.color(this.current.geometry.faceColors[face.source.face.id]?.colorIndex??0);ctx.fill(this.facePath(face,shapes),'evenodd');}
    ctx.restore();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(this.ink,0,0);designTransform(ctx,t);ctx.save();ctx.beginPath();ctx.rect(0,0,this.current.bounds.w,this.current.bounds.h);ctx.clip();
    if(edit&&this.rigidInk.length){ctx.save();ctx.translate(edit.delta.x,edit.delta.y);for(const group of this.rigidInk)strokePath(ctx,group.path,group.edge,t,this.color(group.edge.colorIndex??0));ctx.restore();}for(const[id,shape]of shapes){const edge=this.current.geometry.edges[id];if(edge&&!this.cache.owners.get(id)?.hidden)strokePath(ctx,edgePath(shape),edge,t,this.color(edge.colorIndex??0));}
    ctx.restore();return shapes;
  }
  path(id:string,edit?:LiveEdit){const edge=this.current.geometry.edges[id];return edge?edgePath(segments(edge,this.current.geometry,edit)):undefined;}
  isRigid(id:string){return this.rigidPaths.has(id);}
}

