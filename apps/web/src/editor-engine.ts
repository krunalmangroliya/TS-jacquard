import type { DesignRecord, EditorAction } from '../../../packages/app-model/src/index';
import type { Face, FaceColor, Geometry, MachineProfile, Master } from '../../../packages/core/src/types';
import { applyOperation, validateOperation, type Operation } from '../../../packages/core/src/ops';
import { buildPlanarMap, faceAt, flattenEdge, resolveFaceColors, trackFaces } from '../../../packages/core/src/topology';
import { profileSchema, ruleSchema, validateMaster } from '../../../packages/core/src/schemas';
import { resolveSize } from '../../../packages/core/src/size';
import { render } from '../../../packages/core/src/render';
import { encodeBmp } from '../../../packages/core/src/bmp';
import { encodePng } from '../../../packages/core/src/png';
import type { EditorGeometry, EditorReply, EditorRequest, EditorState, EditorCommit } from './editor-protocol';
import type {EditorDocumentPatch} from './editor-patch';

const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const equal=(a:unknown,b:unknown)=>a===b||JSON.stringify(a)===JSON.stringify(b);
type Changes=Record<string,[unknown|null,unknown|null]>;
interface Delta {
  nodes:Changes; edges:Changes; faceColors:Changes; objects:Changes;
  objectOrder?:[string[],string[]]; master:Changes; document:Changes;
  operations?:{prefix:number;before:Operation[];after:Operation[]};
  /** Temporary only: retain authored colors until background topology can produce the ordinary compact color delta. */
  unsettledFaceColors?:Record<string,FaceColor>;
  geometryChanged:boolean; visibilityChanged:boolean;
}
interface HistoryItem { bytes:Uint8Array; geometryChanged:boolean; visibilityChanged:boolean }
const HISTORY_BYTES=64*1024*1024, HISTORY_ITEMS=100;
const encoder=new TextEncoder(),decoder=new TextDecoder();
function changes(before:Record<string,unknown>,after:Record<string,unknown>,omit=new Set<string>()):Changes {
  if(before===after)return {};
  const result:Changes={};for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(!omit.has(key)&&!equal(before[key],after[key]))result[key]=[before[key]??null,after[key]??null];return result;
}
function makeDelta(before:DesignRecord,after:DesignRecord,geometryChanged:boolean,visibilityChanged:boolean):Delta {
  const oldObjects=Object.fromEntries(before.master.objects.map(o=>[o.id,o])),newObjects=Object.fromEntries(after.master.objects.map(o=>[o.id,o]));
  const orderBefore=before.master.objects.map(o=>o.id),orderAfter=after.master.objects.map(o=>o.id);
  const delta:Delta={nodes:changes(before.master.geometry.nodes,after.master.geometry.nodes),edges:changes(before.master.geometry.edges,after.master.geometry.edges),faceColors:changes(before.master.geometry.faceColors,after.master.geometry.faceColors),objects:changes(oldObjects,newObjects),
    master:changes(before.master as unknown as Record<string,unknown>,after.master as unknown as Record<string,unknown>,new Set(['geometry','objects','version','createdAt','updatedAt'])),
    document:changes(before as unknown as Record<string,unknown>,after as unknown as Record<string,unknown>,new Set(['master','operations','revision','createdAt','updatedAt'])),geometryChanged,visibilityChanged};
  if(!equal(orderBefore,orderAfter))delta.objectOrder=[orderBefore,orderAfter];
  if(!equal(before.operations,after.operations)){let prefix=0;while(prefix<Math.min(before.operations.length,after.operations.length)&&equal(before.operations[prefix],after.operations[prefix]))prefix++;delta.operations={prefix,before:before.operations.slice(prefix),after:after.operations.slice(prefix)};}
  return delta;
}
function patchMap<T>(source:Record<string,T>,patch:Changes,direction:0|1):Record<string,T> {
  const result={...source};for(const [key,pair] of Object.entries(patch)){if(pair[direction]===null)delete result[key];else result[key]=pair[direction] as T;}return result;
}
function applyDelta(source:DesignRecord,delta:Delta,direction:0|1):DesignRecord {
  const objectMap=patchMap(Object.fromEntries(source.master.objects.map(o=>[o.id,o])),delta.objects,direction);
  const order=delta.objectOrder?.[direction]??source.master.objects.map(o=>o.id);
  const master={...patchMap(source.master as unknown as Record<string,unknown>,delta.master,direction),geometry:{
    nodes:patchMap(source.master.geometry.nodes,delta.nodes,direction),edges:patchMap(source.master.geometry.edges,delta.edges,direction),faceColors:patchMap(source.master.geometry.faceColors,delta.faceColors,direction)},objects:order.map(id=>objectMap[id])} as unknown as Master;
  const result={...patchMap(source as unknown as Record<string,unknown>,delta.document,direction),master} as unknown as DesignRecord;
  if(direction===0&&delta.unsettledFaceColors)master.geometry.faceColors=delta.unsettledFaceColors;
  if(delta.operations)result.operations=[...source.operations.slice(0,delta.operations.prefix),...(direction===0?delta.operations.before:delta.operations.after)];
  return result;
}
function forwardPatch(delta:Delta,direction:0|1):EditorDocumentPatch {
  const patch:EditorDocumentPatch={};
  for(const field of ['nodes','edges','faceColors','master','document'] as const){const pairs=Object.entries(delta[field]);if(pairs.length)(patch as Record<string,unknown>)[field]=Object.fromEntries(pairs.map(([id,pair])=>[id,pair[direction]]));}
  if(delta.objectOrder||Object.keys(delta.objects).length)patch.objects={changes:Object.fromEntries(Object.entries(delta.objects).map(([id,pair])=>[id,pair[direction]])) as NonNullable<EditorDocumentPatch['objects']>['changes'],...(delta.objectOrder?{order:delta.objectOrder[direction]}:{})};
  if(delta.operations)patch.operations={prefix:delta.operations.prefix,items:direction===0?delta.operations.before:delta.operations.after};
  if(direction===0&&delta.unsettledFaceColors){patch.replaceFaceColors=delta.unsettledFaceColors;delete patch.faceColors;}
  return patch;
}

