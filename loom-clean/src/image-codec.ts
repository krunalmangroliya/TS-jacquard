import { MAX_SIDE, MAX_SOURCE_PIXELS, MAX_OUTPUT_PIXELS, type IndexedImage, type RGB } from './types';

export interface DecodedRGBA { width: number; height: number; data: Uint8Array; dpiX?: number; dpiY?: number }
export function checkSize(width: number, height: number, limit = MAX_SOURCE_PIXELS): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > limit)
    throw new Error(`Image must be 1–${MAX_SIDE} pixels per side and at most ${limit.toLocaleString()} pixels in total.`);
}
const bytesOf = (input: ArrayBuffer | Uint8Array): Uint8Array => input instanceof Uint8Array ? input : new Uint8Array(input);
const crcTable = Uint32Array.from({length:256},(_,value)=>{let c=value;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunkCRC(data:Uint8Array):number{let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}

/** Decode raw samples, deliberately avoiding display ICC conversion of indexed artwork. */
export async function decodePng(input: ArrayBuffer | Uint8Array): Promise<DecodedRGBA> {
  const b = bytesOf(input), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33 || ![137,80,78,71,13,10,26,10].every((n,i) => b[i] === n)) throw new Error('This is not a valid PNG file.');
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0, dpiX: number | undefined, dpiY: number | undefined;
  let palette = new Uint8Array(0), transparency = new Uint8Array(0), chunks: Uint8Array[] = [], ended = false;
  for (let o = 8; o + 12 <= b.length;) {
    const n = v.getUint32(o), kind = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (o + 12 + n > b.length) throw new Error('PNG contains a truncated chunk.');
    const data = b.subarray(o + 8, o + 8 + n);
    if (kind === 'IHDR') {
      if (width || n !== 13) throw new Error('Invalid PNG header.');
      width = v.getUint32(o + 8); height = v.getUint32(o + 12); depth = data[8]; color = data[9]; interlace = data[12];
      checkSize(width, height);
      if (data[10] || data[11]) throw new Error('Unsupported PNG compression or filter.');
    } else if (kind === 'PLTE') palette = data.slice();
    else if (kind === 'tRNS') transparency = data.slice();
    else if (kind === 'pHYs' && n === 9 && data[8] === 1) {
      dpiX = v.getUint32(o + 8) * 0.0254; dpiY = v.getUint32(o + 12) * 0.0254;
      if (!dpiX || !dpiY) { dpiX = undefined; dpiY = undefined; }
    } else if (kind === 'IDAT') chunks.push(data);
    else if (kind === 'IEND') ended = true;
    if(chunkCRC(b.subarray(o+4,o+8+n))!==v.getUint32(o+8+n))throw new Error(`PNG ${kind} checksum is invalid. Re-save or replace the damaged image.`);
    if(kind==='IEND')break;
    o += 12 + n;
  }
  if (!width || !height || !ended || !chunks.length) throw new Error('Incomplete PNG image.');
  if (interlace !== 0) throw new Error('Please save this PNG without interlacing, then import it again.');
  const channels = ({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color];
  if (!channels || !([0,3].includes(color) ? [1,2,4,8].includes(depth) : depth === 8)) throw new Error('Please save the PNG in 8-bit RGB, RGBA or indexed color mode.');
  if (color === 3 && (!palette.length || palette.length % 3 || palette.length > 768)) throw new Error('Invalid PNG color palette.');
  const stride = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, Math.ceil(channels * depth / 8)), expected = (stride + 1) * height;
  const packed = new Uint8Array(chunks.reduce((n,c) => n + c.length, 0)); let p = 0;
  for (const c of chunks) { packed.set(c, p); p += c.length; } chunks = [];
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const filtered = new Uint8Array(expected); let used = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break;
      if (used + value.length > expected) { await reader.cancel(); throw new Error('PNG decompressed data exceeds its declared size.'); }
      filtered.set(value, used); used += value.length;
    }
  } catch (e) { throw new Error(`Cannot decompress PNG: ${e instanceof Error ? e.message : 'invalid data'}`); }
  if (used !== expected) throw new Error('PNG pixel data is truncated.');
  const raw = new Uint8Array(stride * height);
  const paeth = (a:number,c:number,d:number) => { const z=a+c-d,aa=Math.abs(z-a),cc=Math.abs(z-c),dd=Math.abs(z-d);return aa<=cc&&aa<=dd?a:cc<=dd?c:d; };
  for (let y = 0; y < height; y++) {
    const f = filtered[y * (stride + 1)]; if (f > 4) throw new Error('Invalid PNG filter.');
    for (let x = 0; x < stride; x++) { const i=y*stride+x, a=x>=bpp?raw[i-bpp]:0,c=y?raw[i-stride]:0,d=y&&x>=bpp?raw[i-stride-bpp]:0;
      raw[i] = filtered[y*(stride+1)+1+x] + (f===0?0:f===1?a:f===2?c:f===3?Math.floor((a+c)/2):paeth(a,c,d)); }
  }
  const rgba = new Uint8Array(width * height * 4), mask=(1<<depth)-1;
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const d=(y*width+x)*4, i=y*stride+x*channels, sample=depth===8?raw[i]:(raw[y*stride+Math.floor(x*depth/8)]>>(8-depth-(x*depth%8)))&mask;
    let r=0,g=0,bl=0,a=255;
    if(color===3){if(sample*3+2>=palette.length)throw new Error('PNG uses an invalid palette index.');r=palette[sample*3];g=palette[sample*3+1];bl=palette[sample*3+2];a=transparency[sample]??255;}
    else if(color===0){r=g=bl=Math.round(sample*255/mask);if(transparency.length===2&&sample===(transparency[0]<<8|transparency[1]))a=0;}
    else if(color===4){r=g=bl=raw[i];a=raw[i+1];}
    else {r=raw[i];g=raw[i+1];bl=raw[i+2];if(color===6)a=raw[i+3];else if(transparency.length===6&&r===(transparency[0]<<8|transparency[1])&&g===(transparency[2]<<8|transparency[3])&&bl===(transparency[4]<<8|transparency[5]))a=0;}
    rgba[d]=r;rgba[d+1]=g;rgba[d+2]=bl;rgba[d+3]=a;
  }
  return { width, height, data: rgba, dpiX, dpiY };
}

