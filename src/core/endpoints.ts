import { isIP } from 'node:net';

/** ASCII DNS or canonical IPv4 only. IPv6 (including bracketed form) is deliberately unsupported. */
export function isValidEndpointHost(host:unknown):host is string {
  if(typeof host!=='string'||!host||host.length>253)return false;
  const ip=isIP(host);
  if(ip===4)return true;
  if(ip===6||/^[0-9.]+$/.test(host))return false;
  return host.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
