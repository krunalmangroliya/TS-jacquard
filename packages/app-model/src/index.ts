import type { Master, MachineProfile, Palette, RuleConfig, PixelOverride, SizeInput } from '../../core/src/types';
import type { Operation } from '../../core/src/ops';
export interface WorkspaceSettings { name:string; profiles:MachineProfile[]; defaultProfileId:string; defaultPalette:Palette }
export interface DesignRecord {
  id:string; kind:'master'|'size'; masterId?:string; baseMasterVersion?:number;
  name:string; tags:string[]; master:Master; profileId:string; sizeInput:SizeInput;
  rules:RuleConfig; pixelOverrides:PixelOverride[]; operations:Operation[];
  revision:number; createdAt:string; updatedAt:string;
}
export interface DesignSummary {
  id:string; kind:'master'|'size'; masterId?:string; name:string; tags:string[];
  version:number; revision:number; updatedAt:string; variantCount:number; thumbnailUrl?:string;
}
export interface VersionSummary { id:string; version:number; note:string; createdAt:string }
export interface ExportSummary { id:string; filename:string; widthPx:number; heightPx:number; createdAt:string; revision:number }
export type EditorAction =
  | {type:'operation';operation:Operation}
  | {type:'pixels';pixels:{x:number;y:number;colorIndex:number|null}[]}
  | {type:'rules';rules:RuleConfig}
  | {type:'size';sizeInput:SizeInput;profileId:string}
  | {type:'metadata';name:string;tags:string[]}
  | {type:'replace';master:Master;operations?:Operation[];baseMasterVersion?:number};
