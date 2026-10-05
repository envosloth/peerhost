import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { validateCall } from '../src/core/ipc-policy.js';
import { ModrinthClient, detectModTarget, placementFor } from '../src/core/modrinth.js';
import { writeZip } from '../src/core/zip.js';

const renderer = 'file:///app/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };

async function jarBytes(id: string): Promise<Buffer> {
  await mkdir('.test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('.test-data/jar-'));
  try { await writeZip(path.join(dir, 'm.jar'), [{ name: 'fabric.mod.json', data: Buffer.from(`{"id":"${id}"}`) }]); return await readFile(path.join(dir, 'm.jar')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const sha512 = (data: Buffer) => createHash('sha512').update(data).digest('hex');

interface FakeProject { id: string; slug: string; title: string; client_side: string; server_side: string; deps?: string[]; loaders?: string[]; tamper?: boolean; host?: string }
/** A local stand-in for api.modrinth.com and its CDN, serving the real response shapes. */
async function fakeModrinth(t: TestContext, projects: FakeProject[]) {
  const jars = new Map<string, Buffer>();
  for (const project of projects) jars.set(project.id, await jarBytes(project.id));
  const requests: string[] = [];
  let base = '';
  const version = (p: FakeProject) => ({
    id: `v-${p.id}`, project_id: p.id, name: `${p.title} 1.0`, version_number: '1.0.0', version_type: 'release',
    loaders: p.loaders ?? ['fabric'], game_versions: ['1.21.1'],
    dependencies: (p.deps ?? []).map((project_id) => ({ project_id, version_id: null, file_name: null, dependency_type: 'required' })),
    files: [{ hashes: { sha512: p.tamper ? 'f'.repeat(128) : sha512(jars.get(p.id)!), sha1: 'x' }, url: `${p.host ?? base}/cdn/${p.id}.jar`,
      filename: `${p.slug}-1.0.0.jar`, primary: true, size: jars.get(p.id)!.length, file_type: null }],
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, base);
    requests.push(`${url.pathname}${url.search}`);
    assert.match(String(request.headers['user-agent']), /^envosloth\/seedhost\//, 'every request identifies the app');
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const byId = (key: string) => projects.find((p) => p.id === key || p.slug === key);
    let match;
    if (url.pathname === '/v2/search') {
      const facets = JSON.parse(url.searchParams.get('facets')!) as string[][];
      const query = url.searchParams.get('query') ?? '';
      const hits = projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()))
        .filter((p) => facets.every((group) => group.some((facet) => {
          const [key, value] = facet.split(':');
          return key === 'categories' ? (p.loaders ?? ['fabric']).includes(value!) : key === 'versions' ? value === '1.21.1' : value === 'mod';
        })));
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
      return json({ hits: hits.slice(offset, offset + limit).map((p) => ({ project_id: p.id, slug: p.slug, title: p.title, author: 'someone',
        description: `${p.title} description`, downloads: 1234, icon_url: p.id === 'evilicon' ? 'https://evil.example/x.png' : `https://cdn.modrinth.com/data/${p.id}/icon.webp`,
        client_side: p.client_side, server_side: p.server_side, categories: p.loaders ?? ['fabric'], versions: ['1.21.1'] })), offset, limit, total_hits: hits.length });
    }
    if ((match = /^\/v2\/project\/([\w-]+)\/version$/.exec(url.pathname))) {
      const project = byId(match[1]!);
      if (!project) return json({ error: 'not_found' }, 404);
      const loaders = JSON.parse(url.searchParams.get('loaders') ?? '[]') as string[];
      return json(loaders.some((loader) => (project.loaders ?? ['fabric']).includes(loader)) ? [version(project)] : []);
    }
    if ((match = /^\/v2\/project\/([\w-]+)$/.exec(url.pathname))) {
      const project = byId(match[1]!);
      return project ? json({ id: project.id, slug: project.slug, title: project.title, client_side: project.client_side, server_side: project.server_side, project_type: 'mod' }) : json({}, 404);
    }
    if ((match = /^\/cdn\/([\w-]+)\.jar$/.exec(url.pathname))) {
      response.writeHead(200, { 'content-type': 'application/java-archive' });
      return response.end(jars.get(match[1]!));
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new ModrinthClient({ apiBase: `${base}/v2`, downloadHosts: [new URL(base).host], userAgent: 'envosloth/seedhost/test' });
  return { base, client, requests, jars };
}

async function setup(t: TestContext, prefix: string, layout: Record<string, string> = { '.fabric/server/1.21.1/server.jar': 'x', 'versions/1.21.1/server-1.21.1.jar': 'x' }) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'mods'), { recursive: true });
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  for (const [file, data] of Object.entries(layout)) { await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await writeFile(path.join(source, file), data); }
  return { root, source };
}
async function app(t: TestContext, root: string, source: string, client: ModrinthClient) {
  const instance = new SeedHostApplication(path.join(root, 'profile'), await createIdentity(), { modrinth: client });
  t.after(() => instance.close().catch(() => {}));
  await instance.open();
  await instance.importExisting(source, true);
  return instance;
}
const projects: FakeProject[] = [
  { id: 'create', slug: 'create-fabric', title: 'Create', client_side: 'required', server_side: 'required', deps: ['fapi'] },
  { id: 'fapi', slug: 'fabric-api', title: 'Fabric API', client_side: 'optional', server_side: 'optional' },
  { id: 'lith', slug: 'lithium', title: 'Lithium', client_side: 'optional', server_side: 'optional' },
  { id: 'sodium', slug: 'sodium', title: 'Sodium', client_side: 'required', server_side: 'unsupported' },
  { id: 'chunky', slug: 'chunky', title: 'Chunky Pregen', client_side: 'unsupported', server_side: 'required' },
  { id: 'evilicon', slug: 'evil-icon', title: 'Evil Icon', client_side: 'required', server_side: 'required' },
  { id: 'bad', slug: 'tampered', title: 'Tampered', client_side: 'optional', server_side: 'required', tamper: true },
  { id: 'offsite', slug: 'offsite', title: 'Offsite', client_side: 'optional', server_side: 'required', host: 'http://example.invalid' },
  { id: 'forgeonly', slug: 'forge-only', title: 'Forge Only', client_side: 'required', server_side: 'required', loaders: ['forge'] },
];

test('placement follows Modrinth side metadata', () => {
  assert.deepEqual(placementFor('required', 'required'), ['server', 'client']);
  assert.deepEqual(placementFor('required', 'unsupported'), ['client']);
  assert.deepEqual(placementFor('unsupported', 'required'), ['server']);
  assert.deepEqual(placementFor('optional', 'optional'), ['server']);
  assert.deepEqual(placementFor('optional', 'required'), ['server']);
  assert.deepEqual(placementFor('unknown', 'unknown'), ['server', 'client']);
});

test('the loader and Minecraft version are detected from the server folder', async (t) => {
  const cases: Array<[Record<string, string>, { loader: string | null; gameVersion: string | null }]> = [
    [{ '.fabric/server/1.21.1/server.jar': 'x', 'versions/1.21.1/server-1.21.1.jar': 'x' }, { loader: 'fabric', gameVersion: '1.21.1' }],
    [{ 'quilt-server-launcher.properties': 'x', 'libraries/net/minecraft/server/1.20.4/server.jar': 'x' }, { loader: 'quilt', gameVersion: '1.20.4' }],
    [{ 'libraries/net/neoforged/neoforge/21.1.77/x.jar': 'x' }, { loader: 'neoforge', gameVersion: '1.21.1' }],
    [{ 'libraries/net/neoforged/neoforge/21.0.10-beta/x.jar': 'x' }, { loader: 'neoforge', gameVersion: '1.21' }],
    [{ 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/x.jar': 'x' }, { loader: 'forge', gameVersion: '1.20.1' }],
    [{ 'server.jar': 'x' }, { loader: null, gameVersion: null }],
  ];
  for (const [layout, expected] of cases) {
    const { source } = await setup(t, 'detect-', layout);
    assert.deepEqual(await detectModTarget(source), expected, JSON.stringify(layout));
  }
});

test('search returns Modrinth results for the server loader and version, with placement, installed state and safe icons', async (t) => {
  const { client, requests } = await fakeModrinth(t, projects);
  const { root, source } = await setup(t, 'browse-search-');
  const host = await app(t, root, source, client);
  assert.deepEqual((await host.getState()).server!.modTarget, { loader: 'fabric', gameVersion: '1.21.1', detected: true });
  const page = await host.searchMods({ query: '', offset: 0 });
  assert.equal(page.total, 8, 'the forge-only project is filtered out by the loader facet');
  const create = page.hits.find((hit) => hit.slug === 'create-fabric')!;
  assert.deepEqual(create.placement, ['server', 'client']);
  assert.equal(create.installed, false);
  assert.equal(create.iconUrl, 'https://cdn.modrinth.com/data/create/icon.webp');
  assert.equal(page.hits.find((hit) => hit.slug === 'evil-icon')!.iconUrl, null, 'icons from other hosts are dropped');
  assert.deepEqual(page.hits.find((hit) => hit.slug === 'sodium')!.placement, ['client']);
  const facets = JSON.parse(new URL('http://x' + requests.find((r) => r.startsWith('/v2/search'))!).searchParams.get('facets')!);
  assert.deepEqual(facets, [['categories:fabric'], ['versions:1.21.1'], ['project_type:mod']]);
  assert.equal((await host.searchMods({ query: 'sod', offset: 0 })).hits.length, 1);
});

test('installing a mod downloads verified jars, adds its required dependencies, and places each by side', async (t) => {
  const { client, jars } = await fakeModrinth(t, projects);
  const { root, source } = await setup(t, 'browse-install-');
  const host = await app(t, root, source, client);
  const result = await host.installMod({ projectId: 'create' });
  assert.deepEqual(result.installed.map((mod) => [mod.title, mod.targets]), [['Create', ['server', 'client']], ['Fabric API', ['server', 'client']]],
    'a dependency follows its parent to the client pack even though its own metadata says optional');
  const state = (await host.getState()).server!;
  assert.deepEqual(state.mods.server.map((mod) => mod.name), ['create-fabric-1.0.0.jar', 'fabric-api-1.0.0.jar']);
  assert.deepEqual(state.mods.client.map((mod) => mod.name), ['create-fabric-1.0.0.jar', 'fabric-api-1.0.0.jar']);
  assert.deepEqual(await readFile(path.join(state.serverDir, 'mods', 'create-fabric-1.0.0.jar')), jars.get('create'));
  assert.equal(state.mods.server.find((mod) => mod.name === 'create-fabric-1.0.0.jar')!.source?.projectId, 'create');
  assert.equal((await host.searchMods({ query: 'create', offset: 0 })).hits[0]!.installed, true);
  assert.deepEqual((await host.installMod({ projectId: 'lith' })).installed.map((mod) => mod.title), ['Lithium']);
  assert.deepEqual((await host.installMod({ projectId: 'sodium' })).installed[0]!.targets, ['client']);
  assert.deepEqual((await host.installMod({ projectId: 'chunky' })).installed[0]!.targets, ['server']);
  assert.deepEqual((await host.installMod({ projectId: 'create' })).installed, [], 'already installed: nothing to do');
  assert.deepEqual((await host.installMod({ projectId: 'lith', targets: ['client'] })).installed.map((mod) => mod.targets), [['client']], 'adds to the other list on request');
  await host.removeMod('server', 'fabric-api-1.0.0.jar');
  assert.equal((await host.getState()).server!.mods.server.some((mod) => mod.name === 'fabric-api-1.0.0.jar'), false);
  await host.removeMod('server', 'create-fabric-1.0.0.jar');
  const repaired = await host.installMod({ projectId: 'create' });
  assert.deepEqual(repaired.installed.map(mod => [mod.projectId, mod.targets]), [['create', ['server']], ['fapi', ['server']]], 'repair restores missing side and required dependency without replacing client copies');
  assert.deepEqual(await readFile(path.join(state.serverDir, 'mods', 'fabric-api-1.0.0.jar')), jars.get('fapi'));
});

test('tampered, offsite, incompatible or unknown downloads are refused and nothing is written', async (t) => {
  const { client } = await fakeModrinth(t, projects);
  const { root, source } = await setup(t, 'browse-refuse-');
  const host = await app(t, root, source, client);
  const before = await readdir(path.join((await host.getState()).server!.serverDir, 'mods'));
  await assert.rejects(host.installMod({ projectId: 'bad' }), /integrity|sha-?512/i);
  await assert.rejects(host.installMod({ projectId: 'offsite' }), /not an allowed download host/i);
  await assert.rejects(host.installMod({ projectId: 'forgeonly' }), /no version.*fabric.*1\.21\.1/i);
  await assert.rejects(host.installMod({ projectId: 'missing' }), /not found|404/i);
  const dir = (await host.getState()).server!.serverDir;
  assert.deepEqual(await readdir(path.join(dir, 'mods')), before);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.seedhost')), [], 'no staging inside the server folder');
});

test('the mod target can be set by hand when detection fails, and travels with the server', async (t) => {
  const { client } = await fakeModrinth(t, projects);
  const { root, source } = await setup(t, 'browse-target-', { 'server.jar': 'x' });
  const host = await app(t, root, source, client);
  assert.deepEqual((await host.getState()).server!.modTarget, { loader: null, gameVersion: null, detected: true });
  await assert.rejects(host.searchMods({ query: '', offset: 0 }), /set the mod loader and minecraft version/i);
  await assert.rejects(host.saveModTarget({ loader: 'bukkit', gameVersion: '1.21.1' }), /loader/i);
  await assert.rejects(host.saveModTarget({ loader: 'fabric', gameVersion: '1.21.1; rm' }), /version/i);
  await host.saveModTarget({ loader: 'fabric', gameVersion: '1.21.1' });
  assert.deepEqual((await host.getState()).server!.modTarget, { loader: 'fabric', gameVersion: '1.21.1', detected: false });
  await host.createSnapshot();
  const serverDir = (await host.getState()).server!.serverDir;
  assert.equal(JSON.parse(await readFile(path.join(serverDir, 'seedhost-mods.json'), 'utf8')).target.loader, 'fabric');
});

test('mod browser IPC payloads are validated', () => {
  assert.deepEqual(validateCall('searchMods', { query: 'create', offset: 20 }, renderer, renderer, trusted), { query: 'create', offset: 20 });
  assert.deepEqual(validateCall('installMod', { projectId: 'AANobbMI' }, renderer, renderer, trusted), { projectId: 'AANobbMI' });
  assert.deepEqual(validateCall('installMod', { projectId: 'AANobbMI', targets: ['client'] }, renderer, renderer, trusted), { projectId: 'AANobbMI', targets: ['client'] });
  assert.deepEqual(validateCall('saveModTarget', { loader: 'neoforge', gameVersion: '1.21.1' }, renderer, renderer, trusted), { loader: 'neoforge', gameVersion: '1.21.1' });
  assert.deepEqual(validateCall('openModPage', { slug: 'create-fabric' }, renderer, renderer, trusted), { slug: 'create-fabric' });
  for (const [method, payload] of [
    ['searchMods', { query: 'x'.repeat(201), offset: 0 }], ['searchMods', { query: 'a', offset: -1 }], ['searchMods', { query: 'a', offset: 1.5 }],
    ['installMod', { projectId: '../x' }], ['installMod', { projectId: 'abc', targets: [] }], ['installMod', { projectId: 'abc', targets: ['both'] }],
    ['saveModTarget', { loader: 'fabric' }], ['openModPage', { slug: 'https://evil.example' }],
  ] as const) assert.throws(() => validateCall(method, payload, renderer, renderer, trusted), /mod|query|offset|project|loader|version|slug|target/i, method);
});
