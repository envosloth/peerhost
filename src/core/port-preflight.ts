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

/** A bounded bind probe, never a service stop or a port reassignment. The child still handles races. */
export async function preflightMinecraftPort(serverDir: string): Promise<void> {
  let text: string;
  try { text = await readFile(path.join(serverDir, 'server.properties'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; text = ''; }
  const raw = readServerProperties(text)['server-port'] ?? '25565';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error('Minecraft port configuration is invalid');
  // Parse bind scope with the same Java-properties decoder as the ordinary property editor.
  const scope = bindScope(text);
  // Windows can permit wildcard binds beside an existing specific listener; probe each covered interface too.
  const interfaces = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).map(entry => entry.address);
  const hosts = !scope || scope === '::' ? ['0.0.0.0', ...interfaces] : scope === '0.0.0.0' ? ['0.0.0.0', ...interfaces.filter(host => !host.includes(':'))] : [scope];
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
