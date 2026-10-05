import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';

test('directory CLI exports a public proxy port independently from its private listener',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'account-cli-')),file=path.join(root,'client.json');
 const child=spawn(process.execPath,['dist/src/accounts/cli.js','--root',root,'--host','127.0.0.1','--port','0','--advertise','group.example','--advertise-port','10000','--client-config',file],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
 const output=await new Promise((resolve,reject)=>{let text='',err='';const timer=setTimeout(()=>reject(new Error('directory did not start')),10000);child.stdout.on('data',v=>{text+=v;if(text.includes('ACCOUNT_SERVICE=')){clearTimeout(timer);resolve(text);}});child.stderr.on('data',v=>err+=v);child.once('exit',code=>{clearTimeout(timer);reject(new Error('directory exited '+code+': '+err));});});
 assert.ok(output.includes('ACCOUNT_SERVICE='));const endpoint=JSON.parse(await readFile(file,'utf8'));assert.equal(endpoint.host,'group.example');assert.equal(endpoint.port,10000);assert.match(endpoint.fingerprint,/^[a-f0-9]{64}$/);
});
