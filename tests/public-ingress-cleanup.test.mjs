import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installInterruptCleanup} from '../tools/interrupt-cleanup.mjs';

for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]])test(`${signal} waits for restoration before reporting interrupted exit`,async()=>{
 const emitter=new EventEmitter();const events=[];let release;
 const gate=new Promise(r=>{release=r;});
 const dispose=installInterruptCleanup({emitter,cleanup:async()=>{events.push('restoring');await gate;events.push('restored');},exit:c=>events.push(c),report:()=>assert.fail('unexpected failure')});
 emitter.emit(signal);assert.deepEqual(events,['restoring']);
 assert.equal(emitter.emit(signal),true,'repeated identical signals remain handled while restoration is pending');
 assert.deepEqual(events,['restoring'],'cleanup runs only once');
 emitter.emit(signal==='SIGINT'?'SIGTERM':'SIGINT');
 release();await new Promise(r=>setImmediate(r));assert.deepEqual(events,['restoring','restored',code]);
 dispose();assert.equal(emitter.listenerCount('SIGINT'),0);assert.equal(emitter.listenerCount('SIGTERM'),0);
});
test('failed restoration reports failure and exits nonzero',async()=>{
 const emitter=new EventEmitter();const events=[];
 const dispose=installInterruptCleanup({emitter,cleanup:async()=>{throw Error('restore refused');},exit:c=>events.push(c),report:e=>events.push(e.message)});
 emitter.emit('SIGINT');await new Promise(r=>setImmediate(r));assert.deepEqual(events,['restore refused',1]);dispose();
});
