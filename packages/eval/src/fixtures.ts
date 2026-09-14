import type { RasterInput, TraceParams } from '../../core/src/types';
export interface Fixture { name: string; raster: RasterInput; params: Partial<TraceParams>; minFaces: number; maxOpenEnds: number }
export function syntheticFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  function drawing(name: string, draw: (line: (points: number[][], closed?: boolean, width?: number) => void, circle: (x:number,y:number,r:number) => void) => void, minFaces: number, maxOpenEnds = 0, params: Partial<TraceParams> = {}) {
    const width=256, height=256, data=new Uint8Array(width*height).fill(255);
    function line(points:number[][],closed=false,stroke=3) {
      const count=points.length-(closed?0:1);
      for(let i=0;i<count;i++) {
        const a=points[i],b=points[(i+1)%points.length],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
        for(let y=Math.max(0,Math.floor(Math.min(a[1],b[1])-stroke));y<=Math.min(height-1,Math.ceil(Math.max(a[1],b[1])+stroke));y++) for(let x=Math.max(0,Math.floor(Math.min(a[0],b[0])-stroke));x<=Math.min(width-1,Math.ceil(Math.max(a[0],b[0])+stroke));x++) {
          const t=length?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/length)):0;
          if((x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2<=(stroke/2)**2)data[y*width+x]=0;
        }
      }
    }
    function circle(x:number,y:number,r:number) { const points=Array.from({length:96},(_,i)=>[x+r*Math.cos(2*Math.PI*i/96),y+r*Math.sin(2*Math.PI*i/96)]); line(points,true); }
    draw(line,circle);
    fixtures.push({name,raster:{width,height,data,channels:1},params:{minSpeckArea:0,gapClosePx:0,spurPrunePx:0,...params},minFaces,maxOpenEnds});
  }
  drawing('01-square',line=>line([[48,48],[208,48],[208,208],[48,208]],true),1);
  drawing('02-circle',(_,circle)=>circle(128,128,85),1);
  drawing('03-nested',line=>{line([[24,24],[232,24],[232,232],[24,232]],true);line([[80,80],[176,80],[176,176],[80,176]],true);},2);
  drawing('04-petals',(line,circle)=>{circle(128,128,18);for(let i=0;i<6;i++){const a=i*Math.PI/3,cx=128+57*Math.cos(a),cy=128+57*Math.sin(a);circle(cx,cy,22);}},7);
  drawing('05-shared-edge',line=>{line([[40,40],[216,40],[216,216],[40,216]],true);line([[128,40],[128,216]]);},2);
  drawing('06-crossing',line=>{line([[40,40],[216,40],[216,216],[40,216]],true);line([[40,128],[216,128]]);line([[128,40],[128,216]]);},4);
  drawing('07-small-details',(_,circle)=>{circle(128,128,90);circle(128,128,45);circle(52,128,4);circle(204,128,4);circle(128,52,4);circle(128,204,4);},6);
  drawing('08-gap',line=>line([[125,40],[40,40],[40,216],[216,216],[216,40],[131,40]]),1,0,{gapClosePx:10});
  drawing('09-repeat-cut',line=>{line([[-24,72],[70,72],[70,184],[-24,184]],true);line([[232,72],[326,72],[326,184],[232,184]],true);},1,4);
  drawing('10-leaf',line=>{line([[42,210],[50,120],[110,52],[208,36],[200,132],[142,194]],true);line([[42,210],[208,36]]);line([[122,126],[70,102]]);line([[122,126],[172,164]]);},2,4);
  return fixtures;
}
