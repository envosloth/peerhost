import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { AccountClient, AccountService, accountPassword } from '../dist/src/core/accounts.js';
import { validateCall } from '../dist/src/core/ipc-policy.js';

const renderer = 'file:///fixture/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };
async function directory(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'password-policy-'));
  const [server, device] = await Promise.all([createIdentity(), createIdentity()]);
  const service = new AccountService(root, server);
  await service.listen({ host: '127.0.0.1' });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, device, endpoint: { ...service.endpoint, fingerprint: server.fingerprint } };
}

test('four characters register and log in through the same desktop and service policy', async t => {
  const { device, endpoint } = await directory(t);
  const client = new AccountClient(device, endpoint);
  const credentials = { username: 'alice', password: 'abcd' };
  const registered = await client.call('register', credentials);
  assert.equal(registered.username, 'alice');
  assert.equal((await client.call('login', credentials)).username, 'alice');
  for (const method of ['accountRegister', 'accountLogin']) {
    assert.deepEqual(validateCall(method, credentials, renderer, renderer, trusted), credentials);
  }
  const html = await readFile(new URL('../apps/desktop/index.html', import.meta.url), 'utf8');
  const input = /<input\b[^>]*id="account-password"[^>]*>/.exec(html)?.[0];
  assert.match(input, /minlength="4"/);
  assert.match(input, /maxlength="128"/);
  const help = /<p\b[^>]*id="account-password-help"[^>]*>([^<]*)<\/p>/.exec(html)?.[1];
  assert.match(help, /4/);
  assert.match(help, /weak/i, 'minimum-length passwords must carry a weakness warning');
});

test('password policy rejects short, overlong and all control-character credentials consistently', async t => {
  const { device, endpoint } = await directory(t);
  for (const invalid of ['abc', 'x'.repeat(129), 'a\0bc', 'a\nbc', 'a\tbc', 'a\u007fbc', 'a\u0085bc', 1234]) {
    assert.throws(() => accountPassword(invalid), /4–128|control/);
    for (const method of ['accountRegister', 'accountLogin']) {
      assert.throws(() => validateCall(method, { username: 'alice', password: invalid }, renderer, renderer, trusted), /4–128|control/);
    }
  }
  assert.equal(accountPassword('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(accountPassword(' café '), ' café ', 'do not trim or normalize passwords');
  const client = new AccountClient(device, endpoint);
  await assert.rejects(client.call('register', { username: 'alice', password: 'a\nbc' }), /control/);
});

test('the native password form rejects control characters without changing password contents', async () => {
  const html = await readFile(new URL('../apps/desktop/index.html', import.meta.url), 'utf8');
  const input = /<input\b[^>]*id="account-password"[^>]*>/.exec(html)?.[0];
  const pattern = /\bpattern="([^"]*)"/.exec(input)?.[1];
  assert.equal(typeof pattern, 'string', 'HTML needs the same controls rejection as IPC and the service');
  const allowed = new RegExp(`^(?:${pattern})$`, 'v');
  for (const invalid of ['a\tbc', 'a\u007fbc', 'a\u0085bc']) assert.equal(allowed.test(invalid), false);
  for (const valid of ['abcd', ' café ', 'x'.repeat(128)]) assert.equal(allowed.test(valid), true);
});

test('four-character credentials retain salted scrypt parameters and hashed device-bound sessions', async t => {
  const { root, device, endpoint } = await directory(t);
  const client = new AccountClient(device, endpoint);
  const session = await client.call('register', { username: 'alice', password: 'abcd' });
  const db = new DatabaseSync(path.join(root, 'accounts.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT salt, hash FROM accounts WHERE username=?').get('alice');
    assert.match(row.salt, /^[a-f0-9]{64}$/);
    const expected = await promisify(scrypt)('abcd', row.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    assert.equal(row.hash, expected.toString('hex'), 'do not reduce scrypt work or derived-key length');
    const stored = db.prepare('SELECT digest, fingerprint FROM sessions WHERE username=?').get('alice');
    assert.equal(stored.digest, createHash('sha256').update(session.token).digest('hex'));
    assert.notEqual(stored.digest, session.token);
    assert.equal(stored.fingerprint, device.fingerprint);
  } finally { db.close(); }
  const attacker = new AccountClient(await createIdentity(), endpoint);
  await assert.rejects(attacker.call('me', { token: session.token }), /Sign in again/);
  assert.equal((await client.call('me', { token: session.token })).username, 'alice');
  assert.ok(!(await readFile(path.join(root, 'accounts.sqlite'))).includes(Buffer.from('abcd')));
  assert.equal((await client.call('register', { username: 'longsecret', password: 'x'.repeat(128) })).username, 'longsecret');
});

test('short passwords do not bypass the ten-authentication-attempt IP limit', async t => {
  const { device, endpoint } = await directory(t);
  const client = new AccountClient(device, endpoint);
  await client.call('register', { username: 'alice', password: 'abcd' });
  for (let i = 0; i < 9; i++) {
    await assert.rejects(client.call('login', { username: 'alice', password: 'wxyz' }), /Username or password is incorrect/);
  }
  await assert.rejects(client.call('login', { username: 'alice', password: 'abcd' }), /Too many requests/);
});

test('account request abuse limiting still caps a bound session at 120 requests per IP per minute', async t => {
  const { device, endpoint } = await directory(t);
  const client = new AccountClient(device, endpoint);
  const session = await client.call('register', { username: 'alice', password: 'abcd' });
  for (let i = 0; i < 119; i++) assert.equal((await client.call('me', { token: session.token })).username, 'alice');
  // The 121st request in the minute is refused; a tear-down may surface as a reset instead of the message.
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(client.call('me', { token: session.token }), /Too many requests|reset|closed|disconnect|timed out/i);
  }
});
