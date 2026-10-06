import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { desktopArtifactLaunch } from '../tools/desktop-artifact-launch.mjs';
const project = path.resolve('.');
const profile = path.resolve(process.env.TMPDIR, 'artifact-launch-fixture');
test('real dashboard checker uses the validated artifact/profile launch contract', async () => {
  const source = await readFile(path.join(project, 'tools/desktop-dashboard-check.mjs'), 'utf8');
  assert.match(source, /import\s*\{\s*desktopArtifactLaunch\s*\}\s*from ['"]\.\/desktop-artifact-launch\.mjs['"]/);
  assert.match(source, /desktopArtifactLaunch\(path\.resolve\('\.'\), profile, packed\)/);
  assert.doesNotMatch(source, /executablePath:\s*packed\s*\?\?/);
});
test('packaged QA launches the exact artifact and still supplies an explicit isolated profile', () => {
  const executable = path.resolve(process.env.TMPDIR, 'QA artifact', 'SeedHost.exe');
  const options = desktopArtifactLaunch(project, profile, executable);
  assert.equal(options.executablePath, executable);
  assert.deepEqual(options.args, ['--profile-root=' + profile]);
});
test('source QA selects the compiled main entry and retains its isolated profile', () => {
  const options = desktopArtifactLaunch(project, profile);
  assert.equal(path.isAbsolute(options.executablePath), true);
  assert.deepEqual(options.args, [path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + profile]);
});
test('QA launch configuration refuses relative executables, malformed values and missing profile isolation', () => {
  for (const value of ['', 'SeedHost.exe', 'https://example.invalid/SeedHost.exe', '\0', 'C:/bad\nSeedHost.exe', 1, false]) {
    assert.throws(() => desktopArtifactLaunch(project, profile, value), /artifact/i);
  }
  for (const value of ['', '.', undefined, null]) assert.throws(() => desktopArtifactLaunch(project, value), /profile/i);
});
