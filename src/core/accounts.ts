import { randomUUID, createHash, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { connectPeer, listenPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { decodeInvite } from './invites.js';
import { fingerprintOK, validAdvertise } from './relay-friends-store.js';

export interface AccountEndpoint { host: string; port: number; fingerprint: string }
export function accountEndpoint(value: unknown): AccountEndpoint {
  const v = value as AccountEndpoint;
  if (!v || !validAdvertise(v) || !fingerprintOK(v.fingerprint)) throw new Error('Account service configuration is invalid');
  return { host: v.host, port: v.port, fingerprint: v.fingerprint };
}
export function accountUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(value)) throw new Error('Username must be 3–24 letters, numbers or underscores');
  return value.toLowerCase();
}
export function accountPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 128 || /\p{Cc}/u.test(value)) throw new Error('Use a password of 4–128 characters with no control characters');
  return value;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const hashPassword = (s: string, salt: string) => new Promise<Buffer>((resolve,reject) => derive(s,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,key)=>e?reject(e):resolve(key)));
const DAY = 86400000;

/** No world files, relay authority or game traffic ever pass through this directory. */
export class AccountService {
  private db?: DatabaseSync;
  private listener?: Awaited<ReturnType<typeof listenPeer>>;
  private rates = new Map<string,{start:number;count:number}>();
  private hashing = 0;
  constructor(readonly root: string, readonly identity: PeerIdentity) {}
  get endpoint() { return this.listener && {host:this.listener.host,port:this.listener.port}; }
  async listen(options: {host?:string;port?:number} = {}): Promise<void> {
    await mkdir(this.root,{recursive:true,mode:0o700});
    this.db = new DatabaseSync(path.join(this.root,'accounts.sqlite'));
    await chmod(path.join(this.root,'accounts.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts(username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username), fingerprint TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, fingerprint TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_recipient ON requests(recipient);`);
    try {
      // Any certificate may reach account registration; this is a separate listener with no transfer APIs.
      this.listener = await listenPeer(this.identity,[],(socket,fp)=>{void this.handle(socket,fp);},{...options,authorizeCertificate:async()=> 'trusted'});
    } catch(e) { this.db.close(); this.db=undefined; throw e; }
  }
  private limit(key:string,max:number) {
    const now=Date.now();
    for (const [k,v] of this.rates) if(now-v.start>60000)this.rates.delete(k);
    const old=this.rates.get(key) ?? {start:now,count:0};
    if (this.rates.size>=10000 && !this.rates.has(key)) throw new Error('Service is busy; try again shortly');
    if (++old.count>max) throw new Error('Too many requests; try again in a minute');
    this.rates.set(key,old);
  }
  private async handle(socket:TLSSocket,fp:string) {
    try {
      this.limit('request:'+socket.remoteAddress,120);
      const request=await readFrame(socket,8192,5000) as Record<string,unknown>;
      if (!request || request.type!=='account' || request.version!==1 || typeof request.op!=='string' || !request.payload || typeof request.payload!=='object' || Array.isArray(request.payload) || Object.keys(request).sort().join(',')!=='op,payload,type,version') throw new Error('Invalid account request');
      const data=await this.perform(request.op,request.payload as Record<string,unknown>,fp,socket.remoteAddress ?? 'unknown');
      await writeFrame(socket,{type:'account-result',data});
    } catch(e) {
      await writeFrame(socket,{type:'account-error',message:e instanceof Error?e.message.slice(0,200):'Account operation failed'}).catch(()=>{});
    } finally {socket.destroy();}
  }
  private session(token:unknown,fp:string):string {
    if(typeof token!=='string'||!fingerprintOK(token))throw new Error('Sign in again');
    const row=this.db!.prepare('SELECT username FROM sessions WHERE digest=? AND fingerprint=? AND expires>?').get(digest(token),fp,Date.now());
    if(!row)throw new Error('Sign in again');
    return row.username as string;
  }
  private async perform(op:string,p:Record<string,unknown>,fp:string,ip:string):Promise<unknown> {
    const db=this.db!;
    if(op==='register'||op==='login') {
      if(Object.keys(p).sort().join(',')!=='password,username')throw new Error('Invalid account request');
      this.limit('auth:'+ip,10);
      const username=accountUsername(p.username), secret=accountPassword(p.password);
      if(this.hashing>=2)throw new Error('Service is busy; try again shortly');
      if(op==='register' && db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username))throw new Error('That username is taken');
      if(op==='register' && Number(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n)>=100000)throw new Error('Service is full');
      const row=db.prepare('SELECT salt,hash FROM accounts WHERE username=?').get(username);
      const salt=row?.salt as string || randomBytes(32).toString('hex');
      let hashed:Buffer;
      this.hashing++;try{hashed=await hashPassword(secret,salt);}finally{this.hashing--;}
      if(op==='login') {
        if(!row||!timingSafeEqual(hashed,Buffer.from(row.hash as string,'hex')))throw new Error('Username or password is incorrect');
        const current=db.prepare('SELECT salt,hash FROM accounts WHERE username=?').get(username);
        if(!current||current.salt!==row.salt||current.hash!==row.hash)throw new Error('Account changed; sign in again');
      }
      if(op==='register') {
        // Recheck after asynchronous hashing: concurrent registrations cannot steal or overwrite a name.
        if(db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username))throw new Error('That username is taken');
        db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(username,salt,hashed.toString('hex'));
      }
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('DELETE FROM sessions WHERE username=? AND fingerprint=?').run(username,fp);
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE username=?').get(username)!.n)>=8)throw new Error('Device limit reached; sign out on another PC first');
      const token=randomBytes(32).toString('hex'), expiresAt=Date.now()+30*DAY;
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),username,fp,expiresAt);
      return {username,token,expiresAt};
    }
    const username=this.session(p.token,fp);
    if(op==='update-profile') {
      const keys=Object.keys(p).sort().join(',');
      if(keys!=='currentPassword,token,username'&&keys!=='currentPassword,newPassword,token,username')throw new Error('Invalid account request');
      this.limit('auth:'+ip,10);
      const nextUsername=accountUsername(p.username), secret=accountPassword(p.currentPassword);
      const newSecret=keys.includes('newPassword')?accountPassword(p.newPassword):undefined;
      if(this.hashing>=2)throw new Error('Service is busy; try again shortly');
      const row=db.prepare('SELECT salt,hash FROM accounts WHERE username=?').get(username)!;
      let salt=row.salt as string, hash=row.hash as string;
      // Hold one hashing slot across both derivations; at most two account jobs derive concurrently.
      this.hashing++;
      try {
        const hashed=await hashPassword(secret,salt);
        if(!timingSafeEqual(hashed,Buffer.from(hash,'hex')))throw new Error('Current password is incorrect');
        if(newSecret!==undefined){salt=randomBytes(32).toString('hex');hash=(await hashPassword(newSecret,salt)).toString('hex');}
      } finally {this.hashing--;}
      db.exec('BEGIN IMMEDIATE');
      try {
        if(this.session(p.token,fp)!==username)throw new Error('Account changed; sign in again');
        const current=db.prepare('SELECT salt,hash FROM accounts WHERE username=?').get(username);
        if(!current||current.salt!==row.salt||current.hash!==row.hash)throw new Error('Account changed; sign in again');
        if(nextUsername!==username) {
          if(db.prepare('SELECT 1 FROM accounts WHERE username=?').get(nextUsername))throw new Error('That username is taken');
          // Insert before moving the session foreign keys; the original credentials and device bindings remain intact.
          db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(nextUsername,row.salt as string,row.hash as string);
          db.prepare('UPDATE sessions SET username=? WHERE username=?').run(nextUsername,username);
          db.prepare('UPDATE requests SET sender=? WHERE sender=?').run(nextUsername,username);
          db.prepare('UPDATE requests SET recipient=? WHERE recipient=?').run(nextUsername,username);
          db.prepare('DELETE FROM accounts WHERE username=?').run(username);
        }
        if(newSecret!==undefined) {
          db.prepare('UPDATE accounts SET salt=?,hash=? WHERE username=?').run(salt,hash,nextUsername);
          db.prepare('DELETE FROM sessions WHERE username=? AND digest<>?').run(nextUsername,digest(p.token as string));
        }
        db.exec('COMMIT');
      } catch(e) {db.exec('ROLLBACK');throw e;}
      return {username:nextUsername};
    }
    if(op==='me') {if(Object.keys(p).join(',')!=='token')throw new Error('Invalid account request');return {username};}
    if(op==='logout') {if(Object.keys(p).join(',')!=='token')throw new Error('Invalid account request');db.prepare('DELETE FROM sessions WHERE digest=?').run(digest(p.token as string));return {signedOut:true};}
    if(op==='lookup') {
      if(Object.keys(p).sort().join(',')!=='token,username')throw new Error('Invalid account request');
      const recipient=accountUsername(p.username);
      const devices=db.prepare('SELECT DISTINCT fingerprint FROM sessions WHERE username=? AND expires>? ORDER BY expires DESC').all(recipient,Date.now()).map(r=>r.fingerprint);
      if(!devices.length)throw new Error('That username is not available; ask your friend to sign in');
      return {username:recipient,devices};
    }
    db.prepare('DELETE FROM requests WHERE expires<=?').run(Date.now());
    if(op==='send') {
      if(Object.keys(p).sort().join(',')!=='code,fingerprint,token,username' || !fingerprintOK(p.fingerprint) || typeof p.code!=='string' || p.code.length>1500)throw new Error('Invalid friend request');
      const recipient=accountUsername(p.username);
      if(recipient===username)throw new Error('You cannot invite yourself');
      if(!db.prepare('SELECT 1 FROM sessions WHERE username=? AND fingerprint=? AND expires>?').get(recipient,p.fingerprint,Date.now()))throw new Error('Friend must sign in on that PC first');
      const invite=decodeInvite(p.code), expires=invite.expiresAt*1000;
      if(expires<=Date.now() || expires>Date.now()+31*DAY)throw new Error('Invalid invitation expiry');
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM requests WHERE sender=?').get(username)!.n)>=30 || Number(db.prepare('SELECT COUNT(*) AS n FROM requests WHERE recipient=?').get(recipient)!.n)>=100)throw new Error('Too many pending invitations');
      if(db.prepare('SELECT 1 FROM requests WHERE sender=? AND recipient=? AND fingerprint=?').get(username,recipient,p.fingerprint))throw new Error('An invitation is already waiting for this friend');
      const id=randomUUID();
      db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,username,recipient,p.fingerprint,p.code,expires);
      return {id};
    }
    if(op==='sent') {
      if(Object.keys(p).join(',')!=='token')throw new Error('Invalid account request');
      return {ids:db.prepare('SELECT id FROM requests WHERE sender=?').all(username).map(r=>r.id)};
    }
    if(op==='inbox') {
      if(Object.keys(p).join(',')!=='token')throw new Error('Invalid account request');
      const requests=db.prepare('SELECT id,sender AS "from",code,expires AS expiresAt FROM requests WHERE recipient=? AND fingerprint=? ORDER BY expires').all(username,fp);
      return {requests};
    }
    if(op==='request'||op==='dismiss') {
      if(Object.keys(p).sort().join(',')!=='id,token' || typeof p.id!=='string' || !/^[a-f0-9-]{36}$/.test(p.id))throw new Error('Invalid friend request');
      const row=db.prepare('SELECT id,sender AS "from",code,expires AS expiresAt FROM requests WHERE id=? AND recipient=? AND fingerprint=?').get(p.id,username,fp);
      if(!row)throw new Error('Invitation not found');
      if(op==='dismiss'){db.prepare('DELETE FROM requests WHERE id=?').run(p.id);return {dismissed:true};}
      return row;
    }
    throw new Error('Unsupported account operation');
  }
  async close() { if(this.listener){await this.listener.close();this.listener=undefined;}this.db?.close();this.db=undefined; }
}

// Only this typed error proves a complete, authenticated service error frame was received.
export class AccountOperationError extends Error {}

export class AccountClient {
  readonly endpoint:AccountEndpoint;
  constructor(private readonly identity:PeerIdentity,endpoint:AccountEndpoint){this.endpoint=accountEndpoint(endpoint);}
  async call(op:string,payload:Record<string,unknown>):Promise<any> {
    const socket=await connectPeer(this.identity,this.endpoint.fingerprint,this.endpoint.host,this.endpoint.port);
    try {
      await writeFrame(socket,{type:'account',version:1,op,payload});
      const reply=await readFrame(socket,262144,10000) as Record<string,unknown>;
      if(reply?.type==='account-error'){
        if(Object.keys(reply).sort().join(',')!=='message,type'||typeof reply.message!=='string'||!reply.message||reply.message.length>200)throw new Error('Invalid account service reply');
        throw new AccountOperationError(reply.message);
      }
      if(reply?.type!=='account-result'||!reply.data||typeof reply.data!=='object'||Array.isArray(reply.data))throw new Error('Invalid account service reply');
      return reply.data;
    } finally {socket.destroy();}
  }
}
