// A bounded, deliberately supported subset of one-token JVM options. Never a shell command.
const GC_OPTIONS = new Set(['UseG1GC', 'UseZGC', 'UseShenandoahGC', 'UseParallelGC', 'UseSerialGC',
  'MaxGCPauseMillis', 'DisableExplicitGC', 'AlwaysPreTouch', 'UseStringDeduplication', 'ParallelRefProcEnabled',
  'UnlockExperimentalVMOptions', 'UnlockDiagnosticVMOptions', 'G1NewSizePercent', 'G1MaxNewSizePercent',
  'G1HeapRegionSize', 'G1ReservePercent', 'G1HeapWastePercent', 'G1MixedGCCountTarget', 'InitiatingHeapOccupancyPercent',
  'G1MixedGCLiveThresholdPercent', 'G1RSetUpdatingPauseTimePercent', 'SurvivorRatio', 'PerfDisableSharedMem',
  'MaxTenuringThreshold', 'ParallelGCThreads', 'ConcGCThreads', 'UseNUMA', 'UseNUMAInterleaving']);
function supportedArgument(arg: unknown): arg is string {
  if (typeof arg !== 'string' || !arg || arg.length > 1024 || /[\x00-\x1f\x7f]/.test(arg)) return false;
  const property = /^-D([A-Za-z0-9_.-]{1,128})=(.*)$/.exec(arg);
  if (property) return property[1] === 'java.awt.headless' || !/^(?:java|javax|jdk|sun)\./i.test(property[1]!);
  const flag = /^-XX:(?:[+-]([A-Za-z][A-Za-z0-9]{0,63})|([A-Za-z][A-Za-z0-9]{0,63})=([A-Za-z0-9.+-]{1,64}))$/.exec(arg);
  return Boolean(flag && GC_OPTIONS.has(flag[1] ?? flag[2]!)) || /^(?:-ea|-da|-server|-Xss\d+[kKmMgG])$/.test(arg);
}
export function validateCustomJavaArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || !value.every(supportedArgument) || value.join('').length > 8192) {
    throw new Error('Custom Java arguments must be a bounded JSON string array of supported JVM tuning options or -D properties. Heap, launcher, classpath, argument files, agents and executable hooks are not allowed; use advanced launch settings for other options.');
  }
  return [...value];
}
export interface SimpleProfileInput { javaExecutable: string; memoryMiB: number; customJavaArgs?: string[] }
export function validateSimpleProfileInput(value: unknown): SimpleProfileInput {
  const input = value as SimpleProfileInput;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== ('customJavaArgs' in input ? 'customJavaArgs,javaExecutable,memoryMiB' : 'javaExecutable,memoryMiB') ||
      typeof input.javaExecutable !== 'string' || !input.javaExecutable.trim() || input.javaExecutable.length > 4096 || /[\x00-\x1f\x7f]/.test(input.javaExecutable) ||
      !Number.isInteger(input.memoryMiB) || input.memoryMiB < 512 || input.memoryMiB > 65536) throw new Error('Invalid simple launch profile');
  return { javaExecutable: input.javaExecutable, memoryMiB: input.memoryMiB,
    ...('customJavaArgs' in input ? { customJavaArgs: validateCustomJavaArgs(input.customJavaArgs) } : {}) };
}
/** Stop at the launcher/entrypoint; never interpret Minecraft's program arguments as JVM tuning. */
function prefixEnd(args: string[]): number {
  const index = args.findIndex(arg => !arg.startsWith('-') || ['-jar', '-cp', '-classpath', '--class-path', '-p', '--module-path', '-m', '--module', '--'].includes(arg) || /^(?:--class-path|--module-path|--module)=/.test(arg));
  return index < 0 ? args.length : index;
}
export function customJavaArgsFromProfile(args: string[]): string[] {
  return args.slice(0, prefixEnd(args)).filter(supportedArgument);
}
/** Only replace supported options when the user explicitly edits them; preserve imported unknown options. */
export function withCustomJavaArgs(args: string[], custom: string[]): string[] {
  const end = prefixEnd(args);
  return [...validateCustomJavaArgs(custom), ...args.slice(0, end).filter(arg => !supportedArgument(arg)), ...args.slice(end)];
}
export function withoutJvmHeapArgs(args: string[]): string[] {
  const end = prefixEnd(args);
  return [...args.slice(0, end).filter(arg => !/^-Xm[sx]/.test(arg)), ...args.slice(end)];
}
