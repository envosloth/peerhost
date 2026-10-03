import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, validateSettings, type Settings } from './settings.js';
import { importServer, createSnapshot, materializeSnapshot, type SnapshotManifest } from './snapshots.js';
import { ServerProcess } from './launcher.js';
import { OwnershipLedger, type TransferOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshotToPeer } from './transfers.js';
import { listenPeer, type PeerIdentity } from './peer-transport.js';
import type { TLSSocket } from 'node:tls';
import { isValidEndpointHost } from './endpoints.js';
interface SavedServer {name:string;serverDir:string;storeDir:string;snapshotId:string;profile:{executable:string;args:string[]};ledgerFile:string}
interface SavedState {version:1;settings:Settings;server:SavedServer|null;peers:Array<{name:string;fingerprint:string;host:string;port:number}>}
export interface LaunchApproval {readonly root:string;readonly serverDir:string;readonly snapshotId:string;readonly profile:{readonly executable:string;readonly args:readonly string[]}}
export class PeerHostApplication {
  private saved:SavedState={version:1,settings:defaultSettings(),server:null,peers:[]};
  private logs:string[]=[];
  private busy:string|null=null;
  private operationToken?:symbol;
  private process?:ServerProcess;
  private controlledProcess?:ServerProcess;
  private unexpectedExit?:OwnershipLedger;
  private listener?:{host:string;port:number;close:()=>Promise<void>};
  private assertStopped():void {if(this.process?.pid||this.process?.state==='starting'||this.process?.state==='stopping')throw new Error('Stop the server before this operation');}
  constructor(readonly root:string,readonly identity:PeerIdentity,private readonly options:{confirmIncomingHandoff?:(source:string,snapshot:SnapshotManifest,offer:TransferOffer)=>Promise<boolean>}={}){}
  async open():Promise<void>{
    await mkdir(this.root,{recursive:true});
    try{const loaded=JSON.parse(await readFile(path.join(this.root,'state.json'),'utf8'));if(loaded.version!==1||!Array.isArray(loaded.peers))throw new Error('Invalid saved application state');loaded.settings=validateSettings(loaded.settings);this.saved=loaded;}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(this.saved.server){const ledger=this.ledger();const state=await ledger.status();if(state.state==='hosting') {await ledger.markUncertain();this.log('Previous hosting session is uncertain. Confirm that its process stopped before recovery.');}}
  }
  private ledger():OwnershipLedger{if(!this.saved.server)throw new Error('No server imported');return new OwnershipLedger(this.saved.server.ledgerFile,this.identity.fingerprint);}
  private log(line:string):void{this.logs.push(line.slice(0,16384));if(this.logs.length>1000)this.logs.shift();}
  private async persist():Promise<void>{
    const file=path.join(this.root,'state.json');const tmp=file+'.'+randomUUID()+'.tmp';const f=await open(tmp,'wx',0o600);
    try{await f.writeFile(JSON.stringify(this.saved));await f.sync();}finally{await f.close();}
    try{await rename(tmp,file);}finally{await rm(tmp,{force:true});}
  }
  private async fenceUnexpectedExit():Promise<void>{
    while(this.unexpectedExit){const ledger=this.unexpectedExit;this.unexpectedExit=undefined;try{await ledger.markUncertain();}catch(error){this.unexpectedExit=ledger;throw error;}}
  }
  private async operation<T>(name:string,work:(token:symbol)=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('An operation is already in progress');
    this.busy=name;const token=Symbol(name);this.operationToken=token;
    try{await this.fenceUnexpectedExit();return await work(token);}
    finally{try{await this.fenceUnexpectedExit();}finally{this.operationToken=undefined;this.busy=null;}}
  }
  async getState(){return {version:'0.1.0',deviceId:this.identity.fingerprint,settings:{...this.saved.settings},server:this.saved.server?{...this.saved.server,state:this.process?.state??'offline',ownership:await this.ledger().status()}:null,peers:this.saved.peers.map(p=>({...p})),logs:[...this.logs],peerEndpoint:this.listener?{host:this.listener.host,port:this.listener.port}:null,busy:this.busy};}
  async importExisting(source:string,confirmedStopped:boolean):Promise<void>{
    this.assertStopped();
    if(!confirmedStopped)throw new Error('Confirm the source server is stopped before importing');
    await this.operation('importServer',async()=>{
      if(this.saved.server)throw new Error('A server is already imported. Use a separate explicit profile for a different server; existing lineage and authority cannot be replaced.');
      const result=await importServer(source,path.join(this.root,'managed'));
      const ledgerFile=path.join(this.root,'ownership-'+randomUUID()+'.sqlite');
      await new OwnershipLedger(ledgerFile,this.identity.fingerprint).initialize(result.snapshot.id);
      this.saved.server={name:path.basename(source),serverDir:result.serverDir,storeDir:result.storeDir,snapshotId:result.snapshot.id,profile:{executable:'',args:[]},ledgerFile};
      await this.persist();this.log('Imported a separate managed copy. Original folder was not modified.');
    });
  }
  async saveProfile(profile:{executable:string;args:string[]}):Promise<void>{
    this.assertStopped();
    await this.operation('saveProfile',async()=>{
      if(!this.saved.server)throw new Error('No server imported');
      if(typeof profile.executable!=='string'||!profile.executable.trim()||/[\0\r\n]/.test(profile.executable)||!Array.isArray(profile.args)||profile.args.length>100||profile.args.some(a=>typeof a!=='string'||/[\0\r\n]/.test(a)||a.length>4096))throw new Error('Invalid structured launch profile');
      this.saved.server.profile={executable:profile.executable,args:[...profile.args]};await this.persist();
    });
  }
  async startServer(approved:boolean):Promise<void>{
    if(!approved)throw new Error('Confirm that you trust the server executables and mods');
    await this.startServerWithApproval(async()=>true);
  }
  async startServerWithApproval(confirm:(approval:LaunchApproval)=>Promise<boolean>):Promise<void>{
    this.assertStopped();
    await this.operation('startServer',async()=>{
      const server=this.saved.server;if(!server?.profile.executable)throw new Error('Configure a launch profile first');
      const original=JSON.stringify(server);
      const approval:LaunchApproval=Object.freeze({root:this.root,serverDir:server.serverDir,snapshotId:server.snapshotId,profile:Object.freeze({executable:server.profile.executable,args:Object.freeze([...server.profile.args])})});
      if(!await confirm(approval))return;
      const revalidate=()=>{this.assertStopped();if(this.saved.server!==server||JSON.stringify(server)!==original)throw new Error('Server lineage or launch profile changed during approval; approve again');};
      revalidate();
      const eula=await readFile(path.join(approval.serverDir,'eula.txt'),'utf8').catch(()=>'');
      if(!/^\s*eula\s*=\s*true\s*$/m.test(eula))throw new Error('Minecraft EULA acceptance is missing in the managed server copy; review and accept it yourself before launching');
      const ledger=this.ledger();const authority=await ledger.status();
      if(authority.snapshotId!==approval.snapshotId)throw new Error('Snapshot revision mismatch; reconcile metadata before hosting');
      revalidate();
      await ledger.startHosting();
      try{
        revalidate();
        const launched=new ServerProcess({executable:approval.profile.executable,args:[...approval.profile.args],cwd:approval.serverDir});
        this.process=launched;this.controlledProcess=launched;
        launched.on('line',(line:string)=>this.log(line));
        launched.on('state',(state:string)=>{
          if((state!=='offline'&&state!=='failed')||this.process!==launched||this.controlledProcess===launched)return;
          this.unexpectedExit=ledger;
          if(!this.busy)void this.operation('processExit',async()=>{}).catch(e=>this.log('Ownership recovery error: '+String(e)));
        });
        await launched.start();
      }catch(e){await ledger.markUncertain();throw e;}
      finally{this.controlledProcess=undefined;}
    });
  }
  sendCommand(command:string):void{if(this.busy)throw new Error('An operation is in progress');if(!this.process)throw new Error('Server not running');this.process.sendCommand(command);}
  async stopServer():Promise<void>{
    await this.operation('stopServer',async()=>{
      const server=this.saved.server;if(!server||!this.process?.pid)throw new Error('No owned process is running');
      this.controlledProcess=this.process;
      try{await this.process.stop();const snapshot=await createSnapshot(server.serverDir,server.storeDir,server.snapshotId);await this.ledger().stopHosting(snapshot.id);server.snapshotId=snapshot.id;await this.persist();this.log('Stopped cleanly and committed final snapshot '+snapshot.id);}
      catch(e){await this.ledger().markUncertain();throw e;}
      finally{this.controlledProcess=undefined;}
    });
  }
  async createSnapshot():Promise<void>{
    this.assertStopped();
    await this.operation('createSnapshot',async()=>{
      const server=this.saved.server;if(!server)throw new Error('No server imported');
      const owner=await this.ledger().status();if(owner.state!=='owned'||owner.owner!==this.identity.fingerprint)throw new Error('Snapshot requires safely held ownership');
      const snapshot=await createSnapshot(server.serverDir,server.storeDir,server.snapshotId);await this.ledger().updateSnapshot(snapshot.id);server.snapshotId=snapshot.id;await this.persist();this.log('Verified snapshot '+snapshot.id);
    });
  }
  async saveSettings(settings:Settings):Promise<void>{
    await this.operation('saveSettings',async()=>{this.saved.settings=validateSettings(settings);await this.persist();if(settings.persistentAddress)this.log('Persistent-address preference saved. Gateway is unconnected; no routing or public availability is established.');});
  }
  async addPeer(peer:SavedState['peers'][number]):Promise<void>{
    if(!peer||typeof peer.name!=='string'||!peer.name.trim()||peer.name.length>100||!/^[a-f0-9]{64}$/.test(peer.fingerprint)||!isValidEndpointHost(peer.host)||!Number.isInteger(peer.port)||peer.port<1||peer.port>65535)throw new Error('Invalid peer identity or endpoint');
    if(peer.fingerprint===this.identity.fingerprint)throw new Error('Cannot trust your own identity as a peer');
    await this.operation('addPeer',async()=>{this.saved.peers=this.saved.peers.filter(p=>p.fingerprint!==peer.fingerprint);this.saved.peers.push({...peer});await this.persist();if(this.listener){const port=this.listener.port;await this.listener.close();this.listener=undefined;await this.listen(port);}this.log('Saved trusted peer '+peer.name+'. Fingerprint trust does not establish connectivity.');});
  }
  private async listen(port=0):Promise<void>{
    this.listener=await listenPeer(this.identity,this.saved.peers.map(p=>p.fingerprint),(socket,source)=>{void this.handleIncoming(socket,source);},{host:'127.0.0.1',port});
  }
  async startPeerListener():Promise<void>{await this.operation('startPeerListener',async()=>{if(this.listener)throw new Error('Peer listener already active');await this.listen();this.log('Peer listener is loopback-only for local testing. No public or LAN connectivity is claimed.');});}
  private async handleIncoming(socket:TLSSocket,source:string):Promise<void>{
    try{await this.operation('receiveSnapshot',async(token)=>{
      let activation:Promise<boolean>|undefined;
      try{await receiveSnapshot(socket,source,path.join(this.root,'managed','store'),async(snapshot,authenticatedSource,offer)=>{
        this.log('Received verified snapshot '+snapshot.id+' from '+authenticatedSource+'. Replication alone does not grant hosting ownership.');
        if(!offer)return false;
        this.assertStopped();
        const previous=this.saved.server,original=JSON.stringify(this.saved.server);
        let originalAuthority:string|undefined;
        if(previous){const state=await this.ledger().status();originalAuthority=JSON.stringify(state);if(state.owner!==authenticatedSource||state.state==='hosting'||state.state==='uncertain'||offer.generation!==state.generation+1)throw new Error('Incoming ownership conflicts with this server. Verified replica retained without activation.');}
        const revalidate=(expected:SavedServer|null=previous,metadata:string=original)=>{
          try{
            if(this.operationToken!==token||socket.destroyed||socket.readableEnded||socket.writableEnded)throw new Error('Incoming session or operation has ended');
            this.assertStopped();
            if(this.saved.server!==expected||JSON.stringify(this.saved.server)!==metadata)throw new Error('Incoming server lineage changed during approval');
          }catch(error){this.log('Incoming handoff activation refused: '+String(error));throw error;}
        };
        if(!this.options.confirmIncomingHandoff||!await this.options.confirmIncomingHandoff(authenticatedSource,snapshot,offer))return false;
        revalidate();
        if(previous){const current=await this.ledger().status();revalidate();if(JSON.stringify(current)!==originalAuthority)throw new Error('Incoming ownership changed during approval');}
        const storeDir=path.join(this.root,'managed','store');
        const serverDir=path.join(this.root,'managed','servers',randomUUID());
        await materializeSnapshot(storeDir,snapshot.id,serverDir);
        revalidate();
        const ledgerFile=previous?.ledgerFile??path.join(this.root,'ownership-'+randomUUID()+'.sqlite');
        const candidate:SavedServer={name:previous?.name??'Received server',serverDir,storeDir,snapshotId:snapshot.id,profile:previous?{executable:previous.profile.executable,args:[...previous.profile.args]}:{executable:'',args:[]},ledgerFile};
        // Drain only activation, not a potentially abandoned native dialog, before releasing the operation.
        activation=(async()=>{
          let authorityAttempted=false;
          this.saved.server=candidate;
          const candidateMetadata=JSON.stringify(candidate);
          try{
            // Record the candidate before authority. Missing/mismatched ledgers fail closed on restart.
            await this.persist();
            revalidate(candidate,candidateMetadata);
            if(previous){const current=await new OwnershipLedger(ledgerFile,this.identity.fingerprint).status();revalidate(candidate,candidateMetadata);if(JSON.stringify(current)!==originalAuthority)throw new Error('Incoming ownership changed before activation');}
            authorityAttempted=true;
            await new OwnershipLedger(ledgerFile,this.identity.fingerprint).acceptTransfer(offer,authenticatedSource,snapshot.id);
            // Once authority may have committed, lost acknowledgment must never roll it back.
            this.log('Accepted ownership of '+snapshot.id+'. Previous server files retained. Configure a local launch profile and approve executable/mod trust before starting.');
            return true;
          }catch(error){
            if(!authorityAttempted){this.saved.server=previous;await this.persist();}
            else this.log('Ownership acceptance may have committed; candidate retained for explicit reconciliation.');
            throw error;
          }
        })();
        return await activation;
      });}finally{await activation?.catch(error=>this.log('Incoming activation failed: '+String(error)));}
    });}catch(e){this.log('Peer receive failed: '+String(e));}finally{socket.destroy();}
  }
  async sendSnapshot(fingerprint:string):Promise<unknown>{
    this.assertStopped();return this.operation('sendSnapshot',async()=>{
      const peer=this.saved.peers.find(p=>p.fingerprint===fingerprint);const server=this.saved.server;if(!peer||!server)throw new Error('Missing peer or imported server');
      const ownership=await this.ledger().status();if(ownership.owner!==this.identity.fingerprint||ownership.state!=='owned')throw new Error('Snapshot send requires safely held ownership');
      const result=await sendSnapshotToPeer(this.identity,peer,server.storeDir,server.snapshotId);
      this.log('Peer confirmed verified snapshot '+server.snapshotId+'; '+result.filesSent+' files / '+result.bytesSent+' bytes transferred directly. Hosting ownership unchanged.');return result;
    });
  }
  async recoverStopped(confirmedStopped:boolean):Promise<void>{
    this.assertStopped();
    if(!confirmedStopped)throw new Error('Confirm all previous server processes are stopped');
    await this.operation('recoverStopped',async()=>{
      const server=this.saved.server;if(!server)throw new Error('No server imported');
      const ledger=this.ledger(),state=await ledger.status();
      if(state.owner!==this.identity.fingerprint||state.state!=='uncertain'||state.offer)throw new Error('Cannot recover transferred or pending-offer authority. Reconcile with the peer.');
      const snapshot=await createSnapshot(server.serverDir,server.storeDir,state.snapshotId);
      server.snapshotId=snapshot.id;await this.persist();await ledger.recoverStopped(true);await ledger.updateSnapshot(snapshot.id);
      this.log('Explicit stopped-process recovery completed with verified snapshot '+snapshot.id+'. No uncertain remote takeover was performed.');
    });
  }
  async handoff(fingerprint:string):Promise<void>{
    this.assertStopped();
    await this.operation('handoff',async()=>{
      const peer=this.saved.peers.find(p=>p.fingerprint===fingerprint),server=this.saved.server;
      if(!peer||!server)throw new Error('Missing peer or imported server');
      const ledger=this.ledger(),state=await ledger.status();
      if(state.state!=='owned'||state.owner!==this.identity.fingerprint)throw new Error('Handoff requires safely held ownership');
      const snapshot=await createSnapshot(server.serverDir,server.storeDir,server.snapshotId);
      await ledger.updateSnapshot(snapshot.id);server.snapshotId=snapshot.id;await this.persist();
      const offer=await ledger.prepareTransfer(fingerprint,snapshot.id);
      this.log('Source fenced before offering ownership. Failure or missing acknowledgment will not restore local authority.');
      const result=await sendSnapshotToPeer(this.identity,peer,server.storeDir,snapshot.id,offer);
      if(!result.ownershipAccepted)throw new Error('Recipient did not accept ownership. Source remains fenced; do not start either copy without reconciling ownership.');
      await ledger.confirmTransfer(offer.id,fingerprint);
      this.log('Recipient confirmed verified revision and ownership. Hosting is now blocked on this device.');
    });
  }
  async close():Promise<void>{if(this.busy)throw new Error('An operation is in progress; wait before closing');if(this.process?.pid)await this.stopServer();if(this.listener){await this.listener.close();this.listener=undefined;}}
}
