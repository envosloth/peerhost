import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const files=(await readdir(new URL('../dist/tests/',import.meta.url))).filter(f=>f.endsWith('.test.js')).sort();
if(!files.length) throw new Error('No test files found');
const extraFiles=(await readdir(new URL('../tests/',import.meta.url))).filter(f=>f.endsWith('.test.mjs')).sort();
// Headed Electron and real TLS/process fixtures share one host; leave CPU/I/O headroom.
// Bound worker count rather than relaxing product deadlines or skipping expensive suites.
const child=spawn(process.execPath,['--test','--test-concurrency=2',...files.map(f=>fileURLToPath(new URL('../dist/tests/'+f,import.meta.url))),...extraFiles.map(f=>fileURLToPath(new URL('../tests/'+f,import.meta.url)))],{stdio:'inherit'});
child.on('error',e=>{console.error(e);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
