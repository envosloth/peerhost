import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The Windows shortcut / taskbar icon must be a real multi-size .ico built from the same mark as icon.png.
test('icon.ico holds PNG images at the sizes Windows uses', async () => {
  const ico = await readFile(new URL('../apps/desktop/icon.ico', import.meta.url)).catch(() => Buffer.alloc(0));
  assert.ok(ico.length > 6, 'apps/desktop/icon.ico exists');
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length, `entry ${size} lies inside the file`);
    assert.deepEqual([...ico.subarray(offset, offset + 8)], [137, 80, 78, 71, 13, 10, 26, 10], `entry ${size} is PNG data`);
    assert.equal(ico.readUInt32BE(offset + 16), size, `entry ${size} PNG width matches its directory entry`);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 256]);
});
