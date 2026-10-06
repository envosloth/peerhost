import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AccountClient, AccountOperationError, accountUsername, accountPassword, type AccountEndpoint } from './accounts.js';
import { decodeInvite } from './invites.js';
import { isPrivateEndpointHost } from './endpoints.js';
import { fingerprintOK } from './relay-friends-store.js';
import { syncDirectory } from './snapshots.js';
import { isRetryablePeerError, type PeerIdentity } from './peer-transport.js';
import type { SeedHostApplication } from './application.js';

interface Vault { encrypt(value:string):Buffer; decrypt(value:Buffer):string }
interface Session { username:string; token:string; expiresAt:number; service:AccountEndpoint }
export class AccountIntegration {
  private client?:AccountClient;
  private busy=false;
  constructor(private root:string,identity:PeerIdentity,private vault:Vault,private app:SeedHostApplication,endpoint?:AccountEndpoint){if(endpoint)this.client=new AccountClient(identity,endpoint);}
  private get file(){return path.join(this.root,'account.enc');}
  private async load():Promise<Session|null>{
    if(!this.client)return null;
    let bytes:Buffer;try{bytes=await readFile(this.file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    try {
      const v=JSON.parse(this.vault.decrypt(bytes)) as Session;
      if(!fingerprintOK(v.token)||accountUsername(v.username)!==v.username||!Number.isSafeInteger(v.expiresAt)||v.service?.fingerprint!==this.client.endpoint.fingerprint)throw new Error();
      return v;
    }catch{throw new Error('Saved account could not be read; it was left unchanged');}
  }
  private async store(s:Session){
    await mkdir(this.root,{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp',h=await open(temp,'wx',0o600);
    try {try{await h.writeFile(this.vault.encrypt(JSON.stringify(s)));await h.sync();}finally{await h.close();}await rename(temp,this.file);await syncDirectory(this.root);}finally{await rm(temp,{force:true});}
  }
  async status(){
    if(!this.client)return {configured:false,signedIn:false,online:false,username:null,detail:'Online accounts are not connected in this build yet. Local hosting still works.'};
    const s=await this.load();if(!s||s.expiresAt<=Date.now())return {configured:true,signedIn:false,online:true,username:null,detail:'Create an account or sign in to this account directory.'};
    try {
      const me=await this.client.call('me',{token:s.token});
      if(!me||Object.keys(me).join(',')!=='username'||accountUsername(me.username)!==me.username)throw new Error('Invalid account service reply');
      // The authenticated token/device binding is authority; usernames may change on another PC.
      // Status stays read-only, so it cannot overwrite a concurrent encrypted login or logout.
      return {configured:true,signedIn:true,online:true,username:me.username,detail:'Signed in · '+this.client.endpoint.host};
    }catch(e){
      if((e as Error).message==='Sign in again')return {configured:true,signedIn:false,online:true,username:null,detail:'Your session expired. Sign in again.'};
      return {configured:true,signedIn:true,online:false,username:s.username,detail:'Account service is unavailable. Your local world is unaffected.'};
    }
  }
  private async exclusive<T>(work:()=>Promise<T>):Promise<T>{if(this.busy)throw new Error('An account operation is already in progress');this.busy=true;try{return await work();}finally{this.busy=false;}}
  async authenticate(op:'register'|'login',input:{username:string;password:string}){
    return this.exclusive(async()=>{
      if(!this.client)throw new Error('Online accounts are not connected in this build yet');
      const reply=await this.client.call(op,input);
      if(reply.username!==accountUsername(input.username)||!fingerprintOK(reply.token)||!Number.isSafeInteger(reply.expiresAt)||reply.expiresAt<=Date.now())throw new Error('Invalid account service reply');
      await this.store({...reply,service:this.client.endpoint});return this.status();
    });
  }
  async updateProfile(input:{username:string;currentPassword:string;newPassword?:string}) {
    return this.exclusive(async()=>{
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['username','currentPassword','newPassword'].includes(k)))throw new Error('Invalid account profile');
      const username=accountUsername(input.username),currentPassword=accountPassword(input.currentPassword);
      const newPassword=input.newPassword===undefined?undefined:accountPassword(input.newPassword);
      const s=await this.load();if(!s||!this.client)throw new Error('Sign in first');
      const payload={token:s.token,username,currentPassword,...(newPassword===undefined?{}:{newPassword})};
      let reply:any;
      try {reply=await this.client.call('update-profile',payload);}
      catch(e) {
        const rejected=new Set(['Unsupported account operation','Invalid account request','Sign in again','Current password is incorrect','That username is taken','Account changed; sign in again','Service is busy; try again shortly','Too many requests; try again in a minute']);
        if(e instanceof AccountOperationError&&rejected.has(e.message))throw e;
        // Transport/protocol failures and unexpected service errors do not prove no commit occurred.
        throw new Error('Your account may have changed, but the reply could not be verified. Do not save again; sign in with the requested username and password to check.');
      }
      try {
        if(Object.keys(reply).join(',')!=='username'||reply.username!==username)throw new Error('Invalid account service reply');
        const me=await this.client.call('me',{token:s.token});
        if(Object.keys(me).join(',')!=='username'||me.username!==username)throw new Error('Account profile could not be verified');
        await this.store({...s,username});
      } catch {
        throw new Error('Your account may have changed, but verification or saving the local session failed. Do not save again; sign in with the requested username and password to check.');
      }
      return {configured:true,signedIn:true,online:true,username,detail:'Signed in · '+this.client.endpoint.host};
    });
  }
  private async call(op:string,p:Record<string,unknown>={}){const s=await this.load();if(!s||!this.client)throw new Error('Sign in first');return this.client.call(op,{token:s.token,...p});}
  async logout(){return this.exclusive(async()=>{await this.call('logout');await rm(this.file,{force:true});return this.status();});}
  async send(username:string){return this.exclusive(async()=>{
    const found=await this.call('lookup',{username:accountUsername(username)});
    if(found.username!==accountUsername(username)||!Array.isArray(found.devices)||!found.devices.length||found.devices.length>8||!found.devices.every((v:unknown)=>fingerprintOK(v)))throw new Error('Invalid account lookup reply');
    // Invite the most recently signed-in PC; membership remains a device-specific authority.
    const fingerprint=found.devices[0];const invite=await this.app.createInviteFor(fingerprint);
    const sent=await this.call('send',{username:found.username,fingerprint,code:invite.code});
    if(typeof sent.id!=='string'||!/^[a-f0-9-]{36}$/.test(sent.id))throw new Error('Invalid invitation reply');
    const inbox=await this.call('sent');
    if(!Array.isArray(inbox.ids)||!inbox.ids.includes(sent.id))throw new Error('Invitation delivery could not be verified');
    return {username:found.username};
  });}
  private validateRequest(r:any){
    if(!r||typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||accountUsername(r.from)!==r.from||typeof r.code!=='string'||r.code.length>1500||!Number.isSafeInteger(r.expiresAt))throw new Error('Invalid friend request reply');
    const invite=decodeInvite(r.code);if(invite.expiresAt*1000!==r.expiresAt)throw new Error('Invalid friend request expiry');
    return {id:r.id,from:r.from,group:invite.relayName,expiresAt:r.expiresAt,
      controlEndpoint:{host:invite.host,port:invite.port,privateRoute:isPrivateEndpointHost(invite.host),reachability:'unverified' as const}};
  }
  async requests(){const reply=await this.call('inbox');if(!Array.isArray(reply.requests)||reply.requests.length>100)throw new Error('Invalid invitation inbox');return reply.requests.map((r:any)=>this.validateRequest(r));}
  async accept(id:string){return this.exclusive(async()=>{
    const r=await this.call('request',{id});this.validateRequest(r);if(r.id!==id)throw new Error('Invalid friend request');
    const s=(await this.load())!;await this.app.joinWithInvite({code:r.code,name:s.username});
    const members=await this.app.listFriends();if(!members.members.some(m=>m.you))throw new Error('Group membership could not be verified');
    await this.dismissRequest(id);return {joined:true,group:decodeInvite(r.code).relayName};
  });}
  private async dismissRequest(id:string){
    let uncertain:unknown;
    try{await this.call('dismiss',{id});}
    catch(error){if(!isRetryablePeerError(error))throw error;uncertain=error;}
    // A lost reply does not mean the directory failed to commit. Read the exact recipient/device
    // inbox before reporting success; never replay authentication or discard an unverified request.
    if((await this.requests()).some((r:any)=>r.id===id))throw uncertain ?? new Error('Invitation dismissal could not be verified');
  }
  async decline(id:string){return this.exclusive(()=>this.dismissRequest(id));}
}
