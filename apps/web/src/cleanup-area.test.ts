import {describe,it,expect} from 'vitest';
import {cleanupAreaFromDrag,toolAvailable} from './DesignCanvas';
import type {DesignRecord} from '../../../packages/app-model/src/index';

describe('cleanup area selection',()=>{
  it('keeps the same image area when dragged in either direction on a nonsquare design',()=>{
    const a={x:100,y:60},b={x:350,y:180};
    const forward=cleanupAreaFromDrag(a,b,500,300);
    expect(forward).toMatchObject({x:.2,y:.2});
    expect(forward!.w).toBeCloseTo(.5);
    expect(forward!.h).toBeCloseTo(.4);
    expect(cleanupAreaFromDrag(b,a,500,300)).toEqual(forward);
    expect(forward!.x*1000).toBe(200);
    expect(forward!.y*600).toBe(120);
    expect(Math.round(forward!.w*1000)).toBe(500);
    expect(Math.round(forward!.h*600)).toBe(240);
  });

  it('clips a drag at image boundaries and ignores empty or entirely outside areas',()=>{
    expect(cleanupAreaFromDrag({x:25,y:10},{x:200,y:120},100,100)).toEqual({x:.25,y:.1,w:.75,h:.9});
    expect(cleanupAreaFromDrag({x:25,y:10},{x:25,y:50},100,100)).toBeUndefined();
    expect(cleanupAreaFromDrag({x:-40,y:10},{x:-10,y:50},100,100)).toBeUndefined();
  });

  it('offers area selection only on uploaded image sizes',()=>{
    const record=(kind:'size'|'master',raster:boolean)=>({kind,master:raster?{raster:{}}:{}} as DesignRecord);
    expect(toolAvailable('cleanup-area',record('size',true))).toBe(true);
    expect(toolAvailable('cleanup-area',record('master',true))).toBe(false);
    expect(toolAvailable('cleanup-area',record('size',false))).toBe(false);
    expect(toolAvailable('cleanup-area',record('master',false))).toBe(false);
  });
});
