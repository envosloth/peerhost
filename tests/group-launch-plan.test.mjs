import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as application from '../dist/src/core/application.js';

test('group launch metadata derives only an unambiguous relative Java JAR plan', async t => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR, 'group-launch-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'server.jar'), 'synthetic fixture jar');
  assert.equal(typeof application.groupJavaLaunchArgs, 'function');
  assert.deepEqual(await application.groupJavaLaunchArgs(dir), ['-jar', 'server.jar', 'nogui']);
  assert.deepEqual(await application.groupJavaLaunchArgs(dir, ['-Xmx4096M', '-Dfixture.key=value', '-XX:+UseG1GC', '-jar', 'previous.jar', 'nogui']), ['-Xmx4096M', '-Dfixture.key=value', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui']);
  await assert.rejects(application.groupJavaLaunchArgs(dir, ['-javaagent:C:/unapproved.jar', '-jar', 'server.jar']), /Custom Java arguments/);
  await assert.rejects(application.groupJavaLaunchArgs(dir, ['@peer-args.txt']), /launch plan/);
  await writeFile(path.join(dir, 'peer-helper.jar'), 'synthetic ambiguity');
  await assert.rejects(application.groupJavaLaunchArgs(dir), error => {
    assert.match(error.message, /unambiguous/);
    assert.match(error.message, /Group Start/);
    assert.doesNotMatch(error.message, /advanced Launch profile/i);
    return true;
  });
  await rm(path.join(dir, 'peer-helper.jar'));
  await writeFile(path.join(dir, 'fabric-server-launch.jar'), 'synthetic Fabric layout');
  assert.deepEqual(await application.groupJavaLaunchArgs(dir), ['-jar', 'fabric-server-launch.jar', 'nogui']);
  await writeFile(path.join(dir, 'run.bat'), 'synthetic unapproved script');
  await assert.rejects(application.groupJavaLaunchArgs(dir), error => {
    assert.match(error.message, /scripted server/);
    assert.match(error.message, /Group Start/);
    assert.doesNotMatch(error.message, /advanced Launch profile/i);
    return true;
  });
});
