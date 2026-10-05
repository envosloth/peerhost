import {packager} from '@electron/packager';
import {access,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const p=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await access(path.join(root,p.main));
await mkdir(path.join(root,'release'),{recursive:true});
const out=await mkdtemp(path.join(root,'release','alpha-'));
console.log('Packaging a local unsigned Windows alpha. This is not a release approval or Minecraft verification.');
const directories=await packager({dir:root,name:'SeedHost',platform:'win32',arch:'x64',out,
  asar:false,prune:true,overwrite:false,tmpdir:process.env.TMPDIR||out,
  ignore:[/^\/\.git(?:\/|$)/,/^\/\.test-data(?:\/|$)/,/^\/release(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/src(?:\/|$)/,/^\/tools(?:\/|$)/,/^\/dist\/(?:tests|tools)(?:\/|$)/,/^\/AGENTS\.md$/],
  // The exe keeps its SeedHost.exe name; Windows shows the Seed Hosting product name and seed icon.
  icon:path.join(root,'apps','desktop','icon.ico'),
  win32metadata:{ProductName:'Seed Hosting',FileDescription:'Seed Hosting — Minecraft servers you share with friends (alpha)','requested-execution-level':'asInvoker'},
});
assert.equal(directories.length,1);
const directory=directories[0],executable=path.join(directory,'SeedHost.exe');
await access(executable);
const bundled=path.join(directory,'resources','app');
for(const f of [p.main,'apps/desktop/index.html','apps/desktop/renderer.js','apps/desktop/icon.png','node_modules/selfsigned/index.js'])await access(path.join(bundled,f));
for(const f of ['.test-data','identity.json','state.json','node_modules/playwright','node_modules/electron'])await assert.rejects(access(path.join(bundled,f)),{code:'ENOENT'});
const manifest={version:p.version,directory,executable,unsigned:true,verification:'packaging/file checks only; run visible desktop-handoff-check against this exact executable'};
const manifestPath=path.join(out,'package-manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log('PACKAGE_DIRECTORY='+directory);console.log('PACKAGE_EXECUTABLE='+executable);console.log('PACKAGE_MANIFEST='+manifestPath);
