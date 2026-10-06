import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { windowsServerRecover } from './windows-server-writer.js';
import { resolveServerPath } from './server-files.js';

/** Never follow links while locating evidence. Bounded scans fail closed. */
async function journals(serverDir: string): Promise<string[]> {
  const pending = [serverDir];
  const found: string[] = [];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Server recovery directory is not ordinary');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100_000) throw new Error('Server recovery scan limit exceeded; launch/snapshot refused');
      const file = path.join(directory, entry.name);
      if (/^\.seedhost-transaction-/i.test(entry.name)) found.push(file);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(file);
    }
  }
  return found.sort();
}

/** Non-mutating gate for launch/snapshot: unresolved evidence must never be suppressed. */
export async function assertServerFileTransactionsComplete(serverDir: string): Promise<void> {
  const pending = await journals(serverDir);
  if (pending.length) throw new Error('Unresolved server file recovery transaction; launch/snapshot refused. Evidence: ' + pending[0]);
}

/** Next editor read/write recovers only native identity+hash-verified transactions. */
export async function recoverManagedServerFiles(profileRoot: string, serverDir: string): Promise<void> {
  await resolveServerPath(profileRoot, serverDir, '', true);
  for (const journal of await journals(serverDir)) {
    const relative = path.relative(serverDir, path.dirname(journal)).replaceAll('\\', '/');
    await resolveServerPath(profileRoot, serverDir, relative, true);
    try { await windowsServerRecover(journal); }
    catch (error) { throw new Error('Unresolved server file recovery; evidence retained; launch/snapshot refused. ' + (error as Error).message); }
  }
  await assertServerFileTransactionsComplete(serverDir);
}
