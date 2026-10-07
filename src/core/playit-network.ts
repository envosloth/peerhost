import {lookup, resolveSrv} from 'node:dns/promises';
import {connect, isIPv4} from 'node:net';
const allowed = new Set(['/v1/agents/rundata','/v1/tunnels/list','/tunnels/create']);
export class PlayitApiRefusal extends Error { readonly definitiveRefusal = true; }
export async function playitApi(key:string, route:string, payload:unknown={}) {
  if (!allowed.has(route)) throw new Error('Invalid playit route');
  try {
    const response=await fetch('https://api.playit.gg'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Agent-Key '+key},body:JSON.stringify(payload)});
    if(!response.ok || !response.body)throw Error();
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1024*1024)throw Error();chunks.push(r.value);}}finally{await reader.cancel();}
    const result=JSON.parse(Buffer.concat(chunks).toString());
    if(result.status==='fail'){
      const raw=typeof result.data==='string'?result.data:result.data?.type;
      const code=typeof raw==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(raw)&&!raw.includes(key)?raw:'request refused';
      throw new PlayitApiRefusal(`playit refused the request (${code}). Check agent approval and your account's tunnel/port limits. No existing tunnel was changed.`);
    }
    if(result.status!=='success')throw Error();return result.data;
  }catch(error){if(error instanceof PlayitApiRefusal)throw error;throw new Error('playit request failed. The result may be uncertain; check connectivity, agent approval and your playit account before retrying.');}
}
export function publicIPv4(ip:string):boolean {
  if(!isIPv4(ip))return false;const [a=0,b=0]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
}
const vi=(n:number)=>{const out:number[]=[];do{let b=n&127;n>>>=7;if(n)b|=128;out.push(b);}while(n);return Buffer.from(out);};
function readVi(b:Buffer, offset:number):[number,number]|null {let n=0;for(let i=0;i<5;i++){if(offset+i>=b.length)return null;const v=b[offset+i]!;n|=(v&127)<<(7*i);if(!(v&128))return [n,offset+i+1];}throw Error();}
const PLAYIT_HOST=/^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/;
function timeout(ms:number):Promise<never>{return new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('timeout')),ms);t.unref();});}
/** The port a Minecraft client actually dials: the `_minecraft._tcp` SRV target when published, else the typed port. */
async function playerPort(host:string,fallback:number):Promise<number>{
  try{
    const records=await Promise.race([resolveSrv('_minecraft._tcp.'+host),timeout(5000)]);
    const ports=records.map(r=>r.port).filter(p=>Number.isInteger(p)&&p>0&&p<65536);
    if(ports.length)return Math.min(...ports);
  }catch{}
  return fallback;
}
export async function probeMinecraft(ep:{host:string;port:number;serverName:string}):Promise<boolean>{
  if(!PLAYIT_HOST.test(ep.host)||ep.serverName!==ep.host||!Number.isInteger(ep.port)||ep.port<1||ep.port>65535)return false;
  try {
    const records=await Promise.race([lookup(ep.host,{family:4,all:true}),timeout(5000)]);
    if(!records.length||records.some(x=>!publicIPv4(x.address)))return false;
    const port=await playerPort(ep.host,ep.port);
    // Connect to the validated numeric address, not a second DNS lookup.
    return await new Promise<boolean>(resolve=>{
      const socket=connect({host:records[0]!.address,port});let buf=Buffer.alloc(0);let done=false;
      const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok);};
      const timer=setTimeout(()=>finish(false),8000);
      socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
      socket.on('connect',()=>{const name=Buffer.from(ep.serverName);const p=Buffer.alloc(2);p.writeUInt16BE(port);const body=Buffer.concat([vi(0),vi(776),vi(name.length),name,p,vi(1)]);socket.write(Buffer.concat([vi(body.length),body,Buffer.from([1,0])]));});
      socket.on('data',chunk=>{try{
        buf=Buffer.concat([buf,typeof chunk==='string'?Buffer.from(chunk):chunk]);if(buf.length>1024*1024)return finish(false);
        const frame=readVi(buf,0);if(!frame)return;if(frame[0]<1||frame[0]>1024*1024)return finish(false);if(buf.length<frame[1]+frame[0])return;
        const id=readVi(buf,frame[1]);if(!id||id[0]!==0)return finish(false);const len=readVi(buf,id[1]);if(!len||len[0]<1||len[1]+len[0]!==frame[1]+frame[0])return finish(false);
        const data=JSON.parse(buf.subarray(len[1],len[1]+len[0]).toString());finish(typeof data.version?.name==='string'&&Number.isInteger(data.version?.protocol)&&Number.isInteger(data.players?.online));
      }catch{finish(false);}});
    });
  }catch{return false;}
}
