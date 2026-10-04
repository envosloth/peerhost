import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { syncDirectory } from './snapshots.js';
export interface GameGatewayConfig { enabled: boolean; localPort: number }
export function validateGameGateway(value: unknown): GameGatewayConfig {
 const v=value as Record<string,unknown>;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='enabled,localPort'||typeof v.enabled!=='boolean'||!Number.isInteger(v.localPort)||Number(v.localPort)<1||Number(v.localPort)>65535)throw new Error('Invalid game gateway configuration');
 return{enabled:v.enabled,localPort:v.localPort as number};
}
export async function readGameGateway(root: string): Promise<GameGatewayConfig & {error:string|null}> {
 try{
  const handle=await open(path.join(root,'game-gateway.json'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));let value;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>16384)throw new Error('Invalid gateway metadata');const buffer=Buffer.alloc(16385);const{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw new Error('Oversized gateway metadata');value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}finally{await handle.close();}
  if(value?.version!==1)throw new Error('Unsupported gateway metadata');const{version:_version,...input}=value;
  return{...validateGameGateway(input),error:null};
 }catch(error){return{enabled:false,localPort:25565,error:(error as NodeJS.ErrnoException).code==='ENOENT'?null:'Gateway settings are unreadable; forwarding is off. Original metadata was left unchanged.'};}
}
export async function saveGameGatewayConfig(root:string,input:unknown):Promise<void>{
 const config=validateGameGateway(input),current=await readGameGateway(root);if(current.error)throw new Error(current.error);
 const file=path.join(root,'game-gateway.json'),temporary=file+'.'+randomUUID()+'.tmp';const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify({version:1,...config}));await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,file);await syncDirectory(root);}finally{await rm(temporary,{force:true});}
}
