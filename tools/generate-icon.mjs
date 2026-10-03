import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);};
const width=32;const raw=Buffer.alloc((width*4+1)*width);
for(let y=0;y<width;y++)for(let x=0;x<width;x++){const offset=y*(width*4+1)+1+x*4;const ink=x>6&&x<25&&y>6&&y<25&&((x<11)||(y<11)||(y>14&&y<19));raw.set(ink?[126,213,182,255]:[29,39,35,255],offset);}
const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(width,4);header[8]=8;header[9]=6;
await writeFile(new URL('../apps/desktop/icon.png',import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
console.log('Generated actual 32x32 RGBA PNG tray icon.');
