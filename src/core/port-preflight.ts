import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { readServerProperties } from './server-properties.js';

function bindScope(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let scope = '';
  for (let i = 0; i < lines.length; i++) {
    let row = lines[i]!;
    if (/^[ \t\f]*[#!]/.test(row)) continue;
    while ((row.match(/\\+$/)?.[0].length ?? 0) % 2) {
      row = row.slice(0, -1);
      if (++i >= lines.length) break;
      row += lines[i]!.replace(/^[ \t\f]+/, '');
    }
    let start = 0; while (/[ \t\f]/.test(row[start] ?? '\0')) start++;
    let end = start;
    while (end < row.length) {
      if (row[end] === '\\') { end += 2; continue; }
      if (/[=: \t\f]/.test(row[end]!)) break;
      end++;
    }
    const key = readServerProperties('motd=' + row.slice(start, end)).motd;
    if (key === 'server-ip') scope = readServerProperties('motd' + row.slice(end)).motd ?? '';
  }
  return scope;
}

/** Preserve interface scope for discovered link-local addresses; explicit server-ip stays exact. */
export function deriveMinecraftProbeHosts(
  scope: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? []).map(entry => {
    const address = entry.address;
    // fe80::/10 needs a zone. Linux/libuv requires the interface name, not the numeric index.
    // Windows uses the reported numeric scope ID when available. Never duplicate an existing zone.
    if (!address.includes('%') && /^fe[89ab][0-9a-f]:/i.test(address)) {
      const zone = platform === 'win32' && typeof entry.scopeid === 'number' && entry.scopeid > 0 ? entry.scopeid : name;
      return `${address}%${zone}`;
    }
    return address;
  }));
  // Windows can permit wildcard binds beside an existing specific listener; retain every covered interface.
  return !scope || scope === '::' ? ['0.0.0.0', ...addresses]
    : scope === '0.0.0.0' ? ['0.0.0.0', ...addresses.filter(host => !host.includes(':'))] : [scope];
}

/** A bounded bind probe, never a service stop or a port reassignment. The child still handles races. */
export async function preflightMinecraftPort(serverDir: string): Promise<void> {
  let text: string;
  try { text = await readFile(path.join(serverDir, 'server.properties'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; text = ''; }
  const raw = readServerProperties(text)['server-port'] ?? '25565';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error('Minecraft port configuration is invalid');
  // Parse bind scope with the same Java-properties decoder as the ordinary property editor.
  const scope = bindScope(text);
  const hosts = deriveMinecraftProbeHosts(scope);
  for (const host of new Set(hosts)) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', error => reject(new Error(`Minecraft bind port ${raw} is unavailable; stop the conflicting service yourself or explicitly edit this server configuration.`, { cause: error })));
      probe.listen({ port: Number(raw), host, exclusive: true }, () => {
        probe.close(error => error ? reject(error) : resolve());
      });
    });
  }
}
