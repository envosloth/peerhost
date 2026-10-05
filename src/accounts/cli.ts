#!/usr/bin/env node
// Account directory: metadata and hashed credentials only. No worlds, game gateway or relay trust.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { AccountService, accountEndpoint } from '../core/accounts.js';
import { loadOrCreateRelayIdentity } from '../core/relay.js';
import { durableJSON } from '../core/relay-friends-store.js';
const { values }=parseArgs({ options:{ root:{type:'string'},host:{type:'string'},port:{type:'string'},advertise:{type:'string'},'advertise-port':{type:'string'},'client-config':{type:'string'} } });
if(!values.root)throw new Error('Usage: node dist/src/accounts/cli.js --root <private directory> [--host 127.0.0.1] [--port 47640] [--advertise <reachable host>] [--advertise-port <public proxy port>] [--client-config <json file>]');
const port=Number(values.port ?? 47640);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
const identity=await loadOrCreateRelayIdentity(values.root);
const service=new AccountService(values.root,identity);
await service.listen({host:values.host ?? '127.0.0.1',port});
try {
 const host=values.advertise ?? service.endpoint!.host;
 const config=accountEndpoint({host,port:values['advertise-port']===undefined?service.endpoint!.port:Number(values['advertise-port']),fingerprint:identity.fingerprint});
 if(values['client-config'])await durableJSON(path.resolve(values['client-config']),config);
 console.log('ACCOUNT_SERVICE='+JSON.stringify(config));
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0);};
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}catch(e){await service.close();throw e;}