export function decodeBmp(input: ArrayBuffer | Uint8Array): IndexedImage {
  const b=bytesOf(input),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(b.length<54||b[0]!==66||b[1]!==77)throw new Error('This is not a valid BMP file.');
  const offset=v.getUint32(10,true),dib=v.getUint32(14,true),width=v.getInt32(18,true),signedHeight=v.getInt32(22,true),height=Math.abs(signedHeight),bits=v.getUint16(28,true);
  checkSize(width,height);
  if(dib<40||14+dib>b.length||v.getUint16(26,true)!==1||v.getUint32(30,true)!==0||![1,4,8,24,32].includes(bits))throw new Error('Use an uncompressed 1-, 4-, 8-, 24- or 32-bit BMP.');
  const stride=Math.ceil(width*bits/32)*4;
  if(offset<14+dib||offset+stride*height>b.length)throw new Error('BMP pixel data is truncated.');
  let table:RGB[]=[];
  if(bits<=8){const count=v.getUint32(46,true)||2**bits;if(count>2**bits||14+dib+count*4>offset)throw new Error('Invalid BMP palette.');for(let i=0;i<count;i++){let p=14+dib+i*4;table.push([b[p+2],b[p+1],b[p]]);}}
  const palette:RGB[]=[],lookup=new Map<number,number>(),pixels=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const row=offset+(signedHeight>0?height-y-1:y)*stride;let rgb:RGB;
    if(bits<=8){const shift=8-bits-(x*bits%8),index=(b[row+Math.floor(x*bits/8)]>>shift)&((1<<bits)-1);rgb=table[index];if(!rgb)throw new Error('BMP uses an invalid palette index.');}
    else{const p=row+x*(bits/8);rgb=[b[p+2],b[p+1],b[p]];}
    const key=rgb[0]<<16|rgb[1]<<8|rgb[2];let index=lookup.get(key);
    if(index===undefined){index=palette.length;if(index===256)throw new Error('BMP contains more than 256 colors. Save it as PNG to use explicit color reduction.');lookup.set(key,index);palette.push(rgb);}
    pixels[y*width+x]=index;
  }
  return {width,height,pixels,palette};
}

