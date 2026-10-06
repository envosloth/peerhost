import { isIP } from 'node:net';

/** ASCII DNS or canonical IPv4 only. IPv6 (including bracketed form) is deliberately unsupported. */
export function isValidEndpointHost(host:unknown):host is string {
  if(typeof host!=='string'||!host||host.length>253)return false;
  const ip=isIP(host);
  if(ip===4)return true;
  if(ip===6||/^[0-9.]+$/.test(host))return false;
  return host.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

/** Loopback, RFC1918 and CGNAT/Tailscale (100.64/10) addresses: reachable only from the same PC, home network or tailnet. */
export function isPrivateEndpointHost(host:unknown):boolean {
  if(typeof host!=='string'||!host)return false;
  if(host==='localhost'||host.endsWith('.localhost'))return true;
  if(isIP(host)!==4)return false;
  const [a=-1,b=-1]=host.split('.').map(Number);
  return a===10||a===127||(a===192&&b===168)||(a===172&&b>=16&&b<=31)||(a===100&&b>=64&&b<=127);
}
