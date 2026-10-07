// TEST-ONLY fault injection into the actual native-walk function, never a live store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
const exec=promisify(execFile);
async function probe(mode,child=true){
 const source=(await readFile(new URL('../src/core/snapshots.ts',import.meta.url),'utf8')).replaceAll('\r\n','\n');
 const body=source.slice(source.indexOf('function TestVanished('),source.indexOf('try {\n  foreach ($rootPath'));
 assert.ok(body.includes('function CheckPath('));
 const injected=body.replaceAll('[System.IO.File]::GetAttributes($p)','(GetTestAttributes $p)').replaceAll('[System.IO.Directory]::GetFileSystemEntries($p)','(GetTestEntries $p)');
 const script=`$ErrorActionPreference='Stop';$script:reads=0;$script:attrs=0;$mode='${mode}'
function GetTestAttributes([string]$p){$script:attrs++;if($mode -eq 'link' -and $script:attrs -gt 1){return [System.IO.FileAttributes]::ReparsePoint};if($mode -eq 'attr-denied'){throw [System.UnauthorizedAccessException]::new('TEST attr pending')};if($mode -eq 'attr-vanished'){if($script:attrs -eq 1){throw [System.UnauthorizedAccessException]::new('TEST attr pending')};throw [System.IO.DirectoryNotFoundException]::new('TEST vanished')};return [System.IO.FileAttributes]::Directory}
function GetTestEntries([string]$p){$script:reads++;if($mode -eq 'missing-root' -or ($mode -eq 'vanished' -and $script:reads -gt 1)){throw [System.IO.DirectoryNotFoundException]::new('TEST vanished')};throw [System.UnauthorizedAccessException]::new('TEST delete pending')}
${injected}
try{CheckPath 'TEST-ONLY-child' $true $${child?'true':'false'};Write-Output 'PASS'}catch{Write-Output ('REFUSED '+$_.Exception.Message);exit 1}finally{Write-Output ('READS='+$script:reads);Write-Output ('ATTRS='+$script:attrs)}`;
 try{const r=await exec((process.env.SystemRoot||'C:/Windows')+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:12000,windowsHide:true});return{code:0,out:r.stdout};}catch(e){return{code:e.code,out:e.stdout||e.stderr||String(e)};}
}
test('native walk only tolerates delete-pending children after a bounded retry confirms disappearance',{skip:process.platform!=='win32'},async()=>{
 const vanished=await probe('vanished');assert.equal(vanished.code,0,vanished.out);assert.match(vanished.out,/READS=2/);
 const denied=await probe('denied');assert.equal(denied.code,1);assert.match(denied.out,/TEST delete pending/);assert.match(denied.out,/READS=[2-5]\b/);
 const link=await probe('link');assert.equal(link.code,1);assert.match(link.out,/Reparse point forbidden/);
 const missingRoot=await probe('missing-root',false);assert.equal(missingRoot.code,1);
 const deniedRoot=await probe('denied',false);assert.equal(deniedRoot.code,1);assert.match(deniedRoot.out,/READS=1/);
 const attrVanished=await probe('attr-vanished');assert.equal(attrVanished.code,0,attrVanished.out);assert.match(attrVanished.out,/ATTRS=2/);
 const attrDenied=await probe('attr-denied');assert.equal(attrDenied.code,1,attrDenied.out);assert.match(attrDenied.out,/TEST attr pending/);assert.match(attrDenied.out,/ATTRS=[2-5]\b/);
 const attrDeniedRoot=await probe('attr-denied',false);assert.equal(attrDeniedRoot.code,1);assert.match(attrDeniedRoot.out,/ATTRS=1\b/);
});
