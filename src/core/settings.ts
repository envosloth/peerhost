import { isValidEndpointHost } from './endpoints.js';
export interface Settings { persistentAddress:boolean; gatewayAddress:string; startAtLogin:boolean }
export function defaultSettings():Settings { return {persistentAddress:false,gatewayAddress:'',startAtLogin:false}; }
export function validateSettings(input:unknown):Settings {
  if(!input || typeof input!=='object') throw new Error('Settings must be an object');
  const s=input as Record<string,unknown>;
  if(typeof s.persistentAddress!=='boolean'||typeof s.startAtLogin!=='boolean') throw new Error('Settings flags must be boolean');
  if(typeof s.gatewayAddress!=='string'||s.gatewayAddress.length>253+6) throw new Error('Invalid gateway address');
  const address=s.gatewayAddress.trim();
  if(s.persistentAddress){
    const match=/^([^:]+):(\d{1,5})$/.exec(address);
    const port=match?Number(match[2]):0;
    if(!match || port<1 || port>65535 || !isValidEndpointHost(match[1])) throw new Error('Gateway address must be an ASCII hostname or IPv4 address plus :port; IPv6 is not supported');
  }
  return {persistentAddress:s.persistentAddress,gatewayAddress:address,startAtLogin:s.startAtLogin};
}