/** Browser worker engine also exported for deterministic, DOM-free controller tests. */
export class EditorEngine {
  private document?:DesignRecord;
  private interactive=false;
  private interactivePatch:EditorDocumentPatch={};
  private topologyPending=false;
  private restoreFaceColors:'resolve'|'track-resolve'|undefined;
  private profile?:MachineProfile;
  private profiles=new Map<string,MachineProfile>();
  private previewWidth=1200;
  private editSequence=0;
  private past:HistoryItem[]=[];
  private future:HistoryItem[]=[];
  private fullFaces:Face[]=[];
  private visibleFaces:Face[]=[];
  private visibleGeometry?:Geometry;
  private geometry:EditorGeometry={paths:{},faces:[]};
  private geometryDirty=true;
  private topologyWarnings:string[]=[];
  private pendingWarnings:string[]=[];
  private visibleParents=new Map<string,string[]>();
  private lastRequestId=-1;

  private current():DesignRecord {if(!this.document||!this.profile)throw new Error('Open a design before editing');return this.document;}
  private rememberProfile(value:MachineProfile):void {const profile=profileSchema.parse(value);this.profile=profile;this.profiles=new Map(this.profiles).set(profile.id,profile);}
  private prepareGeometry(faces?:Face[],rebuildPaths=true):void {
    const document=this.current(),master=document.master;
    if(faces)this.fullFaces=faces;
    else {const topology=buildPlanarMap(master.geometry,master.bounds,master.repeat);this.fullFaces=topology.faces;this.topologyWarnings=topology.warnings;const resolved=resolveFaceColors(this.fullFaces,master.geometry.faceColors);document.master={...master,geometry:{...master.geometry,faceColors:resolved.faceColors}};this.topologyWarnings.push(...resolved.warnings);}
    const source=document.master,hidden=new Set(source.objects.filter(o=>o.hidden).flatMap(o=>o.edgeIds));
    this.visibleGeometry={...source.geometry,edges:Object.fromEntries(Object.entries(source.geometry.edges).filter(([id])=>!hidden.has(id)))};
    if(hidden.size){const topology=buildPlanarMap(this.visibleGeometry,source.bounds,source.repeat),tracked=trackFaces(this.fullFaces,source.geometry.faceColors,topology.faces);this.visibleFaces=tracked.faces;this.visibleGeometry.faceColors=tracked.faceColors;this.topologyWarnings=[...this.topologyWarnings,...topology.warnings,...tracked.warnings,'Hidden objects are omitted from the preview and export'];}
    else {this.visibleFaces=this.fullFaces;this.visibleGeometry.faceColors=source.geometry.faceColors;}
    this.visibleParents=new Map();
    if(hidden.size)for(const face of this.fullFaces){const visible=faceAt(this.visibleFaces,face.ref);if(visible){const ids=this.visibleParents.get(visible.id)??[];ids.push(face.id);this.visibleParents.set(visible.id,ids);}}
    if(rebuildPaths)this.geometry={paths:Object.fromEntries(Object.values(source.geometry.edges).map(edge=>[edge.id,flattenEdge(edge,source.geometry,0.25)])),faces:this.visibleFaces};
    else this.geometry={...this.geometry,faces:this.visibleFaces};
    this.geometryDirty=true;
  }
  private refreshAppearance():void {
    const master=this.current().master,hidden=new Set(master.objects.filter(o=>o.hidden).flatMap(o=>o.edgeIds));
    const edges=hidden.size?Object.fromEntries(Object.entries(master.geometry.edges).filter(([id])=>!hidden.has(id))):master.geometry.edges;
    if(!hidden.size){this.visibleGeometry={...master.geometry,edges};return;}
    const faceColors={...this.visibleGeometry!.faceColors};
    const fullById=new Map(this.fullFaces.map(face=>[face.id,face]));
    for(const face of this.visibleFaces){const parents=(this.visibleParents.get(face.id)??[]).map(id=>fullById.get(id)!).filter(Boolean).sort((a,b)=>b.areaDu-a.areaDu);const colored=parents.find(parent=>master.geometry.faceColors[parent.id]?.colorIndex!==null&&master.geometry.faceColors[parent.id]?.colorIndex!==undefined);faceColors[face.id]={colorIndex:colored?master.geometry.faceColors[colored.id].colorIndex:null,ref:face.ref};}
    this.visibleGeometry={...master.geometry,edges,faceColors};
  }
  private resolvedSize(forExport=false) {
    const document=this.current();return resolveSize(document.master.bounds,this.profile!,document.kind==='master'&&!forExport?{mode:'grid',widthPx:this.previewWidth,linkAspect:true}:document.sizeInput);
  }
  private rasterize(forExport=false) {
    const document=this.current(),size=this.resolvedSize(forExport),start=performance.now();
    const rules=document.kind==='master'&&!forExport?{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false}:document.rules;
    const result=render(this.visibleGeometry!,this.visibleFaces,document.master.bounds,document.master.palette,size.widthPx,size.heightPx,rules,document.kind==='size'?document.pixelOverrides:[],document.master.repeat);
    return {result,size,renderMs:performance.now()-start};
  }
  private state(type:'ready'|'state',requestId:number,warnings:string[]=[]):EditorState|EditorCommit {
    if(this.interactive)return {type:'committed',requestId,patch:this.interactivePatch,editSequence:this.editSequence,canUndo:!!this.past.length,canRedo:!!this.future.length,warnings,geometryChanged:this.topologyPending,stats:{nodes:Object.keys(this.current().master.geometry.nodes).length,edges:Object.keys(this.current().master.geometry.edges).length,faces:this.visibleFaces.filter(face=>face.outer!==null).length,objects:this.current().master.objects.length}};
    this.refreshAppearance();const {result,size,renderMs}=this.rasterize();const {changedPixelsMask,...report}=result.report;
    const reply:EditorState={type,requestId,document:this.current(),editSequence:this.editSequence,canUndo:!!this.past.length,canRedo:!!this.future.length,
      warnings:[...new Set([...warnings,...this.topologyWarnings,...size.warnings,...report.warnings])],
      render:{grid:result.grid,changedPixelsMask,...size,epi:this.profile!.epi,ppi:this.profile!.ppi,preview:this.current().kind==='master',renderMs,report},
      stats:{nodes:Object.keys(this.current().master.geometry.nodes).length,edges:Object.keys(this.current().master.geometry.edges).length,faces:this.visibleFaces.filter(face=>face.outer!==null).length,objects:this.current().master.objects.length}};
    if(this.geometryDirty){reply.geometry=this.geometry;this.geometryDirty=false;}return reply;
  }
  private validateDocument(document:DesignRecord):DesignRecord {
    if(!document||!['master','size'].includes(document.kind)||typeof document.id!=='string')throw new Error('Invalid design document');
    const master=validateMaster(document.master),rules=ruleSchema.parse(document.rules),operations=(document.operations??[]).map(validateOperation);
    if(!Array.isArray(document.tags)||document.tags.some(tag=>typeof tag!=='string')||typeof document.name!=='string')throw new Error('Invalid design metadata');
    const pixelOverrides=(document.pixelOverrides??[]).map(pixel=>{if(!Number.isInteger(pixel.x)||!Number.isInteger(pixel.y)||pixel.x<0||pixel.y<0||!Number.isInteger(pixel.colorIndex)||pixel.colorIndex<0||pixel.colorIndex>=master.palette.entries.length)throw new Error('Invalid pixel override');return {...pixel};});
    return {...document,master,rules,operations,pixelOverrides,tags:[...document.tags]};
  }
  private action(action:EditorAction):{geometryChanged:boolean;visibilityChanged:boolean;warnings:string[]} {
    const document=this.current();let geometryChanged=false,visibilityChanged=false,warnings:string[]=[];
    switch(action.type){
      case 'operation': {
        const operation=validateOperation(action.operation);
        // Palette-index deltas need the settled partition; the host flushes pending geometry first.
        if(this.topologyPending&&operation.t==='mergePalette')throw new Error('Finish pending geometry before merging palette colors');
        const hiddenBefore=new Set(document.master.objects.filter(object=>object.hidden).flatMap(object=>object.edgeIds));
        let applied;
        if(operation.t==='setFaceColor'&&document.master.objects.some(o=>o.hidden)){
          const visible=this.visibleFaces.find(face=>face.id===operation.faceId)??faceAt(this.visibleFaces,operation.ref);if(!visible)throw new Error('The selected visible face no longer exists');
          const members=this.visibleFaces.filter(face=>face.id===visible.id||(visible.seamGroup&&face.seamGroup===visible.seamGroup)),ids=new Set(members.flatMap(face=>this.visibleParents.get(face.id)??[]));
          let master=document.master;for(const face of this.fullFaces)if(ids.has(face.id))master=applyOperation(master,{...operation,faceId:face.id,ref:face.ref},{faces:this.fullFaces,assumeValidated:true}).master;
          applied={master,warnings:[],faces:this.fullFaces,geometryChanged:false};
        }else applied=applyOperation(document.master,operation,{faces:this.fullFaces,assumeValidated:true,deferTopology:this.interactive});
        document.master=applied.master;document.operations=[...document.operations,operation];geometryChanged=applied.geometryChanged;warnings=applied.warnings;
        const hiddenAfter=new Set(document.master.objects.filter(object=>object.hidden).flatMap(object=>object.edgeIds));
        visibilityChanged=hiddenBefore.size!==hiddenAfter.size||[...hiddenBefore].some(id=>!hiddenAfter.has(id));
        if(operation.t==='mergePalette'){
          const remap=(index:number)=>{const replaced=index===operation.sourceIndex?operation.targetIndex:index;return replaced>operation.sourceIndex?replaced-1:replaced;};
          document.pixelOverrides=document.pixelOverrides.map(pixel=>({...pixel,colorIndex:remap(pixel.colorIndex)}));
          if(document.rules.protectedColorIndices)document.rules={...document.rules,protectedColorIndices:[...new Set(document.rules.protectedColorIndices.map(remap))].sort((a,b)=>a-b)};
        }
        if(geometryChanged){if(this.interactive&&!applied.faces)this.topologyPending=true;else this.prepareGeometry(applied.faces);}else if(visibilityChanged)this.prepareGeometry(this.fullFaces,false);
        break;
      }
      case 'pixels': {
        if(document.kind!=='size')throw new Error('Pixel overrides are available only in a size variant');
        const size=this.resolvedSize(),pixels=new Map(document.pixelOverrides.map(pixel=>[`${pixel.x},${pixel.y}`,pixel]));
        for(const pixel of action.pixels){if(!Number.isInteger(pixel.x)||!Number.isInteger(pixel.y)||pixel.x<0||pixel.y<0||pixel.x>=size.widthPx||pixel.y>=size.heightPx)throw new Error('Pixel override lies outside this size');const key=`${pixel.x},${pixel.y}`;if(pixel.colorIndex===null)pixels.delete(key);else {if(!Number.isInteger(pixel.colorIndex)||pixel.colorIndex<0||pixel.colorIndex>=document.master.palette.entries.length)throw new Error('Pixel color is outside the palette');pixels.set(key,{x:pixel.x,y:pixel.y,colorIndex:pixel.colorIndex});}}
        document.pixelOverrides=[...pixels.values()].sort((a,b)=>a.y-b.y||a.x-b.x);break;
      }
      case 'rules':document.rules=ruleSchema.parse(action.rules);break;
      case 'size': {
        if(!action.profileId)throw new Error('Select a machine profile');
        const profile=this.profiles.get(action.profileId);if(!profile)throw new Error('The selected machine profile must accompany this size edit');this.profile=profile;
        const size=resolveSize(document.master.bounds,this.profile!,action.sizeInput);document.sizeInput=copy(action.sizeInput);document.profileId=action.profileId;
        const kept=document.pixelOverrides.filter(pixel=>pixel.x<size.widthPx&&pixel.y<size.heightPx);if(kept.length<document.pixelOverrides.length)warnings.push('Overrides outside the new grid were removed; undo restores them');document.pixelOverrides=kept;break;
      }
      case 'metadata':if(typeof action.name!=='string'||!action.name.trim()||!Array.isArray(action.tags)||action.tags.some(tag=>typeof tag!=='string'))throw new Error('A name and valid tags are required');document.name=action.name;document.tags=[...action.tags];if(document.kind==='master')document.master={...document.master,name:action.name,tags:[...action.tags]};break;
      case 'replace': {
        const master=validateMaster(action.master);document.master={...master,version:document.master.version,updatedAt:document.master.updatedAt};
        if(action.operations)document.operations=action.operations.map(validateOperation);
        if(action.baseMasterVersion!==undefined)document.baseMasterVersion=action.baseMasterVersion;
        if(document.kind==='master'){document.name=master.name;document.tags=[...master.tags];}
        geometryChanged=true;this.prepareGeometry();break;
      }
      default:throw new Error('Unsupported editor action');
    }
    return {geometryChanged,visibilityChanged,warnings};
  }
  handle(request:EditorRequest):EditorReply {
    const old={pendingWarnings:this.pendingWarnings,restoreFaceColors:this.restoreFaceColors,topologyPending:this.topologyPending,document:this.document,profile:this.profile,profiles:this.profiles,previewWidth:this.previewWidth,fullFaces:this.fullFaces,visibleFaces:this.visibleFaces,visibleGeometry:this.visibleGeometry,geometry:this.geometry,geometryDirty:this.geometryDirty,topologyWarnings:this.topologyWarnings,visibleParents:this.visibleParents,editSequence:this.editSequence,past:this.past,future:this.future};
    try {
      if(!Number.isSafeInteger(request.requestId))throw new Error('A numeric request ID is required');
      // FIFO processing plus request IDs prevents stale asynchronous output from replacing newer edits.
      if(request.requestId<=this.lastRequestId)throw new Error('A stale editor request was ignored');this.lastRequestId=request.requestId;
      if(request.type==='init'){
        this.profiles=new Map();this.rememberProfile(request.profile);this.previewWidth=Math.max(16,Math.min(2048,Math.round(request.previewWidth??1200)));this.document=this.validateDocument(request.document);this.resolvedSize();this.past=[];this.future=[];this.editSequence=0;this.topologyWarnings=[];this.pendingWarnings=[];this.topologyPending=false;this.restoreFaceColors=undefined;this.prepareGeometry(request.preparedFaces);return this.state('ready',request.requestId);
      }
      this.current();
      if(request.type==='ack'){
        if(!Number.isSafeInteger(request.revision)||request.revision<0||!Number.isSafeInteger(request.version)||request.version<1||typeof request.updatedAt!=='string')throw new Error('Invalid save acknowledgement');
        if(request.revision>=this.document!.revision)this.document={...this.document!,revision:request.revision,updatedAt:request.updatedAt,master:{...this.document!.master,version:request.version,updatedAt:request.updatedAt}};
        return {type:'ack',requestId:request.requestId};
      }
      if(request.type==='snapshot')return {type:'snapshot',requestId:request.requestId,document:this.current()};
      if(request.type==='hitFace'){this.refreshAppearance();const face=faceAt(this.visibleFaces,request.point);return {type:'hitFace',requestId:request.requestId,faceId:face?.id??null,ref:face?.ref,colorIndex:face?this.visibleGeometry!.faceColors[face.id]?.colorIndex:undefined};}
      if(request.type==='render'){if(request.profile)this.rememberProfile(request.profile);if(request.previewWidth!==undefined){if(!Number.isFinite(request.previewWidth))throw new Error('Invalid preview width');this.previewWidth=Math.max(16,Math.min(2048,Math.round(request.previewWidth)));}return this.state('state',request.requestId);}
      if(request.type==='export'){
        this.refreshAppearance();const document=this.current(),{result,size}=this.rasterize(true);let bytes:Uint8Array,mime:string;
        if(request.format==='bmp'){bytes=encodeBmp(result.grid,size.widthPx,size.heightPx,document.master.palette,this.profile!);mime='image/bmp';}
        else if(request.format==='png'){bytes=encodePng(result.grid,size.widthPx,size.heightPx,document.master.palette);mime='image/png';}
        else {const {changedPixelsMask,...report}=result.report;bytes=encoder.encode(JSON.stringify({application:'JDM',document,profile:this.profile,size,report},null,2));mime='application/json';}
        return {type:'export',requestId:request.requestId,format:request.format,mime,filename:`${document.name.replace(/[^a-zA-Z0-9_-]+/g,'-')||'design'}-${size.widthPx}x${size.heightPx}.${request.format}`,bytes};
      }
      if(request.type==='action'){
        if(request.profile)this.rememberProfile(request.profile);
        const before=this.current();this.document={...before};const change=this.action(request.action);const delta=makeDelta(before,this.current(),change.geometryChanged,change.visibilityChanged);
        if(this.interactive&&change.geometryChanged&&this.topologyPending){delta.unsettledFaceColors=before.master.geometry.faceColors;this.restoreFaceColors=undefined;}
        if(this.interactive)this.pendingWarnings=[...new Set([...this.pendingWarnings,...change.warnings])];
        const bytes=encoder.encode(JSON.stringify(delta));
        if(bytes.byteLength>HISTORY_BYTES)throw new Error('This single edit exceeds the 64 MB undo budget; use smaller edits or restore a smaller version');
        this.past=[...this.past,{bytes,geometryChanged:change.geometryChanged,visibilityChanged:change.visibilityChanged}];this.future=[];
        let total=this.past.reduce((sum,item)=>sum+item.bytes.byteLength,0);while(this.past.length>HISTORY_ITEMS||total>HISTORY_BYTES){total-=this.past[0].bytes.byteLength;this.past=this.past.slice(1);}
        if(this.interactive)this.interactivePatch=forwardPatch(delta,1);
        this.editSequence++;return this.state('state',request.requestId,change.warnings);
      }
      if(request.type==='undo'||request.type==='redo'){
        const backwards=request.type==='undo',item=backwards?this.past.at(-1):this.future[0];if(!item)return this.state('state',request.requestId);
        const delta=JSON.parse(decoder.decode(item.bytes)) as Delta;this.document=applyDelta(this.current(),delta,backwards?0:1);
        if(this.interactive)this.interactivePatch=forwardPatch(delta,backwards?0:1);
        this.profile=this.profiles.get(this.document.profileId)??this.profile;
        if(backwards){this.past=this.past.slice(0,-1);this.future=[item,...this.future];}else{this.future=this.future.slice(1);this.past=[...this.past,item];}
        if(item.geometryChanged){if(this.interactive){this.topologyPending=true;this.restoreFaceColors=backwards||!delta.unsettledFaceColors?'resolve':'track-resolve';}else this.prepareGeometry();}else if(item.visibilityChanged)this.prepareGeometry(this.fullFaces,false);
        this.editSequence++;return this.state('state',request.requestId);
      }
      throw new Error('Unsupported worker request');
    }catch(error){Object.assign(this,old);return {type:'error',requestId:request.requestId,message:error instanceof Error?error.message:String(error)};}
  }
  /** Cheap geometry acknowledgement. Exact faces/pixels settle in a separate cancellable worker. */
  handleInteractive(request:EditorRequest):EditorReply {this.interactive=true;this.interactivePatch={};try{return this.handle(request);}finally{this.interactive=false;}}
  get isTopologyPending():boolean{return this.topologyPending;}
  get sequence():number{return this.editSequence;}
  settlementInput(){return {document:this.current(),profile:this.profile!,previewWidth:this.previewWidth,previousFaces:this.fullFaces,topologyPending:this.topologyPending,geometryDirty:this.geometryDirty,restoreFaceColors:this.restoreFaceColors,warnings:[...new Set([...this.pendingWarnings,...(this.topologyPending?[]:this.topologyWarnings)])]};}
  derivedCache(){return {fullFaces:this.fullFaces,visibleFaces:this.visibleFaces,visibleGeometry:this.visibleGeometry!,geometry:this.geometry,topologyWarnings:this.topologyWarnings,visibleParents:this.visibleParents};}
  acceptDerived(state:EditorState,cache:ReturnType<EditorEngine['derivedCache']>):void {
    const last=this.past.at(-1);
    if(last){const delta=JSON.parse(decoder.decode(last.bytes)) as Delta;if(delta.unsettledFaceColors){
      delta.faceColors=changes(delta.unsettledFaceColors,state.document.master.geometry.faceColors);delete delta.unsettledFaceColors;
      this.past=[...this.past.slice(0,-1),{...last,bytes:encoder.encode(JSON.stringify(delta))}];
      let bytes=this.past.reduce((sum,item)=>sum+item.bytes.byteLength,0);while(bytes>HISTORY_BYTES&&this.past.length){bytes-=this.past[0].bytes.byteLength;this.past=this.past.slice(1);}
    }}
    const current=this.current();this.document={...state.document,revision:current.revision,updatedAt:current.updatedAt,master:{...state.document.master,version:current.master.version,updatedAt:current.master.updatedAt}};
    Object.assign(this,cache);this.topologyPending=false;this.restoreFaceColors=undefined;this.pendingWarnings=[];this.geometryDirty=false;
    state.document=this.document;state.editSequence=this.editSequence;state.canUndo=!!this.past.length;state.canRedo=!!this.future.length;
  }

}
