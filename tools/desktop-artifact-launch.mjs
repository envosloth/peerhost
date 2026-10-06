import path from 'node:path';
import { createRequire } from 'node:module';

/** QA-only launcher: never lets an artifact check fall back to the user's live profile. */
export function desktopArtifactLaunch(project, profileRoot, packaged) {
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot) || /[\0\r\n]/.test(profileRoot)) throw new Error('An explicit absolute isolated profile is required');
  if (packaged !== undefined && (typeof packaged !== 'string' || !path.isAbsolute(packaged) || /[\0\r\n]/.test(packaged))) throw new Error('The artifact executable must be an absolute local path');
  return {
    executablePath: packaged ?? createRequire(import.meta.url)('electron'),
    args: [...(packaged === undefined ? [path.join(project, 'dist/apps/desktop/main.js')] : []), '--profile-root=' + profileRoot],
  };
}
