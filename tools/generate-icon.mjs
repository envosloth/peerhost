// Rasterizes the Seed Hosting mark (same geometry as the inline SVG in apps/desktop/index.html):
// a golden seed with a white sprout on the accent tile. Pure Node, 4×4 supersampling.
// Writes icon.png (window + tray), icon-256.png (Linux launcher) and icon.ico (Windows, 16–256 px).
// Run: node tools/generate-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};

// --- Geometry (64-unit box), shared with the SVG mark. ---
export const SEED='M32 23C37.8 27.5 42.5 35.5 42.5 43.5C42.5 50.4 37.8 55.5 32 55.5C26.2 55.5 21.5 50.4 21.5 43.5C21.5 35.5 26.2 27.5 32 23Z';
// Seedling pair: pointed tips, a fuller upper edge and a flatter lower edge, each with a fine light midrib.
export const LEAF_RIGHT='M33 15.5C35.5 10 41.5 6.8 48.5 8.5C46.2 14.6 40.5 17.8 33 15.5Z';
export const LEAF_LEFT='M32.3 17C29.6 12.6 24.6 10.3 19 11.5C21 16.4 26 18.6 32.3 17Z';
export const VEIN_RIGHT='M33.8 15C38.5 12.5 43.2 10.4 47.6 8.9', VEIN_LEFT='M31.5 16.6C27.8 14.7 23.6 12.9 19.8 11.8', VEIN_WIDTH=0.9;
export const STEM='M32 24C32 20.5 32.3 17.6 33 15.2', STEM_WIDTH=2.2;
export const HIGHLIGHT='M26.6 43.5C26.6 38.6 28.6 34.2 31 30.8', HIGHLIGHT_WIDTH=1.8;

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
const seed=flatten(SEED), leafRight=flatten(LEAF_RIGHT), leafLeft=flatten(LEAF_LEFT), veins=[...flatten(VEIN_RIGHT),...flatten(VEIN_LEFT)], stem=flatten(STEM), highlight=flatten(HIGHLIGHT);
// Position along a leaf from its base (0) to its tip (1), for the base-to-tip shading.
const along=(x,y,[bx,by],[tx,ty])=>Math.max(0,Math.min(1,((x-bx)*(tx-bx)+(y-by)*(ty-by))/((tx-bx)**2+(ty-by)**2)));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const over=(dst,src,a)=>{const out=dst[3]+a*(1-dst[3]);if(out<=0)return [0,0,0,0];return [...[0,1,2].map(i=>(src[i]*a+dst[i]*dst[3]*(1-a))/out),out];};

// Fixed brand colours (the mark does not follow the accent): deep forest tile, cream seed, green sprout.
function shade(x,y){
  let px=[0,0,0,0];
  const tile=roundRect(x,y,32,32,30,30,15);
  if(tile<=0){
    px=over(px,mix([30,62,46],[10,24,17],(x+y)/128),1);
    px=over(px,[255,255,255],Math.max(0,1-Math.hypot(x-16,y-10)/40)*0.07);
    if(tile>-1.1)px=over(px,[255,255,255],y<32?0.12:0.04); // crisp rim
    if(inside(seed,x,y-1.8))px=over(px,[0,0,0],0.35); // seed shadow
  }
  if(inside(seed,x,y)){
    px=over(px,mix([255,243,207],[226,184,102],(y-24)/31.5),1);
    if(nearLine(highlight,x,y,HIGHLIGHT_WIDTH))px=over(px,[255,255,255],0.55);
  }
  if(nearLine(stem,x,y,STEM_WIDTH))px=over(px,[69,194,127],1);
  if(inside(leafLeft,x,y))px=over(px,mix([39,154,93],[111,220,152],along(x,y,[32.3,17],[19,11.5])),1);
  if(inside(leafRight,x,y))px=over(px,mix([47,174,108],[142,240,179],along(x,y,[33,15.5],[48.5,8.5])),1);
  if((inside(leafLeft,x,y)||inside(leafRight,x,y))&&nearLine(veins,x,y,VEIN_WIDTH))px=over(px,[214,250,228],0.6);
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
