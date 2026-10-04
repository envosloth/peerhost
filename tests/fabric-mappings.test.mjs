import test from 'node:test';
import assert from 'node:assert/strict';

// Fabric's mapping rule, independent of downloads: require exactly what Fabric's loader metadata declares.
const { checkFabricMappings } = await import('../dist/src/core/server-setup.js');
const loader = 'net.fabricmc:fabric-loader:0.19.5';

test('obfuscated releases need the matching intermediary', () => {
  assert.doesNotThrow(() => checkFabricMappings(undefined, new Set([loader, 'net.fabricmc:intermediary:1.21.1']), '0.19.5', '1.21.1'));
  assert.doesNotThrow(() => checkFabricMappings('net.fabricmc:intermediary:1.21.1', new Set([loader, 'net.fabricmc:intermediary:1.21.1']), '0.19.5', '1.21.1'));
  assert.throws(() => checkFabricMappings(undefined, new Set([loader]), '0.19.5', '1.21.1'), /intermediary/);
  assert.throws(() => checkFabricMappings(undefined, new Set([loader, 'net.fabricmc:intermediary:1.20.4']), '0.19.5', '1.21.1'), /intermediary/);
});

test('unobfuscated releases (Minecraft 26.1+, declared intermediary 0.0.0) have no intermediary and must not get one', () => {
  assert.doesNotThrow(() => checkFabricMappings('net.fabricmc:intermediary:0.0.0', new Set([loader]), '0.19.5', '26.3'));
  assert.throws(() => checkFabricMappings('net.fabricmc:intermediary:0.0.0', new Set([loader, 'net.fabricmc:intermediary:26.3']), '0.19.5', '26.3'), /intermediary/);
});

test('the loader itself and the declared mapping are still verified', () => {
  assert.throws(() => checkFabricMappings('net.fabricmc:intermediary:0.0.0', new Set(), '0.19.5', '26.3'), /loader/);
  assert.throws(() => checkFabricMappings('net.fabricmc:intermediary:9.9.9', new Set([loader, 'net.fabricmc:intermediary:9.9.9']), '0.19.5', '26.3'), /intermediary/);
  assert.throws(() => checkFabricMappings(42, new Set([loader]), '0.19.5', '26.3'), /intermediary/);
});
