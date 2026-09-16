import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { decodeBmp, decodePng, encodeBmp, rgbaToIndexed } from './image-codec';
import type { IndexedImage } from './types';

describe('exact textile image codecs',()=>{
  const image:IndexedImage={width:3,height:2,palette:[[0,0,128],[205,168,0],[237,0,140]],pixels:Uint8Array.from([0,1,2,2,1,0])};
  it('round trips odd-width indexed BMP with bottom-up rows, padding and independent read/pick',()=>{
    const bytes=encodeBmp(image,96,52),header=new DataView(bytes.buffer),decoded=decodeBmp(bytes);
    expect(header.getUint16(28,true)).toBe(8);expect(header.getInt32(38,true)).toBe(3780);expect(header.getInt32(42,true)).toBe(2047);
    expect(header.getUint32(2,true)).toBe(1078+4*2);expect([...bytes.slice(1078,1082)]).toEqual([2,1,0,0]);
    const rgb=(a:IndexedImage)=>[...a.pixels].map(i=>a.palette[i]);expect(rgb(decoded)).toEqual(rgb(image));expect(decoded.width).toBe(3);expect(decoded.height).toBe(2);
  });
  it('rejects missing palette indices, invalid density and truncated BMP instead of exporting corrupt artwork',()=>{
    expect(()=>encodeBmp({...image,pixels:Uint8Array.from([4,1,2,2,1,0])},96,52)).toThrow(/palette/);
    expect(()=>encodeBmp(image,0,52)).toThrow(/Read/);expect(()=>encodeBmp(image,Infinity,52)).toThrow(/Read/);
    const b=encodeBmp(image,96,52);expect(()=>decodeBmp(b.slice(0,b.length-1))).toThrow(/truncated/);
  });
  it('decodes filtered PNG samples without changing the original RGB values',async()=>{
    const p=new PNG({width:3,height:2});for(let i=0;i<6;i++){const rgb=image.palette[image.pixels[i]];p.data.set([...rgb,255],i*4);}
    for(const filterType of [0,1,2,3,4]){const png=PNG.sync.write(p,{filterType}),decoded=await decodePng(png),indexed=rgbaToIndexed(decoded);expect([...decoded.data]).toEqual([...p.data]);expect(indexed.originalColors).toBe(3);expect(indexed.palette).toEqual(image.palette);expect([...indexed.pixels]).toEqual([...image.pixels]);}
  });
  it('requires explicit color reduction and composites transparency over white',()=>{
    const data=new Uint8Array(257*4);for(let i=0;i<257;i++)data.set([i&255,i>>8,0,255],i*4);
    expect(()=>rgbaToIndexed({width:257,height:1,data})).toThrow(/257 colors/);
    const reduced=rgbaToIndexed({width:257,height:1,data},4);expect(reduced.palette.length).toBeLessThanOrEqual(4);expect(reduced.originalColors).toBe(257);
    const white=rgbaToIndexed({width:1,height:1,data:Uint8Array.from([12,40,99,0])});expect(white.palette).toEqual([[255,255,255]]);
  });
  it('validates PNG size before decompression',async()=>{
    const p=new PNG({width:1,height:1}),bytes=PNG.sync.write(p);bytes.writeUInt32BE(9000,16);
    await expect(decodePng(bytes)).rejects.toThrow(/8192/);
  });
  it('rejects corrupt density metadata instead of suggesting a silently altered physical size',async()=>{
    const p=new PNG({width:1,height:1}),png=PNG.sync.write(p),chunk=Buffer.alloc(21);
    chunk.writeUInt32BE(9,0);chunk.write('pHYs',4,'ascii');chunk.writeUInt32BE(11811,8);chunk.writeUInt32BE(11811,12);chunk[16]=1;
    // Deliberately stale/invalid CRC. Image pixels still have a valid zlib checksum.
    const damaged=Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]);
    await expect(decodePng(damaged)).rejects.toThrow(/pHYs checksum/);
  });
});
