// Builds the GitHub release assets from the newest packaged folder: SeedHost-<version>-win32-x64.zip
// plus SHA256SUMS.txt (the two assets the in-app updater consumes), using the Windows bundled tar
// (bsdtar) for the zip step. Run after `npm run package:windows`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const p = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseRoot = path.join(root, 'release');
const candidates = [];
for (const name of await readdir(releaseRoot).catch(() => [])) {
  if (!name.startsWith('alpha-')) continue;
  const directory = path.join(releaseRoot, name);
  const packageDir = path.join(directory, 'SeedHost-win32-x64');
  try { await access(path.join(packageDir, 'SeedHost.exe')); } catch { continue; }
  candidates.push({ directory, packageDir, mtime: (await stat(packageDir)).mtimeMs });
}
if (!candidates.length) throw new Error('No release/alpha-*/SeedHost-win32-x64 package found; run npm run package:windows first');
candidates.sort((a, b) => b.mtime - a.mtime);
const chosen = candidates[0];
const zipName = `SeedHost-${p.version}-win32-x64.zip`;
const zipPath = path.join(releaseRoot, zipName);
await rm(zipPath, { force: true });
// The zip must keep the internal top-level folder name the updater stages and mirrors: SeedHost-win32-x64.
const tar = spawnSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zipPath, '-C', chosen.directory, 'SeedHost-win32-x64'], { stdio: 'inherit' });
if (tar.error || tar.status !== 0) throw new Error('tar failed: ' + (tar.error ? tar.error.message : 'exit ' + tar.status));
const hash = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  const s = createReadStream(zipPath);
  s.on('data', (c) => h.update(c));
  s.on('error', reject);
  s.on('end', () => resolve(h.digest('hex')));
});
const size = (await stat(zipPath)).size;
const sums = path.join(releaseRoot, 'SHA256SUMS.txt');
await writeFile(sums, `${hash}  ${zipName}\n`);
console.log('PACKAGE_DIRECTORY=' + chosen.packageDir);
console.log('RELEASE_ZIP=' + zipPath);
console.log('RELEASE_ZIP_BYTES=' + size);
console.log('RELEASE_ZIP_SHA256=' + hash);
console.log('SHA256SUMS=' + sums);
