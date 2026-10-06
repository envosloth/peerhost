import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
test('canonical runner bounds simultaneous test workers without skipping files',{timeout:45000},async t=>{
  const root=await mkdtemp(path.join(process.env.TMPDIR,'runner-concurrency-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['tools','dist/tests','tests'])await mkdir(path.join(root,dir),{recursive:true});
  await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(path.join(root,'tools/run-tests.mjs'),await readFile(new URL('../tools/run-tests.mjs',import.meta.url),'utf8'));
  for(let i=0;i<4;i++){
    const timing=path.join(root,'timing-'+i+'.json');
    const fixture=i===3?path.join(root,'tests/fixture-3.test.mjs'):path.join(root,'dist/tests/fixture-'+i+'.test.js');
    await writeFile(fixture,`import test from 'node:test';import {writeFile} from 'node:fs/promises';test('fixture ${i}',async()=>{const start=Date.now();await new Promise(r=>setTimeout(r,500));await writeFile(${JSON.stringify(timing)},JSON.stringify({start,end:Date.now()}));});`);
  }
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  await exec(process.execPath,[path.join(root,'tools/run-tests.mjs')],{cwd:root,env,timeout:30000});
  const events=[];
  for(let i=0;i<4;i++){const timing=JSON.parse(await readFile(path.join(root,'timing-'+i+'.json'),'utf8'));assert.ok(timing.end>timing.start);events.push({at:timing.start,delta:1},{at:timing.end,delta:-1});}
  events.sort((a,b)=>a.at-b.at||a.delta-b.delta);
  let active=0,peak=0;for(const event of events){active+=event.delta;peak=Math.max(peak,active);}
  assert.equal(active,0);assert.ok(peak>=1);assert.ok(peak<=2,'actual runner started '+peak+' fixture workers simultaneously; desktop and TLS fixtures must retain resource headroom');
});
