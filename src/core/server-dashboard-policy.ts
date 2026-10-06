import { isServerId } from './saved-state.js';
import { validateRelativePath } from './paths.js';
import { validateServerText } from './server-files.js';
import { validateServerProperties } from './server-properties.js';
import { validateScheduleInput } from './server-scheduler.js';

export const DASHBOARD_METHODS = new Set(['getServerDashboard', 'listServerFiles', 'readServerFile', 'writeServerFile', 'saveServerSettings', 'saveServerSchedule', 'deleteServerSchedule', 'runServerSchedule', 'managePlayer']);
function keys(input: Record<string, unknown>, expected: string) {
  if (Object.keys(input).sort().join(',') !== expected) throw new Error('Invalid dashboard payload');
}
export function validateDashboardCall(method: string, input: Record<string, unknown>): Record<string, any> {
  if (!isServerId(input.id)) throw new Error('Invalid server id');
  const id = input.id;
  if (method === 'getServerDashboard') { keys(input, 'id'); return { id }; }
  if (['listServerFiles', 'readServerFile', 'writeServerFile'].includes(method)) {
    keys(input, method === 'writeServerFile' ? 'expectedHash,id,path,text' : 'id,path');
    if (typeof input.path !== 'string' || input.path.length > 4096 || input.path.includes('\\')) throw new Error('Unsafe server file path');
    if (input.path !== '' || method !== 'listServerFiles') validateRelativePath(input.path);
    if (method === 'writeServerFile') { validateServerText(input.path, input.text, input.expectedHash); return { id, path: input.path, text: input.text, expectedHash: input.expectedHash }; }
    return { id, path: input.path };
  }
  if (method === 'saveServerSettings') { keys(input, 'id,settings'); return { id, settings: validateServerProperties(input.settings) }; }
  if (method === 'saveServerSchedule') { keys(input, 'id,schedule'); return { id, schedule: validateScheduleInput(input.schedule) }; }
  if (method === 'deleteServerSchedule' || method === 'runServerSchedule') {
    keys(input, 'id,scheduleId'); if (!isServerId(input.scheduleId)) throw new Error('Invalid schedule id'); return { id, scheduleId: input.scheduleId };
  }
  if (method === 'managePlayer') {
    keys(input, 'action,id,name');
    if (!['kick', 'whitelist-add', 'whitelist-remove'].includes(String(input.action)) || typeof input.name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(input.name)) throw new Error('Invalid player action or Minecraft name');
    return { id, action: input.action, name: input.name };
  }
  throw new Error('Unknown dashboard method');
}
