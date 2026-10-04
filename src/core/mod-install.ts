import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ModrinthClient, assertModTarget, isProjectKey, versionCompatible, type ModProject, type ModSide, type ModVersion } from './modrinth.js';
import { addModBatch, isModKind, modsDirectory, ordinaryDirectory } from './mods.js';
import { modTarget, readModIndex, sourceMatches, writeModIndex, type IndexedMod, type ModSource } from './mod-index.js';
import { assertModInstallComplete } from './mod-transaction.js';
export { assertModInstallComplete } from './mod-transaction.js';

export interface InstallModInput { projectId: string; targets?: ModSide[] }
export interface InstalledMod { projectId: string; title: string; versionId: string; versionNumber: string; filename: string; targets: ModSide[] }

/** Resolve first, verify all downloads second, publish both folders and metadata last; never silently upgrade. */
export async function installMod(serverDir: string, stagingRoot: string, client: ModrinthClient, input: InstallModInput): Promise<{ installed: InstalledMod[] }> {
  await assertModInstallComplete(serverDir);
  if (!input || !isProjectKey(input.projectId)) throw new Error('Invalid Modrinth project id');
  if (input.targets !== undefined && (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 2 || input.targets.some((side) => !isModKind(side)) || new Set(input.targets).size !== input.targets.length)) throw new Error('Invalid mod targets');
  const index = await readModIndex(serverDir);
  const target = await modTarget(serverDir, index);
  assertModTarget(target);
  const selected = new Map<string, { project: ModProject; version: ModVersion; targets: ModSide[] }>();
  const projectCache = new Map<string, ModProject>();
  const versionCache = new Map<string, ModVersion>();
  let visits = 0;
  const getProject = async (key: string) => {
    const cached = projectCache.get(key);
    if (cached) return cached;
    const project = await client.project(key);
    if (project.id !== key && project.slug !== key) throw new Error('Modrinth project identity mismatch');
    projectCache.set(key, project); projectCache.set(project.id, project);
    return project;
  };
  const getVersion = async (id: string) => {
    let version = versionCache.get(id);
    if (!version) {
      version = await client.version(id);
      if (version.id !== id) throw new Error('Modrinth version identity mismatch');
      versionCache.set(id, version);
    }
    return version;
  };
  const visit = async (key: string | null, pinned: string | null, inherited: ModSide[] | undefined, depth: number): Promise<void> => {
    if (++visits > 1000 || depth > 32 || selected.size > 100) throw new Error('Mod dependency graph exceeds the safety limit');
    const pinnedVersion = pinned ? await getVersion(pinned) : undefined;
    if (pinnedVersion && key && pinnedVersion.projectId !== key) throw new Error('Required dependency version belongs to another project');
    const project = await getProject(key ?? pinnedVersion!.projectId);
    const previous = selected.get(project.id);
    if (previous && pinned && previous.version.id !== pinned) throw new Error(`Conflicting required versions of ${project.title}; nothing installed`);
    const version = previous?.version ?? pinnedVersion ?? await client.compatibleVersion(project.id, target, project.title);
    if (version.projectId !== project.id || !versionCompatible(version, target)) throw new Error(`${project.title} has no version for ${target.loader} ${target.gameVersion}`);
    const wanted = inherited ?? project.placement;
    if (wanted.some((side) => !project.supportedSides.includes(side))) throw new Error(`${project.title} does not support the required mod target`);
    const merged = (['server', 'client'] as const).filter((side) => wanted.includes(side) || previous?.targets.includes(side));
    if (previous && merged.length === previous.targets.length) return; // Cycles are bounded and side propagation reaches a fixed point.
    selected.set(project.id, { project, version, targets: merged });
    if (selected.size > 100) throw new Error('Mod dependency graph exceeds the safety limit');
    for (const dependency of version.requiredProjects) await visit(dependency.projectId, dependency.versionId, merged, depth + 1);
  };
  await visit(input.projectId, null, input.targets, 0);

  for (const mod of selected.values()) {
    for (const conflict of mod.version.incompatibleProjects) {
      const conflictingVersion = conflict.versionId ? await getVersion(conflict.versionId) : undefined;
      const projectId = conflict.projectId ?? conflictingVersion!.projectId;
      if (conflictingVersion && conflictingVersion.projectId !== projectId) throw new Error('Incompatible dependency identity mismatch');
      const candidate = selected.get(projectId);
      if (candidate && (!conflict.versionId || candidate.version.id === conflict.versionId)) throw new Error(`${mod.project.title} conflicts with incompatible mod ${candidate.project.title}`);
      for (const record of index.mods) {
        if (record.source.projectId === projectId && (!conflict.versionId || record.source.versionId === conflict.versionId) && await sourceMatches(serverDir, record)) throw new Error(`${mod.project.title} conflicts with an incompatible installed mod; remove it first`);
      }
    }
  }

  const existing = new Map<ModSide, Set<string>>();
  for (const side of ['server', 'client'] as const) {
    const directory = modsDirectory(serverDir, side);
    existing.set(side, new Set(await ordinaryDirectory(directory, false) ? (await readdir(directory)).map((name) => name.toLowerCase()) : []));
  }
  const pending: Array<{ project: ModProject; version: ModVersion; targets: ModSide[] }> = [];
  for (const mod of selected.values()) {
    const records = index.mods.filter((record) => record.source.projectId === mod.project.id);
    for (const record of records) {
      if (await sourceMatches(serverDir, record) && (record.source.versionId !== mod.version.id || record.source.sha512 !== mod.version.file.sha512 || record.source.loader !== target.loader || record.source.gameVersion !== target.gameVersion)) throw new Error(`${mod.project.title} has a conflicting installed version; remove it first`);
    }
    const targets: ModSide[] = [];
    for (const side of mod.targets) {
      const installed = records.find((record) => record.kind === side && record.name === mod.version.file.filename && record.source.versionId === mod.version.id && record.source.sha512 === mod.version.file.sha512);
      if (installed && await sourceMatches(serverDir, installed)) continue;
      const key = mod.version.file.filename.toLowerCase();
      if (existing.get(side)!.has(key)) throw new Error(`${mod.version.file.filename} is already installed without matching provenance; remove it first`);
      existing.get(side)!.add(key);
      targets.push(side);
    }
    if (targets.length) pending.push({ ...mod, targets });
  }
  if (!pending.length) return { installed: [] };
  const bytes = pending.reduce((sum, mod) => sum + mod.version.file.size, 0);
  if (bytes > 1024 * 1024 ** 2) throw new Error('Mod downloads exceed the 1 GiB batch limit');
  await mkdir(stagingRoot, { recursive: true });
  const stage = await mkdtemp(path.join(stagingRoot, 'mods-'));
  try {
    const items: Array<{ kind: ModSide; source: string }> = [];
    const records: IndexedMod[] = [];
    for (const [i, mod] of pending.entries()) {
      const sourceFile = await client.download(mod.version.file, path.join(stage, String(i)));
      const source: ModSource = { provider: 'modrinth', projectId: mod.project.id, versionId: mod.version.id, slug: mod.project.slug, title: mod.project.title,
        versionNumber: mod.version.versionNumber, sha512: mod.version.file.sha512, loader: target.loader, gameVersion: target.gameVersion };
      for (const kind of mod.targets) {
        items.push({ kind, source: sourceFile });
        records.push({ kind, name: mod.version.file.filename, source });
      }
    }
    const replaced = new Set(records.map((record) => `${record.kind}:${record.name.toLowerCase()}`));
    await addModBatch(serverDir, items, () => writeModIndex(serverDir, { ...index, mods: [...index.mods.filter((record) => !replaced.has(`${record.kind}:${record.name.toLowerCase()}`)), ...records] }));
    return { installed: pending.map((mod) => ({ projectId: mod.project.id, title: mod.project.title, versionId: mod.version.id, versionNumber: mod.version.versionNumber, filename: mod.version.file.filename, targets: mod.targets })) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
