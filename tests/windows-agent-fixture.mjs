import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Fixed test-only source: accepts only the synthetic public-address test key.
// No shell, network, credential interpolation, or dependency download.
const source = `using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
class MockAgent {
  static int Main(string[] args) {
    if (args.Length != 6 || args[0] != "--secret-path" || args[2] != "--socket-path" || args[4] != "-l") return 2;
    string dir = Path.GetDirectoryName(args[1]);
    bool valid = File.ReadAllText(args[1]).Trim() == new string('c', 64);
    File.WriteAllText(Path.Combine(dir, "agent-saw-key"), valid ? "yes" : "no");
    if (!valid) return 3;
    File.WriteAllText(Path.Combine(dir, "agent-pid"), Process.GetCurrentProcess().Id.ToString());
    File.WriteAllText(args[5], "mock agent started; synthetic key accepted\\n");
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }
}`;

export async function windowsAgentFixture() {
  if (process.platform !== 'win32') throw new Error('Native Windows agent fixture requested on another platform');
  if (!process.env.TMPDIR) throw new Error('TMPDIR must point to the isolated test scratch directory');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'playit-native-fixture-'));
  try {
    const input = path.join(root, 'MockAgent.cs');
    const output = path.join(root, 'playit-fixture.exe');
    await writeFile(input, source);
    const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
    await promisify(execFile)(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${output}`, input], { windowsHide: true, timeout: 30000 });
    return await readFile(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
