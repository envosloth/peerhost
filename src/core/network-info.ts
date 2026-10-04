import { open } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

type Interfaces = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

// Addresses other PCs on the same home network can usually reach. Container/VM bridges and
// public, CGNAT/Tailscale (100.64/10) and loopback addresses are excluded.
export function privateLanAddresses(interfaces: Interfaces = networkInterfaces() as Interfaces): string[] {
  const result: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      const [a = -1, b = -1] = entry.address.split('.').map(Number);
      if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) result.push(entry.address);
    }
  }
  return [...new Set(result)].slice(0, 4);
}

export async function readServerPort(serverDir: string): Promise<number> {
  try {
    const handle = await open(path.join(serverDir, 'server.properties'), 'r');
    let text: string;
    try { const buffer = Buffer.alloc(65536); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, bytesRead).toString('utf8'); }
    finally { await handle.close(); }
    const match = /^server-port\s*=\s*(\d{1,5})\s*$/m.exec(text);
    const port = match ? Number(match[1]) : NaN;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 25565;
  } catch { return 25565; }
}
