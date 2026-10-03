import { mkdir, readFile, writeFile, link, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { createIdentity, type PeerIdentity } from './peer-transport.js';
export interface IdentityVault {encrypt:(value:string)=>Buffer;decrypt:(value:Buffer)=>string}
export async function loadIdentity(root:string,vault:IdentityVault):Promise<PeerIdentity>{
  await mkdir(root,{recursive:true});const file=path.join(root,'identity.json');
  const read=async()=>{
    const data=JSON.parse(await readFile(file,'utf8'));
    if(data.version!==1||typeof data.certPem!=='string'||typeof data.encryptedKey!=='string'||typeof data.fingerprint!=='string')throw new Error('Invalid stored peer identity');
    const keyPem=vault.decrypt(Buffer.from(data.encryptedKey,'base64'));
    const cert=new X509Certificate(data.certPem);
    const fingerprint=createHash('sha256').update(cert.raw).digest('hex');
    if(fingerprint!==data.fingerprint||!cert.checkPrivateKey(createPrivateKey(keyPem)))throw new Error('Peer identity certificate/key mismatch');
    return {keyPem,certPem:data.certPem,fingerprint};
  };
  try{return await read();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  // Never invent a new device identity for an existing application state.
  try{await access(path.join(root,'state.json'));throw new Error('Peer identity is missing for existing app state; recovery is required');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const identity=await createIdentity();const encryptedKey=vault.encrypt(identity.keyPem).toString('base64');
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify({version:1,certPem:identity.certPem,fingerprint:identity.fingerprint,encryptedKey}),{flag:'wx',mode:0o600});
    try{await link(temporary,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }finally{await rm(temporary,{force:true});}
  return read();
}
