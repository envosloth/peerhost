import test from 'node:test';import assert from 'node:assert/strict';
import { InlineHandoffConsent } from '../dist/apps/desktop/inline-consent.js';
const api={InlineHandoffConsent};
test('incoming ownership waits for exact inline consent, never autoaccepts',async()=>{
 assert.equal(typeof api.InlineHandoffConsent,'function');const gate=new api.InlineHandoffConsent();
 let settled=false;const pending=gate.request('a'.repeat(64),'b'.repeat(64)).then(v=>{settled=true;return v;});
 await Promise.resolve();assert.equal(settled,false);const item=gate.status();assert.equal(item.source,'a'.repeat(64));
 assert.throws(()=>gate.respond('wrong',true),/changed|pending/);assert.equal(settled,false);
 gate.respond(item.id,true);assert.equal(await pending,true);assert.equal(gate.status(),null);
});
test('incoming ownership expiration is request-scoped and declines without a user response',async t=>{
 const timers=[];t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;});t.mock.method(globalThis,'clearTimeout',()=>{});
 const gate=new InlineHandoffConsent(),first=gate.request('first','one');gate.respond(gate.status().id,true);assert.equal(await first,true);
 const second=gate.request('second','two');const id=gate.status().id;
 assert.equal(await gate.request('third','three'),false,'a concurrent unsolicited offer is declined');
 timers[0].callback();assert.equal(gate.status().id,id,'an old expiration cannot decline a new request');
 assert.equal(timers[1].delay,120000);timers[1].callback();assert.equal(await second,false);assert.equal(gate.status(),null);
});
