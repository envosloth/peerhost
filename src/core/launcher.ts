import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type ServerProcessState = 'offline' | 'starting' | 'running' | 'stopping' | 'failed';

export interface ServerProcessProfile {
  executable: string;
  args: string[];
  cwd: string;
  readyPattern?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

interface LaunchContext {
  child?: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  forceRequested: boolean;
  consoleError?: Error;
}

export class ServerProcess extends EventEmitter {
  private currentState: ServerProcessState = 'offline';
  private launch?: LaunchContext;
  private readonly profile: ServerProcessProfile;

  private get child(): ChildProcessWithoutNullStreams | undefined {
    return this.launch?.child;
  }

  constructor(profile: ServerProcessProfile) {
    super();
    for (const key of ['startTimeoutMs', 'stopTimeoutMs'] as const) {
      const value = profile[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)) {
        throw new Error(`${key} must be an integer between 1 and 2147483647 ms`);
      }
    }
    if (profile.readyPattern !== undefined && (typeof profile.readyPattern !== 'string' || profile.readyPattern.length === 0)) {
      throw new Error('readyPattern must be a nonempty literal string');
    }
    this.profile = { ...profile, args: [...profile.args] };
  }

  get state(): ServerProcessState {
    return this.currentState;
  }

  get pid(): number | undefined {
    const child = this.child;
    return child && child.exitCode === null && child.signalCode === null ? child.pid : undefined;
  }

  private setState(state: ServerProcessState, launch: LaunchContext): void {
    if (this.launch !== launch || this.currentState === state) return;
    this.currentState = state;
    this.emit('state', state);
  }

  sendCommand(command: string): void {
    if (typeof command !== 'string' || /[\r\n]/.test(command)) {
      throw new Error('Console command must be a single line without newline characters');
    }
    if (Buffer.byteLength(command, 'utf8') > 1024) {
      throw new Error('Console command is too long (maximum 1024 UTF-8 bytes)');
    }
    const child = this.child;
    if (this.currentState !== 'running' || !child || !child.stdin.writable) {
      throw new Error('Server is not running with a writable console');
    }
    child.stdin.write(`${command}\n`);
  }

  async stop(): Promise<void> {
    const launch = this.launch;
    const child = launch?.child;
    if (!launch || !child) return;
    this.setState('stopping', launch);
    child.stdin.write('stop\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        launch.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'Graceful stop timed out; child is still owned. Explicit force-stop via forceStop() risks data loss.',
          )), this.profile.stopTimeoutMs ?? 30_000);
        }),
      ]);
      if (launch.consoleError) {
        this.setState('failed', launch);
        throw new Error(`Server console write failed during graceful stop: ${launch.consoleError.message}; save completion is unconfirmed.`, {
          cause: launch.consoleError,
        });
      }
      if (child.exitCode !== 0 || child.signalCode !== null) {
        this.setState('failed', launch);
        throw new Error(`Server exited abnormally during graceful stop (code ${child.exitCode}, signal ${child.signalCode}); save completion is unconfirmed.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async forceStop(): Promise<void> {
    const launch = this.launch;
    const child = launch?.child;
    if (!launch || !child) return;
    launch.forceRequested = true;
    this.setState('stopping', launch);
    child.kill('SIGKILL');
    await launch.closed;
  }

  async start(): Promise<void> {
    if (this.child || this.currentState === 'starting' || this.currentState === 'running' || this.currentState === 'stopping') {
      throw new Error(`Server already has an active launch (${this.currentState})`);
    }
    let resolveClosed!: () => void;
    const launch: LaunchContext = {
      closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
      forceRequested: false,
    };
    this.launch = launch;
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.profile.executable, this.profile.args, {
          cwd: this.profile.cwd,
          shell: false,
          windowsHide: true,
          stdio: 'pipe',
        });
      } catch (error) {
        this.setState('failed', launch);
        reject(error);
        resolveClosed();
        return;
      }
      launch.child = child;
      let ready = false;
      let startupError: Error | undefined;
      let bindReason: string | undefined;
      const startupLines: string[] = [];
      const captureStartupLine = (line: string): void => {
        if (ready) return;
        const bounded = line.slice(0, 512);
        startupLines.push(bounded);
        if (startupLines.length > 16) startupLines.shift();
        if (/FAILED TO BIND TO PORT|Address already in use|EADDRINUSE/i.test(line)) bindReason = bounded;
      };
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;
      const failStartup = (error: Error, terminate: boolean): void => {
        if (ready || startupError) return;
        startupError = error;
        clearTimeout(readinessTimer);
        this.setState('failed', launch);
        if (terminate && this.launch === launch && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      };
      child.once('close', () => {
        clearTimeout(readinessTimer);
        if (!ready) failStartup(new Error('Server exited before stdout readiness'), false);
        if (this.launch === launch) {
          launch.child = undefined;
          if (startupError) {
            this.setState('failed', launch);
          } else if (this.currentState !== 'failed') {
            this.setState('offline', launch);
          }
        }
        // close, unlike exit, guarantees both output streams have drained their diagnostics.
        if (startupError) {
          const detail = bindReason
            ? `Configured Minecraft port is unavailable: ${bindReason}. Stop the conflicting process or change the server/gateway port, then retry.`
            : startupLines.length ? `Startup log:\n${startupLines.join('\n')}` : '';
          reject(detail ? new Error(`${startupError.message}. ${detail}`, { cause: startupError }) : startupError);
        }
        resolveClosed();
      });
      const onProcessError = (error: Error): void => {
        if (this.launch !== launch) return;
        if (!ready) failStartup(new Error(`Server process error: ${error.message}`, { cause: error }), true);
        else this.setState('failed', launch);
      };
      child.on('error', onProcessError);
      child.stdin.on('error', (error: Error) => {
        launch.consoleError ??= error;
        onProcessError(error);
      });
      child.once('exit', (code, signal) => {
        if (this.launch !== launch) return;
        if (!ready) failStartup(new Error(`Server exited before stdout readiness (code ${code}, signal ${signal})`), false);
        else if (!launch.forceRequested && (code !== 0 || signal !== null)) this.setState('failed', launch);
      });
      // Publish 'starting' only after the child and its lifecycle handlers exist, so a synchronous
      // listener can deliver stop/force-stop to the real child instead of racing an empty context.
      this.setState('starting', launch);
      readinessTimer = setTimeout(() => {
        failStartup(new Error(`Server stdout readiness timed out after ${this.profile.startTimeoutMs ?? 60_000} ms`), true);
      }, this.profile.startTimeoutMs ?? 60_000);
      const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
      stdout.on('line', (line: string) => {
        if (this.launch !== launch) return;
        captureStartupLine(line);
        this.emit('line', line);
        if (this.launch === launch && !ready && !startupError && this.currentState === 'starting' && line.includes(this.profile.readyPattern ?? 'Done (')) {
          ready = true;
          clearTimeout(readinessTimer);
          this.setState('running', launch);
          resolve();
        }
      });
      stderr.on('line', (line: string) => {
        if (this.launch === launch) { captureStartupLine(line); this.emit('line', line); }
      });
    });
  }
}
