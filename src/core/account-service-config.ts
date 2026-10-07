import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {accountEndpoint,type AccountEndpoint} from './accounts.js';

/** Explicit configuration wins; malformed files never silently switch account directories.
 * Isolated test profiles must never borrow the public production directory. */
export async function loadAccountServiceConfig(options:{profileRoot:string;bundledDirectory:string;isolated:boolean;override?:string}):Promise<AccountEndpoint|undefined>{
 if(options.override)return accountEndpoint(JSON.parse(options.override));
 const files=[path.join(options.profileRoot,'account-service.json'),...(!options.isolated?[
  path.join(options.bundledDirectory,'account-service.json'),
  path.join(options.bundledDirectory,'public-account-service.json'),
 ]:[])];
 for(const file of files){
  try{return accountEndpoint(JSON.parse(await readFile(file,'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 return undefined;
}
