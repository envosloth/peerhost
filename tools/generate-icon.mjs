// Rasterizes the PeerHost mark (same geometry as the inline SVG in apps/desktop/index.html) to an RGBA PNG.
// Pure Node: signed-distance shapes with 4×4 supersampling. Run: node tools/generate-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};

// Geometry in a 64-unit box.
const roundRect=(x,y,cx,cy,hw,hh,r)=>{const qx=Math.abs(x-cx)-hw+r,qy=Math.abs(y-cy)-hh+r;return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;};
const segment=(x,y,ax,ay,bx,by)=>{const px=x-ax,py=y-ay,dx=bx-ax,dy=by-ay;const t=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy)));return Math.hypot(px-dx*t,py-dy*t);};
const halfRing=(x,y,cx,cy,r)=>x>=cx?Math.abs(Math.hypot(x-cx,y-cy)-r):Infinity;
const STROKE=3.6;
// "P" whose bowl is a link, plus the peer node it hands off to.
const glyph=(x,y)=>Math.min(segment(x,y,22,17,22,47),segment(x,y,22,17,30,17),segment(x,y,22,39,30,39),halfRing(x,y,30,28,11))-STROKE;
const node=(x,y)=>Math.hypot(x-45.5,y-45.5)-5;
const tile=(x,y)=>roundRect(x,y,32,32,30,30,15);
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const over=(dst,src,a)=>{const out=dst[3]+a*(1-dst[3]);if(out<=0)return [0,0,0,0];return [...[0,1,2].map(i=>(src[i]*a+dst[i]*dst[3]*(1-a))/out),out];};

function shade(x,y){
  let px=[0,0,0,0];
  if(tile(x,y)<=0){
    const t=(x+y)/128; // diagonal gradient, lit from top-left
    px=over(px,mix([104,240,205],[24,140,150],t),1);
    const sheen=Math.max(0,1-Math.hypot(x-18,y-12)/34)*0.28; // soft skeuomorphic highlight
    px=over(px,[255,255,255],sheen);
    if(tile(x,y)>-1.6)px=over(px,y<32?[255,255,255]:[8,60,66],0.35); // bevel rim
  }
  if(glyph(x-0.9,y-1.4)<=0&&tile(x,y)<=0)px=over(px,[6,52,58],0.35); // inner drop shadow
  if(node(x-0.9,y-1.4)<=0&&tile(x,y)<=0)px=over(px,[6,52,58],0.35);
  if(glyph(x,y)<=0)px=over(px,[250,255,253],1);
  if(node(x,y)<=0)px=over(px,[255,214,102],1);
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
// icon.png: window + tray (main resizes for the tray). icon-256.png: Linux launcher.
// Windows .ico: a directory of PNG-encoded images (supported since Vista), one per size the shell asks for.
function ico(images){
  const head=Buffer.alloc(6);head.writeUInt16LE(0,0);head.writeUInt16LE(1,2);head.writeUInt16LE(images.length,4);
  let offset=6+16*images.length;
  const entries=images.map(([size,png])=>{const e=Buffer.alloc(16);e[0]=size%256;e[1]=size%256;e.writeUInt16LE(1,4);e.writeUInt16LE(32,6);e.writeUInt32LE(png.length,8);e.writeUInt32LE(offset,12);offset+=png.length;return e;});
  return Buffer.concat([head,...entries,...images.map(([,png])=>png)]);
}
const large=render(256);
// icon.png: window + tray (main resizes for the tray). icon-256.png: Linux launcher. icon.ico: Windows shortcut.
for(const file of ['../apps/desktop/icon.png','../apps/desktop/icon-256.png'])await writeFile(new URL(file,import.meta.url),large);
await writeFile(new URL('../apps/desktop/icon.ico',import.meta.url),ico([16,24,32,48,64].map(size=>[size,render(size)]).concat([[256,large]])));
console.log('Generated PNG app/tray/launcher icons and a 16–256 px Windows icon.');