/** Original exact colors are retained unless the caller explicitly asks for reduction. */
export function rgbaToIndexed(input: DecodedRGBA, maxColors?: number): IndexedImage & { originalColors: number } {
  const {width,height,data}=input;checkSize(width,height);
  if(data.length!==width*height*4)throw new Error('Invalid RGBA pixel buffer.');
  if(maxColors!==undefined&&(!Number.isInteger(maxColors)||maxColors<2||maxColors>256))throw new Error('Choose between 2 and 256 colors.');
  const exact=new Map<number,number>(),palette:RGB[]=[],seen=new Uint8Array(1<<21),pixels=new Uint8Array(width*height);let originalColors=0;
  const rgbAt=(i:number):RGB=>{const a=data[i+3]/255;return [Math.round(data[i]*a+255*(1-a)),Math.round(data[i+1]*a+255*(1-a)),Math.round(data[i+2]*a+255*(1-a))];};
  for(let p=0;p<pixels.length;p++){
    const rgb=rgbAt(p*4),key=rgb[0]<<16|rgb[1]<<8|rgb[2],mask=1<<(key&7);
    if(!(seen[key>>3]&mask)){seen[key>>3]|=mask;originalColors++;}
    if(originalColors<=256){let index=exact.get(key);if(index===undefined){index=palette.length;exact.set(key,index);palette.push(rgb);}pixels[p]=index;}
  }
  if(originalColors<=256&&(maxColors===undefined||originalColors<=maxColors))return {width,height,pixels,palette,originalColors};
  if(maxColors===undefined)throw new Error(`This image has ${originalColors.toLocaleString()} colors. Choose a color-reduction limit before importing; the original colors have not been changed.`);
  const count=new Uint32Array(32768),r=new Float64Array(32768),g=new Float64Array(32768),b=new Float64Array(32768);
  for(let p=0;p<pixels.length;p++){const rgb=rgbAt(p*4),bin=(rgb[0]>>3)<<10|(rgb[1]>>3)<<5|(rgb[2]>>3);count[bin]++;r[bin]+=rgb[0];g[bin]+=rgb[1];b[bin]+=rgb[2];}
  type Sample={rgb:RGB;n:number};const samples:Sample[]=[];
  for(let i=0;i<count.length;i++)if(count[i])samples.push({rgb:[r[i]/count[i],g[i]/count[i],b[i]/count[i]],n:count[i]});
  const box=(s:Sample[])=>{const lo=[255,255,255],hi=[0,0,0];let n=0;for(const a of s){n+=a.n;for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],a.rgb[k]);hi[k]=Math.max(hi[k],a.rgb[k]);}}const spans=hi.map((v,i)=>v-lo[i]),axis=spans.indexOf(Math.max(...spans));return{s,n,axis,score:s.length>1?spans[axis]*Math.sqrt(n):0};};
  const boxes=[box(samples)];
  while(boxes.length<maxColors){let i=0;for(let j=1;j<boxes.length;j++)if(boxes[j].score>boxes[i].score)i=j;const a=boxes[i];if(!a.score)break;a.s.sort((u,v)=>u.rgb[a.axis]-v.rgb[a.axis]);let n=0,k=0;while(k<a.s.length-1&&n<a.n/2)n+=a.s[k++].n;boxes.splice(i,1,box(a.s.slice(0,k)),box(a.s.slice(k)));}
  const reduced:RGB[]=boxes.map(a=>{const rgb:RGB=[0,0,0];for(const s of a.s)for(let k=0;k<3;k++)rgb[k]+=s.rgb[k]*s.n;return rgb.map(v=>Math.round(v/a.n)) as RGB;});
  const map=new Uint8Array(32768);
  for(let i=0;i<count.length;i++)if(count[i]){const rgb=[r[i]/count[i],g[i]/count[i],b[i]/count[i]];let best=Infinity;for(let k=0;k<reduced.length;k++){const dist=reduced[k].reduce((sum,v,c)=>sum+(v-rgb[c])**2,0);if(dist<best){best=dist;map[i]=k;}}}
  for(let p=0;p<pixels.length;p++){const rgb=rgbAt(p*4);pixels[p]=map[(rgb[0]>>3)<<10|(rgb[1]>>3)<<5|(rgb[2]>>3)];}
  return{width,height,pixels,palette:reduced,originalColors};
}

export function encodeBmp(image: IndexedImage, read: number, pick: number): Uint8Array {
  const{width,height,pixels,palette}=image;checkSize(width,height,MAX_OUTPUT_PIXELS);
  if(!Number.isFinite(read)||!Number.isFinite(pick)||read<=0||pick<=0||read>10000||pick>10000)throw new Error('Read and pick must be greater than 0 and at most 10,000.');
  if(palette.length<1||palette.length>256||pixels.length!==width*height||palette.some(rgb=>rgb.length!==3||rgb.some(n=>!Number.isInteger(n)||n<0||n>255)))throw new Error('Invalid indexed image.');
  for(const p of pixels)if(p>=palette.length)throw new Error('Pixel refers to a missing palette color.');
  const stride=Math.ceil(width/4)*4,offset=1078,b=new Uint8Array(offset+stride*height),v=new DataView(b.buffer);
  b[0]=66;b[1]=77;v.setUint32(2,b.length,true);v.setUint32(10,offset,true);v.setUint32(14,40,true);v.setInt32(18,width,true);v.setInt32(22,height,true);v.setUint16(26,1,true);v.setUint16(28,8,true);v.setUint32(34,stride*height,true);v.setInt32(38,Math.round(read/0.0254),true);v.setInt32(42,Math.round(pick/0.0254),true);v.setUint32(46,palette.length,true);
  palette.forEach((rgb,i)=>{b[54+i*4]=rgb[2];b[55+i*4]=rgb[1];b[56+i*4]=rgb[0];});
  for(let y=0;y<height;y++)b.set(pixels.subarray(y*width,(y+1)*width),offset+(height-1-y)*stride);
  return b;
}
