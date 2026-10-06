import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';

export interface ServerResourceSample {
  pid: number | null;
  /** Percent of ONE logical core, not the whole machine. May exceed 100 on multi-threaded servers.
   * Null until two readings of the same process identity provide a measured CPU delta. */
  cpuPercent: number | null;
  memoryMiB: number | null;
  uptimeSeconds: number | null;
  /** Unix epoch milliseconds. */
  sampledAt: number;
  error: string | null;
}

interface ProcessReading {
  pid: number;
  cpuSeconds: number;
  memoryBytes: number;
  uptimeSeconds: number;
  identity: string;
}

const runFile = promisify(execFile);
const commandOptions = { encoding: 'utf8', shell: false, windowsHide: true, timeout: 4_000, maxBuffer: 65_536 } as const;

type ProcessCommand = (file: string, args: string[], options: typeof commandOptions & { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

async function readText(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error('Process metrics file too large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function linuxStat(text: string, pid: number): { cpuTicks: number; startTicks: number; identity: string } {
  const opening = text.indexOf('(');
  const closing = text.lastIndexOf(')');
  const fields = text.slice(closing + 1).trim().split(/\s+/);
  if (opening < 1 || closing <= opening || text.slice(0, opening).trim() !== String(pid)
    || !/^[RSDTtWKPI]$/.test(fields[0] ?? '')) throw new Error('Invalid or exited /proc process');
  const values = [fields[11], fields[12], fields[19]].map(value => {
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid /proc process counters');
    return Number(value);
  });
  return { cpuTicks: values[0]! + values[1]!, startTicks: values[2]!, identity: fields[19]! };
}

function psDuration(text: string): number {
  // BSD ps time is mm:ss.cc (or hh:mm:ss); etime additionally allows dd-hh:mm:ss.
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) throw new Error('Invalid ps duration');
  const days = Number(match[1] ?? 0), hours = Number(match[2] ?? 0), minutes = Number(match[3]), seconds = Number(match[4]);
  if (seconds >= 60 || (match[2] && minutes >= 60) || (match[1] && (!match[2] || hours >= 24))) throw new Error('Invalid ps duration');
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function windowsPowerShellPath(systemRoot: string | undefined): string {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  const root = path.win32.resolve(systemRoot);
  if (!/^[A-Za-z]:\\/i.test(root)) throw new Error('Windows SystemRoot must be on a local drive');
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function readProcess(pid: number, dependencies: NonNullable<ServerMetricsOptions['testOnly']> = {}): Promise<ProcessReading> {
  const platform = dependencies.platform ?? process.platform;
  const execute = dependencies.runFile ?? runFile;
  const text = dependencies.readText ?? readText;
  if (platform === 'linux') {
    const before = linuxStat(await text(`/proc/${pid}/stat`), pid);
    const [status, boot, configuration] = await Promise.all([
      text(`/proc/${pid}/status`), text('/proc/uptime'), execute('getconf', ['CLK_TCK'], commandOptions),
    ]);
    const after = linuxStat(await text(`/proc/${pid}/stat`), pid);
    if (before.identity !== after.identity) throw new Error('Server PID reused during metrics read');
    const ticks = Number(configuration.stdout.trim());
    const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status);
    const uptime = Number(boot.trim().split(/\s+/)[0]);
    if (!Number.isSafeInteger(ticks) || ticks <= 0 || !rss || !Number.isFinite(uptime)) throw new Error('Invalid Linux process metrics');
    return { pid, cpuSeconds: after.cpuTicks / ticks, memoryBytes: Number(rss[1]) * 1024,
      uptimeSeconds: uptime - after.startTicks / ticks, identity: after.identity };
  }
  if (platform === 'darwin') {
    // BSD/macOS field names and empty headers, NOT GNU-only etimes or pcpu lifetime averages.
    const args = ['-p', String(pid), '-o', 'pid=', '-o', 'time=', '-o', 'rss=', '-o', 'etime=', '-o', 'lstart='];
    const { stdout } = await execute('ps', args, { ...commandOptions, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(stdout);
    if (!match || Number(match[1]) !== pid || !Number.isFinite(Date.parse(`${match[5]} UTC`))) throw new Error('Invalid ps process metrics');
    return { pid, cpuSeconds: psDuration(match[2]!), memoryBytes: Number(match[3]) * 1024,
      uptimeSeconds: psDuration(match[4]!), identity: match[5]!.replace(/\s+/g, ' ') };
  }
  if (platform !== 'win32') throw new Error('Unsupported process metrics platform');
  // Only a validated integer enters this constant script; execFile never launches a shell.
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; `
    + `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.Refresh(); $start = $p.StartTime.ToUniversalTime(); `
    + `@{pid=$p.Id;cpuSeconds=$p.CPU;memoryBytes=$p.WorkingSet64;identity=$start.Ticks.ToString();`
    + `uptimeSeconds=([DateTime]::UtcNow-$start).TotalSeconds} | ConvertTo-Json -Compress`;
  const { stdout } = await execute(windowsPowerShellPath(dependencies.systemRoot ?? process.env.SystemRoot), ['-NoProfile', '-NonInteractive', '-Command', script], commandOptions);
  const value = JSON.parse(stdout.trim()) as ProcessReading;
  if (value.pid !== pid || ![value.cpuSeconds, value.memoryBytes, value.uptimeSeconds]
    .every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)
    || typeof value.identity !== 'string' || !value.identity) throw new Error('Invalid process metrics reading');
  return value;
}

function validateReading(value: unknown, pid: number): asserts value is ProcessReading {
  if (!value || typeof value !== 'object') throw new Error('Invalid process metrics reading');
  const reading = value as ProcessReading;
  if (reading.pid !== pid || ![reading.cpuSeconds, reading.memoryBytes, reading.uptimeSeconds]
    .every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)
    || !Number.isSafeInteger(reading.memoryBytes) || typeof reading.identity !== 'string'
    || !reading.identity || reading.identity.length > 128) throw new Error('Invalid process metrics reading');
}

export interface ServerMetricsOptions {
  /** Isolated fixtures only. Omit in application code to use the actual OS process reader. */
  testOnly?: {
    readProcess?: (pid: number) => Promise<ProcessReading>;
    monotonicNow?: () => number;
    platform?: NodeJS.Platform;
    readText?: (file: string) => Promise<string>;
    runFile?: ProcessCommand;
    systemRoot?: string;
  };
}

export class ServerMetrics {
  private previous = new Map<number, { reading: ProcessReading; monotonicAt: number; sample: ServerResourceSample }>();
  private inFlight = new Map<number, Promise<ServerResourceSample>>();
  private generation = 0;
  private readonly read: (pid: number) => Promise<ProcessReading>;
  private readonly monotonicNow: () => number;

  constructor(options: ServerMetricsOptions = {}) {
    this.read = options.testOnly?.readProcess ?? (pid => readProcess(pid, options.testOnly));
    this.monotonicNow = options.testOnly?.monotonicNow ?? (() => performance.now());
  }

  reset(): void {
    this.generation++;
    this.previous.clear();
    this.inFlight.clear();
  }

  async sample(pid: number | undefined): Promise<ServerResourceSample> {
    const result: ServerResourceSample = {
      pid: null, cpuPercent: null, memoryMiB: null, uptimeSeconds: null, sampledAt: Date.now(), error: null,
    };
    if (pid === undefined) return result;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return { ...result, error: 'Invalid server PID' };
    const cached = this.previous.get(pid);
    const age = cached ? this.monotonicNow() - cached.monotonicAt : Infinity;
    if (cached && age >= 0 && age < 2_000) return { ...cached.sample };
    const active = this.inFlight.get(pid);
    if (active) return { ...await active };
    result.pid = pid;
    const pending = this.collect(pid, result);
    this.inFlight.set(pid, pending);
    try { return { ...await pending }; }
    finally { if (this.inFlight.get(pid) === pending) this.inFlight.delete(pid); }
  }

  private async collect(pid: number, result: ServerResourceSample): Promise<ServerResourceSample> {
    const generation = this.generation;
    try {
      const reading = await this.read(pid);
      if (generation !== this.generation) return { ...result, error: 'Server process metrics reset during read' };
      validateReading(reading, pid);
      const monotonicAt = this.monotonicNow();
      const previous = this.previous.get(pid);
      const elapsedMs = previous ? monotonicAt - previous.monotonicAt : 0;
      const cpuDelta = previous ? reading.cpuSeconds - previous.reading.cpuSeconds : -1;
      const cpuPercent = previous?.reading.identity === reading.identity && elapsedMs > 0 && cpuDelta >= 0
        ? cpuDelta / (elapsedMs / 1_000) * 100 : null;
      const sample = { ...result, sampledAt: Date.now(), cpuPercent, memoryMiB: reading.memoryBytes / (1024 * 1024), uptimeSeconds: reading.uptimeSeconds };
      this.previous.set(pid, { reading, monotonicAt, sample });
      return { ...sample };
    } catch (error) {
      if (generation === this.generation) this.previous.delete(pid);
      return { ...result, sampledAt: Date.now(), error: `Server process metrics unavailable: ${error instanceof Error ? error.message.slice(0, 160) : 'read failed'}` };
    }
  }
}
