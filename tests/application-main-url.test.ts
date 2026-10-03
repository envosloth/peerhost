import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

test('desktop expected renderer URL preserves Windows spaces and hash as encoded filename bytes',async()=>{
  const main=await readFile(path.resolve('dist/apps/desktop/main.js'),'utf8');
  const expression=main.match(/const rendererUrl\s*=\s*([^;]+);/)?.[1];
  assert.ok(expression,'exercise the actual emitted main URL expression, not a test implementation');
  const html=process.platform==='win32'?'C:\\Users\\Fixture User\\PeerHost # alpha\\apps\\desktop\\index.html':'/fixture user/PeerHost # alpha/apps/desktop/index.html';
  const actual=runInNewContext(expression,{html,URL,pathToFileURL});
  assert.equal(actual,pathToFileURL(html).href);
  assert.ok(actual.includes('%20'));assert.ok(actual.includes('%23'));
  assert.equal(new URL(actual).hash,'');assert.equal(fileURLToPath(actual),html);
});
