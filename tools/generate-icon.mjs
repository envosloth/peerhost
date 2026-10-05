// Rasterizes the Seed Hosting mark (same geometry as the inline SVG in apps/desktop/index.html):
// a sprout — two leaves on a stem rising from a seed — on a dark graphite tile. Pure Node, 4×4 supersampling.
// Writes icon.png (window + tray), icon-256.png (Linux launcher) and icon.ico (Windows, 16–256 px).
// Run: node tools/generate-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};

// --- Geometry (64-unit box), shared with the SVG mark. ---
export const LEAF_LEFT='M30.6 35.5C23.4 35.8 16.6 30.4 16.2 21.6C24.4 21.2 30.8 26.8 30.6 35.5Z';
export const LEAF_RIGHT='M33.4 30.5C33.2 21.4 40.2 14.4 49.5 14.6C49.6 23.8 42.6 30.6 33.4 30.5Z';
export const STEM='M32 49.5L32 31', STEM_WIDTH=4.4;
export const SEED={cx:32,cy:50,r:4.6};

// Flattens an absolute M/C/L/Z path into polylines.
function flatten(d){
  const tokens=d.match(/[MCLZ]|-?\d*\.?\d+/g);const lines=[];let line=[];let i=0;let cmd='';let x=0,y=0;
  const num=()=>Number(tokens[i++]);
  while(i<tokens.length){
    if(/[MCLZ]/.test(tokens[i]))cmd=tokens[i++];
    if(cmd==='M'){if(line.length)lines.push(line);x=num();y=num();line=[[x,y]];cmd='L';}
    else if(cmd==='L'){x=num();y=num();line.push([x,y]);}
    else if(cmd==='C'){const p=[[x,y],[num(),num()],[num(),num()],[num(),num()]];for(let t=1;t<=24;t++){const u=t/24,v=1-u;line.push([0,1].map(k=>v*v*v*p[0][k]+3*v*v*u*p[1][k]+3*v*u*u*p[2][k]+u*u*u*p[3][k]));}[x,y]=p[3];}
    else if(cmd==='Z'){line.push(line[0]);lines.push(line);line=[];}
  }
  if(line.length)lines.push(line);
  return lines;
}
const inside=(polys,x,y)=>{let hit=false;for(const p of polys)for(let a=0,b=p.length-1;a<p.length;b=a++){const [xa,ya]=p[a],[xb,yb]=p[b];if((ya>y)!==(yb>y)&&x<(xb-xa)*(y-ya)/(yb-ya)+xa)hit=!hit;}return hit;};
const segment=(x,y,[ax,ay],[bx,by])=>{const px=x-ax,py=y-ay,dx=bx-ax,dy=by-ay;const t=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy||1)));return Math.hypot(px-dx*t,py-dy*t);};
const nearLine=(lines,x,y,w)=>lines.some(l=>l.some((p,k)=>k>0&&segment(x,y,l[k-1],p)<=w/2));
const roundRect=(x,y,cx,cy,hw,hh,r)=>{const qx=Math.abs(x-cx)-hw+r,qy=Math.abs(y-cy)-hh+r;return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;};
const leafLeft=flatten(LEAF_LEFT), leafRight=flatten(LEAF_RIGHT), stem=flatten(STEM);
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const over=(dst,src,a)=>{const out=dst[3]+a*(1-dst[3]);if(out<=0)return [0,0,0,0];return [...[0,1,2].map(i=>(src[i]*a+dst[i]*dst[3]*(1-a))/out),out];};

// Default "sprout" accent: leaves #6ee7a0 → #22b26b (top-left to bottom), stem #22b26b, seed #effff5.
const A1=[110,231,160], A2=[34,178,107];
function shade(x,y){
  let px=[0,0,0,0];
  const tile=roundRect(x,y,32,32,30,30,16);
  if(tile<=0){
    px=over(px,mix([31,38,48],[11,14,19],(x+y)/128),1);
    px=over(px,A1,Math.max(0,1-Math.hypot(x-32,y-30)/22)*0.22); // soft accent glow
    if(tile>-1)px=over(px,[255,255,255],0.08); // crisp rim
  }
  if(nearLine(stem,x,y,STEM_WIDTH))px=over(px,A2,1);
  const leaf=(x,y)=>mix(A1,A2,Math.max(0,Math.min(1,(0.35*(x-16)+(y-14))/ (0.35*34+22))));
  if(inside(leafLeft,x,y)||inside(leafRight,x,y))px=over(px,leaf(x,y),1);
  if(Math.hypot(x-SEED.cx,y-SEED.cy)<=SEED.r)px=over(px,[239,255,245],1);
  return px;
}

function render(size){
  const raw=Buffer.alloc((size*4+1)*size);const S=4;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let acc=[0,0,0,0];
    for(let sy=0;sy<S;sy++)for(let sx=0;sx<S;sx++){const p=shade((x+(sx+.5)/S)*64/size,(y+(sy+.5)/S)*64/size);acc=acc.map((v,i)=>v+(i<3?p[i]*p[3]:p[3]));}
    const a=acc[3]/(S*S);const o=y*(size*4+1)+1+x*4;
    raw.set(a>0?[...[0,1,2].map(i=>Math.round(acc[i]/acc[3])),Math.round(a*255)]:[0,0,0,0],o);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// Windows .ico: a directory of PNG-encoded images (supported since Vista), one per size the shell asks for.
function ico(images){
  const head=Buffer.alloc(6);head.writeUInt16LE(0,0);head.writeUInt16LE(1,2);head.writeUInt16LE(images.length,4);
  let offset=6+16*images.length;
  const entries=images.map(([size,png])=>{const e=Buffer.alloc(16);e[0]=size%256;e[1]=size%256;e.writeUInt16LE(1,4);e.writeUInt16LE(32,6);e.writeUInt32LE(png.length,8);e.writeUInt32LE(offset,12);offset+=png.length;return e;});
  return Buffer.concat([head,...entries,...images.map(([,png])=>png)]);
}
const large=render(256);
for(const file of ['../apps/desktop/icon.png','../apps/desktop/icon-256.png'])await writeFile(new URL(file,import.meta.url),large);
await writeFile(new URL('../apps/desktop/icon.ico',import.meta.url),ico([16,24,32,48,64].map(size=>[size,render(size)]).concat([[256,large]])));
console.log('Generated Seed Hosting PNG app/tray/launcher icons and a 16–256 px Windows icon.');
