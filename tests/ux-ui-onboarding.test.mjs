import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {SETUP_STEPS,defaultOnboarding,validateOnboarding,onboardingChecks,saveOnboarding,readOnboarding} from '../dist/src/core/onboarding.js';
const input=()=>{const {version,...p}=defaultOnboarding();return p;};
test('social request configuration survives per-world reopening without claiming friendship',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ux-ui-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p={...input(),step:'friends',friendsConfigured:'request-pending'};await saveOnboarding(root,p,'a'.repeat(32));
 assert.equal((await readOnboarding(root,true,'a'.repeat(32))).friendsConfigured,'request-pending');
 assert.equal((await readOnboarding(root,true,'b'.repeat(32))).friendsConfigured,undefined);
 assert.equal(onboardingChecks({...p,completed:true},{server:{profile:{executable:'java',args:['nogui']}}}).ready,'complete');
 assert.throws(()=>validateOnboarding({...p,friendsConfigured:'friends-with-sam'}),/Invalid/);
});
test('legacy gateway stage migrates without modifying source metadata or requiring gateway',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ux-ui-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'onboarding.json'),legacy=JSON.stringify({version:1,...input(),step:'gateway',skipped:['friends','gateway']});await writeFile(file,legacy);
 const p=await readOnboarding(root,true);assert.equal(p.step,'ready');assert.deepEqual(p.skipped,['friends']);assert.equal(await readFile(file,'utf8'),legacy);
 assert.deepEqual(SETUP_STEPS,['server','runtime','friends','ready']);
 assert.equal(onboardingChecks({...input(),completed:true,skipped:['friends']},{server:{profile:{executable:'java',args:['nogui']}}}).ready,'complete');
});
