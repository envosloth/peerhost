import { access, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface OwnershipState {version:1;owner:string;generation:number;snapshotId:string;state:'owned'|'hosting'|'offered'|'transferred'|'uncertain';offer?:TransferOffer}
export interface TransferOffer {id:string;source:string;target:string;generation:number;snapshotId:string}
export class OwnershipLedger {
  constructor(private readonly file:string,readonly deviceId:string){}
  private openDatabase():DatabaseSync{
    const db=new DatabaseSync(this.file,{timeout:0});
    try{
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;');
      if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='delete'||db.prepare('PRAGMA synchronous').get()?.synchronous!==3)throw new Error('Ownership durability unavailable: DELETE journal and synchronous EXTRA are required');
      db.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL) STRICT');
      return db;
    }catch(error){
      db.close();
      if((error as {errcode?:number}).errcode===26)throw new Error('Unsupported ownership metadata format: legacy JSON requires explicit migration; original file is preserved',{cause:error});
      throw error;
    }
  }
  private readState(db:DatabaseSync):OwnershipState|undefined{
    const row=db.prepare('SELECT data FROM ownership WHERE id = ?').get(1);
    return row?JSON.parse(row.data as string):undefined;
  }
  async status():Promise<OwnershipState>{
    await access(this.file);
    const db=this.openDatabase();
    try{
      const state=this.readState(db);
      if(!state)throw Object.assign(new Error('Ownership is not initialized'),{code:'ENOENT'});
      return state;
    }finally{db.close();}
  }
  private async transaction<T>(change:(s:OwnershipState|undefined)=>Promise<{state:OwnershipState,value:T}>):Promise<T>{
    await mkdir(path.dirname(this.file),{recursive:true});
    const db=this.openDatabase();
    try{
      db.exec('BEGIN IMMEDIATE');
      try{
        const result=await change(this.readState(db));
        db.prepare('INSERT INTO ownership (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(1,JSON.stringify(result.state));
        db.exec('COMMIT');
        return result.value;
      }catch(error){
        try{db.exec('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'Ownership transaction failed and rollback could not be confirmed');}
        throw error;
      }
    }finally{db.close();}
  }
  async initialize(snapshotId:string):Promise<void>{
    await this.transaction(async s=>{if(s)throw new Error('Ownership already initialized');return {state:{version:1,owner:this.deviceId,generation:0,snapshotId,state:'owned'},value:undefined};});
  }
  async startHosting():Promise<void>{
    await this.transaction(async s=>{if(!s||s.owner!==this.deviceId||s.state!=='owned')throw new Error('Hosting blocked: ownership is not safely held by this device');return {state:{...s,state:'hosting'},value:undefined};});
  }
  async stopHosting(snapshotId:string):Promise<void>{
    await this.transaction(async s=>{if(!s||s.owner!==this.deviceId||s.state!=='hosting')throw new Error('This device is not hosting');return {state:{...s,state:'owned',snapshotId},value:undefined};});
  }
  async updateSnapshot(snapshotId:string):Promise<void>{
    await this.transaction(async s=>{if(!s||s.owner!==this.deviceId||s.state!=='owned')throw new Error('Snapshot update requires stopped, safely owned server');return {state:{...s,snapshotId},value:undefined};});
  }
  async prepareTransfer(target:string,snapshotId:string):Promise<TransferOffer>{
    return this.transaction(async s=>{if(s?.state==='hosting')throw new Error('Stop hosting before handoff');if(!s||s.owner!==this.deviceId||s.state!=='owned'||s.snapshotId!==snapshotId)throw new Error('Ownership or revision mismatch');if(!target||target===this.deviceId)throw new Error('Invalid target device');const offer={id:randomUUID(),source:this.deviceId,target,generation:s.generation+1,snapshotId};return {state:{...s,state:'offered',offer},value:offer};});
  }
  async acceptTransfer(offer:TransferOffer,authenticatedSource:string,verifiedSnapshotId:string):Promise<void>{
    if(!offer || offer.source!==authenticatedSource)throw new Error('Authenticated source does not match offer');
    if(offer.source===offer.target)throw new Error('Self-transfer is not allowed');
    if(offer.target!==this.deviceId)throw new Error('Ownership offer is for another device');
    if(offer.snapshotId!==verifiedSnapshotId)throw new Error('Verified revision does not match offer');
    if(!Number.isSafeInteger(offer.generation)||offer.generation<1||typeof offer.id!=='string'||offer.id.length>128)throw new Error('Invalid ownership offer');
    await this.transaction(async s=>{
      if(s && (s.state==='hosting'||s.state==='uncertain'||s.owner!==offer.source||offer.generation!==s.generation+1))throw new Error('Stale or conflicting ownership offer');
      return {state:{version:1,owner:this.deviceId,generation:offer.generation,snapshotId:offer.snapshotId,state:'owned'},value:undefined};
    });
  }
  async markUncertain():Promise<void>{
    await this.transaction(async s=>{if(!s||s.owner!==this.deviceId)throw new Error('Ownership not held');return {state:{...s,state:'uncertain'},value:undefined};});
  }
  async recoverStopped(confirmedStopped:boolean):Promise<void>{
    if(!confirmedStopped)throw new Error('Confirm the previous process is stopped before recovery');
    await this.transaction(async s=>{if(!s||s.owner!==this.deviceId||s.state!=='uncertain'||s.offer)throw new Error('Ownership cannot be recovered safely from this state');return {state:{...s,state:'owned'},value:undefined};});
  }
  async confirmTransfer(offerId:string,authenticatedTarget:string):Promise<void>{
    await this.transaction(async s=>{
      if(!s||s.state!=='offered'||s.offer?.id!==offerId||s.offer.target!==authenticatedTarget)throw new Error('Ownership confirmation mismatch');
      return {state:{version:1,owner:authenticatedTarget,generation:s.offer.generation,snapshotId:s.offer.snapshotId,state:'transferred'},value:undefined};
    });
  }
}
