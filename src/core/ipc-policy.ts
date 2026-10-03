import { validateSettings } from './settings.js';
import { isValidEndpointHost } from './endpoints.js';
import { validTimeout, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from './saved-state.js';
const NO_PAYLOAD=new Set(['getState','importServer','createSnapshot','startServer','stopServer','startPeerListener','cleanUp']);
const METHODS=new Set([...NO_PAYLOAD,'saveProfile','sendCommand','saveSettings','addPeer','sendSnapshot','handoff','recoverStopped']);
function boundedString(v:unknown,max:number):v is string{return typeof v==='string'&&v.length<=max&&!v.includes('\0');}
function fingerprint(v:unknown):v is string{return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);}
export interface TrustedIpcContext {senderId:number;expectedSenderId:number;isMainFrame:boolean}
export function validateCall(method:unknown,payload:unknown,senderUrl:string,expectedUrl:string,context?:TrustedIpcContext):Record<string,any>{
  if(senderUrl!==expectedUrl||!context||!Number.isSafeInteger(context.senderId)||context.senderId<1||context.senderId!==context.expectedSenderId||context.isMainFrame!==true)throw new Error('Untrusted IPC sender');
  if(typeof method!=='string'||!METHODS.has(method))throw new Error('Unknown IPC method');
  if(NO_PAYLOAD.has(method))return {};
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid payload');
  const p=payload as Record<string,unknown>;
  switch(method){
    case 'saveSettings':return validateSettings(p) as unknown as Record<string,any>;
    case 'saveProfile':
      if(!boundedString(p.executable,4096)||!p.executable.trim())throw new Error('Invalid executable');
      if(!Array.isArray(p.args)||p.args.length>100||p.args.some(v=>!boundedString(v,4096)))throw new Error('Launch arguments must be a bounded string array');
      for(const key of ['startTimeoutSeconds','stopTimeoutSeconds'] as const){
        if(key in p&&!validTimeout(p[key]))throw new Error(`Launch timeouts must be whole seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
      }
      return {executable:p.executable,args:[...p.args],...('startTimeoutSeconds' in p?{startTimeoutSeconds:p.startTimeoutSeconds}:{}),...('stopTimeoutSeconds' in p?{stopTimeoutSeconds:p.stopTimeoutSeconds}:{})};
    case 'sendCommand':
      if(!boundedString(p.command,1024)||/[\r\n]/.test(p.command)||!p.command.trim())throw new Error('Invalid console command');return {command:p.command};
    case 'addPeer':
      if(!boundedString(p.name,100)||!p.name.trim()||!fingerprint(p.fingerprint)||!isValidEndpointHost(p.host)||!Number.isInteger(p.port)||Number(p.port)<1||Number(p.port)>65535)throw new Error('Invalid peer identity or endpoint (ASCII DNS or IPv4 only; IPv6 is not supported)');
      return {name:p.name,fingerprint:p.fingerprint,host:p.host,port:p.port};
    case 'sendSnapshot':case 'handoff':
      if(!fingerprint(p.fingerprint))throw new Error('Invalid peer fingerprint');return {fingerprint:p.fingerprint};
    case 'recoverStopped':
      if(p.confirmed!==true)throw new Error('Confirm the previous server process is stopped');return {confirmed:true};
    default:throw new Error('Unknown IPC method');
  }
}
