import test from 'node:test';
import assert from 'node:assert/strict';
import * as network from '../dist/src/core/playit-network.js';
test('detailed probe reports DNS failure without attempting unsafe transport',async()=>{
 assert.equal(typeof network.probeMinecraftDetailed,'function');
 assert.deepEqual(await network.probeMinecraftDetailed({host:'localhost',serverName:'localhost',port:22}),{ok:false,failure:'dns-failure'});
});
test('public address policy rejects documentation and reserved ranges',()=>{
 for(const ip of ['192.0.2.1','198.51.100.8','203.0.113.9','192.88.99.1'])assert.equal(network.publicIPv4(ip),false,ip);
});
test('SRV rejects unsafe targets and private answers; DNS timeouts never fall back',async()=>{
 const ep={host:'mossy-hollow.tun.ply.gg',serverName:'mossy-hollow.tun.ply.gg',port:25565};
 for(const name of ['localhost','evil.example','edge.at.ply.gg.','edge..ply.gg'])await assert.rejects(network.resolveMinecraftEndpoint(ep,{resolveSrv:async()=>[{name,port:42,priority:0,weight:0}],lookup:async()=>[{address:'147.185.221.216',family:4}]}));
 await assert.rejects(network.resolveMinecraftEndpoint(ep,{resolveSrv:async()=>{throw Object.assign(Error('timeout'),{code:'ETIMEOUT'});},lookup:async()=>[{address:'147.185.221.216',family:4}]}));
 await assert.rejects(network.resolveMinecraftEndpoint(ep,{resolveSrv:async()=>[],lookup:async()=>[{address:'147.185.221.216',family:4},{address:'127.0.0.1',family:4}]}));
});
test('Minecraft SRV resolves its target, retaining the original handshake hostname', async () => {
  assert.equal(typeof network.resolveMinecraftEndpoint, 'function');
  const looked = [];
  const endpoint = await network.resolveMinecraftEndpoint({host:'mossy-hollow.tun.ply.gg',serverName:'mossy-hollow.tun.ply.gg',port:25565}, {
    resolveSrv:async()=>[{name:'edge.at.ply.gg',port:52971,priority:0,weight:1}],
    lookup:async host=>{looked.push(host);return [{address:'147.185.221.216',family:4}];},
  });
  assert.deepEqual(looked,['edge.at.ply.gg']);
  assert.deepEqual(endpoint,{host:'147.185.221.216',port:52971,serverName:'mossy-hollow.tun.ply.gg'});
});
