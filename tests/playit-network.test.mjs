import test from 'node:test';
import assert from 'node:assert/strict';
import {playitApi, probeMinecraft, publicIPv4} from '../dist/src/core/playit-network.js';
test('playit network refuses unapproved routes and unsafe probe hosts',async()=>{
 await assert.rejects(playitApi('a'.repeat(64),'/login/signin'),/route/);
 assert.equal(await probeMinecraft({host:'localhost',serverName:'localhost',port:22}),false);
 for(const ip of ['127.0.0.1','10.2.3.4','192.168.1.2','169.254.169.254','100.97.20.84','0.0.0.0','224.0.0.1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('147.185.221.216'),true);
});
