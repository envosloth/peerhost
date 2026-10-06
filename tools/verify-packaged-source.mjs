// Resource-equivalence gate; an Electron EXE hash alone cannot identify updated app code.
import assert from 'node:assert/strict';
import {readFile,readdir,stat,access,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const executable=process.argv.find(arg=>arg.startsWith('--packaged='))?.slice('--packaged='.length);
assert.ok(typeof executable==='string'&&path.isAbsolute(executable)&&!/[\0\r\n]/.test(executable),'Use --packaged=<absolute executable>; never fall back to source');
assert.ok(process.env.TMPDIR,'Verification reports must stay in scratch');
const project=process.cwd(),bundled=path.join(path.dirname(executable),'resources','app');
assert.ok((await stat(executable)).isFile(),'Packaged executable must exist');
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const files=[];
async function visit(relative){
  for(const entry of await readdir(path.join(project,relative),{withFileTypes:true})){
    const item=path.join(relative,entry.name);
    if(relative==='dist'&&['tests','tools'].includes(entry.name))continue;
    assert.ok(!entry.isSymbolicLink(),'Unexpected source resource link: '+item);
    if(entry.isDirectory())await visit(item);
    else if(entry.isFile())files.push(item);
  }
}
await visit('dist');await visit('apps');files.sort();
assert.ok(files.length>0,'No source resources were found');
const verified=[];
for(const relative of files){
  const expected=sha(await readFile(path.join(project,relative)));
  const actual=sha(await readFile(path.join(bundled,relative)));
  assert.equal(actual,expected,'Stale or mismatched packaged source: '+relative);
  verified.push({path:relative.replaceAll('\\','/'),sha256:actual});
}
for(const privatePath of ['.git','.test-data','.env','.env.local','identity.json','state.json','node_modules/electron','node_modules/playwright']){
  await assert.rejects(access(path.join(bundled,privatePath)),{code:'ENOENT'},'Private/development data must not be bundled: '+privatePath);
}
const bytes=await readFile(executable),report={executable,executableBytes:bytes.length,executableSha256:sha(bytes),sourceFilesVerified:verified.length,files:verified,scope:'Resource equivalence and packaging exclusions only; separate exact-package desktop and Minecraft checks are required.'};
const out=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-package-equivalence-'));
await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({executable:report.executable,executableSha256:report.executableSha256,executableBytes:report.executableBytes,sourceFilesVerified:report.sourceFilesVerified,report:path.join(out,'report.json'),scope:report.scope},null,2));
