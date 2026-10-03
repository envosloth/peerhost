import assert from 'node:assert/strict';
import test from 'node:test';

import * as paths from '../src/core/paths.js';

test('rejects unsafe Windows aliases and escape paths without repairing them', () => {
  const unsafe = ['', '.', '..', '../world', 'world/../level.dat', '/world', '//server/share',
    '\\\\server\\share', 'C:/world', 'C:world', '\\world', 'world//region', 'world/./region',
    'world/', 'world:stream', 'level.dat:hidden', 'NUL', 'con.txt', 'COM1.jar', 'LPT9',
    'COM¹.log', 'CONIN$', 'CLOCK$', 'NUL .txt', 'world.', 'world ', 'world/file. ',
    'bad?file', 'bad*file', 'bad|file', 'bad<file', 'bad>file', 'bad"file', 'bad\u0000file',
    'bad\u001ffile', 'bad\u007ffile', 'cafe\u0301.dat'];
  for (const path of unsafe) {
    assert.throws(() => paths.validateRelativePath(path), /unsafe|relative|path|reserved/i, path);
  }
});

for (const [kind, surrogate] of [['high', '\ud800'], ['low', '\udc00']] as const) {
  test(`rejects unpaired ${kind} surrogates in relative paths`, () => {
    for (const path of [surrogate, `${surrogate}/a.txt`, `world/${surrogate}.txt`,
      `world/a${surrogate}`, `${surrogate}\\a.txt`]) {
      assert.throws(() => paths.validateRelativePath(path), /unsafe|path|unicode/i, JSON.stringify(path));
    }
  });
}

test('preserves paired emoji, non-ASCII NFC names, and literal replacement characters', () => {
  for (const path of ['world/\ud83d\ude00.txt', 'world/\ud83d\ude00\ud83d\ude80.txt',
    '\u4e16\u754c/caf\u00e9.txt', '\ufffd/b.txt']) {
    assert.equal(paths.validateRelativePath(path), path);
  }
  assert.equal(paths.validateRelativePath('world\\\ud83d\ude00.txt'), 'world/\ud83d\ude00.txt');
});

test('normalizes safe relative Windows separators to forward slashes', () => {
  assert.equal(typeof paths.validateRelativePath, 'function', 'relative-path validator must exist');
  assert.equal(paths.validateRelativePath('world\\region\\r.0.0.mca'), 'world/region/r.0.0.mca');
  assert.equal(paths.validateRelativePath('mods/example-1.0.jar'), 'mods/example-1.0.jar');
});
