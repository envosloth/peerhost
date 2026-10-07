// Signal cleanup is injectable so restoration can be tested without changing live ingress.
export function installInterruptCleanup({cleanup,emitter=process,exit=code=>process.exit(code),report=error=>console.error(error)}){
 let interrupted=false;
 const handle=code=>()=>{
  if(interrupted)return;
  interrupted=true;
  void (async()=>{try{await cleanup();exit(code);}catch(error){report(error);exit(1);}})();
 };
 const int=handle(130),term=handle(143);
 emitter.on('SIGINT',int);emitter.on('SIGTERM',term);
 return ()=>{emitter.removeListener('SIGINT',int);emitter.removeListener('SIGTERM',term);};
}
