import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {loadAccountServiceConfig}=await import('../dist/src/core/account-service-config.js');
const ep={host:'directory.example.org',port:10000,fingerprint:'a'.repeat(64)};
test('ordinary installations automatically use the bundled public directory without profile setup',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'account-default-'));
 const profile=path.join(root,'profile'),bundle=path.join(root,'bundle');await mkdir(profile);await mkdir(bundle);
 await writeFile(path.join(bundle,'public-account-service.json'),JSON.stringify(ep));
 assert.deepEqual(await loadAccountServiceConfig({profileRoot:profile,bundledDirectory:bundle,isolated:false}),ep);
 assert.equal(await loadAccountServiceConfig({profileRoot:profile,bundledDirectory:bundle,isolated:true}),undefined,'isolated profiles cannot register against production accidentally');
 const local={...ep,host:'private.example.org'};
 await writeFile(path.join(profile,'account-service.json'),JSON.stringify(local));
 assert.deepEqual(await loadAccountServiceConfig({profileRoot:profile,bundledDirectory:bundle,isolated:false}),local,'existing directory/profile identity wins');
 assert.deepEqual(await loadAccountServiceConfig({profileRoot:profile,bundledDirectory:bundle,isolated:true,override:JSON.stringify(ep)}),ep,'explicit isolated test endpoint works');
 await writeFile(path.join(profile,'account-service.json'),'{broken');
 await assert.rejects(loadAccountServiceConfig({profileRoot:profile,bundledDirectory:bundle,isolated:false}),SyntaxError,'corrupt profile config must not switch directories');
});
