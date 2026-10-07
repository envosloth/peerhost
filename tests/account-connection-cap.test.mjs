import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createIdentity,listenPeer} from '../dist/src/core/peer-transport.js';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';

test('AccountService rejects its 65th unfinished handshake and recovers capacity',async()=>{
  const root=await mkdtemp(path.join(process.env.TMPDIR,'account-cap-'));
  const identity=await createIdentity(),service=new AccountService(root,identity);await service.listen({host:'127.0.0.1',port:0});
  const clients=[];
  try{
    for(let i=0;i<64;i++){
      const c=connect(service.endpoint.port,'127.0.0.1');c.on('error',()=>{});clients.push(c);await once(c,'connect');
    }
    const extra=connect(service.endpoint.port,'127.0.0.1');extra.on('error',()=>{});clients.push(extra);
    assert.equal(await Promise.race([new Promise(r=>extra.once('close',()=>r(true))),new Promise(r=>setTimeout(()=>r(false),1000))]),true);
    for(const c of clients)c.destroy();
    const client=new AccountClient(await createIdentity(),{...service.endpoint,fingerprint:identity.fingerprint});
    await assert.rejects(client.call('me',{token:'0'.repeat(64)}),/Sign in again/,'a real authenticated handshake works after capacity is freed');
  }finally{for(const c of clients)c.destroy();await service.close();}
});

test('public account transport caps connections before TLS handshakes complete',async()=>{
  const identity=await createIdentity();
  const listener=await listenPeer(identity,[],()=>{}, {host:'127.0.0.1',port:0,maxConnections:2});
  const clients=[];
  try {
    for(let i=0;i<2;i++){
      const c=connect(listener.port,'127.0.0.1');clients.push(c);c.on('error',()=>{});await once(c,'connect');
    }
    const extra=connect(listener.port,'127.0.0.1');clients.push(extra);extra.on('error',()=>{});
    const closed=new Promise(resolve=>extra.once('close',()=>resolve(true)));
    const timer=new Promise(resolve=>setTimeout(()=>resolve(false),1000));
    assert.equal(await Promise.race([closed,timer]),true,'excess raw sockets must close before the TLS timeout');
    assert.equal(clients[0].destroyed,false,'existing unfinished handshake is preserved');
    assert.equal(clients[1].destroyed,false,'existing unfinished handshake is preserved');
  } finally {for(const c of clients)c.destroy();await listener.close();}
});
