import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {createIdentity,connectPeer} from '../dist/src/core/peer-transport.js';

test('DNS relay connections send routing SNI while still pinning the actual peer certificate',async t=>{
 const [serverIdentity,clientIdentity,wrongIdentity]=await Promise.all([createIdentity(),createIdentity(),createIdentity()]);
 const seen=[],sockets=new Set();
 const server=tls.createServer({key:serverIdentity.keyPem,cert:serverIdentity.certPem,requestCert:true,rejectUnauthorized:false},socket=>{seen.push(socket.servername);socket.write('SeedHost/1\n');socket.on('error',()=>{});});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('tlsClientError',()=>{});
 await new Promise(resolve=>server.listen(0,'localhost',resolve));
 t.after(()=>new Promise(resolve=>{for(const s of sockets)s.destroy();server.close(resolve);}));
 const port=server.address().port;
 const socket=await connectPeer(clientIdentity,serverIdentity.fingerprint,'localhost',port);socket.destroy();
 assert.equal(seen[0],'localhost','public TLS ingress needs the endpoint hostname in ClientHello');
 await assert.rejects(connectPeer(clientIdentity,wrongIdentity.fingerprint,'localhost',port),/fingerprint/);
});
