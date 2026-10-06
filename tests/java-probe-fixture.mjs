// Native executable fixture only: NOT Java and NOT Minecraft. No downloads or shell execution.
import path from 'node:path';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export async function javaProbeFixture(root, options = {}) {
  const executable = options.executable ?? path.join(root, 'fixture-jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  await mkdir(path.dirname(executable), { recursive: true });
  const stdout = options.stdout ?? '';
  const stderr = options.stderr ?? `openjdk version "${options.version ?? '21.0.4'}"\n`;
  const delayMs = options.delayMs ?? 0;
  const exitCode = options.exitCode ?? 0;
  // Default preserves existing start/stop consumers; probe-only consumers reject ANY extra argv.
  const server = options.server ?? true;
  if (process.platform === 'win32') {
    const source = path.join(root, 'FixtureJava.cs');
    const literal = value => '@"' + value.replaceAll('"', '""') + '"';
    await writeFile(source, `using System; using System.IO; using System.Threading;
class FixtureJava {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "-version") {
      Thread.Sleep(${delayMs}); Console.Out.Write(${literal(stdout)}); Console.Error.Write(${literal(stderr)}); return ${exitCode};
    }
    ${server ? `File.WriteAllLines("fixture-argv.txt", args);
    Console.WriteLine(${literal('[Server thread/INFO]: Done (0.1s)! For help, type "help"')});
    string line; while ((line = Console.ReadLine()) != null) { if (line == "stop") { Console.WriteLine("Stopping server"); return 0; } }
    return 0;` : 'return 5;'}
  }
}`);
    await run('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/out:' + executable, source], { windowsHide: true });
  } else {
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '-version') {
  setTimeout(() => { process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode}); }, ${delayMs});
} else if (!${server}) { process.exit(5); } else {
  fs.writeFileSync('fixture-argv.txt', args.join('\\n') + '\\n');
  console.log('[Server thread/INFO]: Done (0.1s)! For help, type "help"');
  let input = ''; process.stdin.on('data', b => { input += b; const lines = input.split(/\\r?\\n/); input = lines.pop(); if (lines.includes('stop')) { console.log('Stopping server'); process.exit(0); } });
}
`);
    await chmod(executable, 0o700);
  }
  return executable;
}
