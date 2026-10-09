import {lookup, resolveSrv} from 'node:dns/promises';
import {connect, isIPv4} from 'node:net';
const allowed = new Set(['/v1/agents/rundata','/v1/tunnels/list','/tunnels/create']);
export class PlayitApiRefusal extends Error { readonly definitiveRefusal = true; constructor(message:string, readonly code?:string) {super(message);} }
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
      throw new PlayitApiRefusal(`playit refused the request (${code}). Check agent approval and your account's tunnel/port limits. No existing tunnel was changed.`,code);
    }
    if(result.status!=='success')throw Error();return result.data;
  }catch(error){if(error instanceof PlayitApiRefusal)throw error;throw new Error('playit request failed. The result may be uncertain; check connectivity, agent approval and your playit account before retrying.');}
}
export function publicIPv4(ip:string):boolean {
  if(!isIPv4(ip))return false;const [a=0,b=0,c=0]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
const vi=(n:number)=>{const out:number[]=[];do{let b=n&127;n>>>=7;if(n)b|=128;out.push(b);}while(n);return Buffer.from(out);};
function readVi(b:Buffer, offset:number):[number,number]|null {let n=0;for(let i=0;i<5;i++){if(offset+i>=b.length)return null;const v=b[offset+i]!;n|=(v&127)<<(7*i);if(!(v&128))return [n,offset+i+1];}throw Error();}
const PLAYIT_HOST=/^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/;
function timeout(ms:number):Promise<never>{return new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('timeout')),ms);t.unref();});}
export interface MinecraftEndpoint { host:string; port:number; serverName:string }
export interface MinecraftDns {
  resolveSrv: (name:string) => Promise<Array<{name:string;port:number;priority:number;weight:number}>>;
  lookup: (host:string, options:{family:4;all:true}) => Promise<Array<{address:string;family:number}>>;
}
const edgeHost = (host:string) => host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:ply\.gg|joinmc\.link)$/.test(host);
/** Resolve the SRV target AND port; retain the address typed by the player in the handshake. */
export async function resolveMinecraftEndpoint(ep:MinecraftEndpoint, dns:MinecraftDns={resolveSrv,lookup}):Promise<MinecraftEndpoint>{
  if(!PLAYIT_HOST.test(ep.host)||ep.serverName!==ep.host||!Number.isInteger(ep.port)||ep.port<1||ep.port>65535)throw Error('Unsafe Minecraft endpoint');
  let host=ep.host,port=ep.port;
  let records:Awaited<ReturnType<MinecraftDns['resolveSrv']>>=[];
  try{records=await Promise.race([dns.resolveSrv('_minecraft._tcp.'+host),timeout(5000)]);}
  catch(error){if(!['ENODATA','ENOTFOUND'].includes((error as NodeJS.ErrnoException).code ?? ''))throw Error('Minecraft DNS unavailable');}
  if(records.length){
    if(records.length>100 || records.some(r=>!edgeHost(r.name)||!Number.isInteger(r.port)||r.port<1||r.port>65535||!Number.isInteger(r.priority)||r.priority<0||r.priority>65535||!Number.isInteger(r.weight)||r.weight<0||r.weight>65535))throw Error('Unsafe Minecraft SRV');
    const selected=[...records].sort((a,b)=>a.priority-b.priority||b.weight-a.weight||a.name.localeCompare(b.name)||a.port-b.port)[0]!;
    host=selected.name;port=selected.port;
  }
  const addresses=await Promise.race([dns.lookup(host,{family:4,all:true}),timeout(5000)]);
  if(!addresses.length||addresses.length>100||addresses.some(a=>a.family!==4||!publicIPv4(a.address)))throw Error('Unsafe Minecraft DNS address');
  return {host:addresses[0]!.address,port,serverName:ep.serverName};
}
export async function probeMinecraft(ep:{host:string;port:number;serverName:string}):Promise<boolean>{
  return (await probeMinecraftDetailed(ep)).ok;
}
export interface MinecraftProbeResult {ok:boolean;failure?:'dns-failure'|'game-failure'}
export async function probeMinecraftDetailed(ep:MinecraftEndpoint):Promise<MinecraftProbeResult>{
  let endpoint:MinecraftEndpoint;
  try { endpoint=await resolveMinecraftEndpoint(ep); } catch { return {ok:false,failure:'dns-failure'}; }
  try {
    const port=endpoint.port;
    // Connect to the validated numeric address, not a second DNS lookup.
    const ok=await new Promise<boolean>(resolve=>{
      const socket=connect({host:endpoint.host,port});let buf=Buffer.alloc(0);let done=false;
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
    return ok ? {ok:true} : {ok:false,failure:'game-failure'};
  }catch{return {ok:false,failure:'game-failure'};}
}
