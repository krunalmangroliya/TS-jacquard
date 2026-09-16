import type { DesignRecord, EditorAction } from '../../../packages/app-model/src/index';
import type { Face, MachineProfile, RenderReport, Vec2 } from '../../../packages/core/src/types';
import type {EditorDocumentPatch} from './editor-patch';

export type EditorRequest =
  | { type:'init'; requestId:number; document:DesignRecord; profile:MachineProfile; previewWidth?:number; preparedFaces?:Face[] }
  | { type:'action'; requestId:number; action:EditorAction; profile?:MachineProfile }
  | { type:'undo'|'redo'; requestId:number }
  | { type:'render'; requestId:number; profile?:MachineProfile; previewWidth?:number }
  | { type:'export'; requestId:number; format:'bmp'|'png'|'json' }
  | { type:'snapshot'; requestId:number }
  | { type:'flush'; requestId:number }
  | { type:'recovery'; requestId:number; expectedSequence:number; pending:EditorAction[] }
  | { type:'hitFace'; requestId:number; point:Vec2 }
  | { type:'ack'; requestId:number; revision:number; version:number; updatedAt:string };

export interface EditorRender {
  grid:Uint8Array; changedPixelsMask:Uint8Array;
  widthPx:number; heightPx:number; widthIn:number; heightIn:number; epi:number; ppi:number;
  preview:boolean; renderMs:number; report:Omit<RenderReport,'changedPixelsMask'>;
  /** Exact full-resolution source counts for a raster master, never preview estimates. */
  sourceColorPixelCounts?:number[];
}
export interface EditorGeometry { paths:Record<string,Vec2[]>; faces:Face[] }
export interface EditorState {
  type:'ready'|'state'; requestId:number; document:DesignRecord; editSequence:number;
  canUndo:boolean; canRedo:boolean; warnings:string[]; render:EditorRender;
  /** Sent on init and geometry/visibility changes; retain the prior value on styling/fill-only replies. */
  geometry?:EditorGeometry;
  stats:{ nodes:number; edges:number; faces:number; objects:number };
}
export interface EditorCommit extends Omit<EditorState,'type'|'render'|'geometry'|'document'> {type:'committed';geometryChanged:boolean;patch:EditorDocumentPatch}
export interface EditorSettlement extends Omit<EditorState,'type'|'document'> {type:'settled';patch:EditorDocumentPatch}
export type EditorReply = EditorState | EditorCommit | EditorSettlement
  | {type:'flushed';requestId:number}
  | { type:'export'; requestId:number; format:'bmp'|'png'|'json'; mime:string; filename:string; bytes:Uint8Array }
  | { type:'snapshot'; requestId:number; document:DesignRecord }
  | { type:'hitFace'; requestId:number; faceId:string|null; ref?:Vec2; colorIndex?:number|null }
  | { type:'ack'; requestId:number }
  | { type:'error'; requestId:number; message:string };
