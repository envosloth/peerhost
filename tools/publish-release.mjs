// Publishes the current version's GitHub release: creates (or updates) the release for the pushed tag
// v<package.json version> and uploads the two updater assets built by tools/package-release.mjs.
// Auth comes from the local git credential helper for github.com (never printed). No secrets in-repo.
//
// Usage: node tools/publish-release.mjs --notes=release/notes-v0.6.0-alpha.md
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const p = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = `v${p.version}`;
const notesPath = process.argv.find((a) => a.startsWith('--notes='))?.slice('--notes='.length);
const notes = notesPath ? await readFile(path.resolve(notesPath), 'utf8') : `Release ${tag}`;
const repo = 'envosloth/seedhost';
const zipPath = path.join(root, 'release', `SeedHost-${p.version}-win32-x64.zip`);
const sumsPath = path.join(root, 'release', 'SHA256SUMS.txt');

const credential = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
const password = /^password=(.+)$/m.exec(credential)?.[1]?.trim();
if (!password) throw new Error('No stored GitHub credential for github.com; sign in for git push first');
const headers = { Authorization: `Bearer ${password}`, Accept: 'application/vnd.github+json', 'User-Agent': 'SeedHost-Release' };

async function api(route, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route} -> ${response.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

let release = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers }).then(async (r) => (r.ok ? r.json() : null));
if (release) {
  console.log(`Release ${tag} exists (${release.id}); updating notes.`);
  release = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ name: tag, body: notes, prerelease: true }) });
} else {
  release = await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body: notes, prerelease: true, draft: false }) });
  console.log(`Created release ${tag} (${release.id}).`);
}

const uploadBase = String(release.upload_url).replace(/\{.*$/, '');
for (const [file, contentType] of [[zipPath, 'application/zip'], [sumsPath, 'text/plain']]) {
  const name = path.basename(file);
  const existing = (release.assets ?? []).find((a) => a.name === name);
  if (existing) {
    console.log(`Replacing existing asset ${name} (${existing.id}).`);
    await api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const body = await readFile(file);
  const uploaded = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body });
  if (!uploaded.ok) throw new Error(`Upload ${name} -> ${uploaded.status}: ${(await uploaded.text()).slice(0, 300)}`);
  const asset = await uploaded.json();
  console.log(`Uploaded ${asset.name} (${asset.size} bytes) -> ${asset.browser_download_url}`);
}
const final = await api(`/releases/tags/${tag}`);
console.log('RELEASE_URL=' + final.html_url);
console.log('RELEASE_ASSETS=' + (final.assets ?? []).map((a) => `${a.name}(${a.size})`).join(', '));
