import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const children=[];
let stopping=false;
function stop(code=0) {
  if(stopping) return; stopping=true;
  for(const child of children) child.kill('SIGTERM');
  process.exitCode=code;
}
function run(args) {
  const child=spawn(process.execPath,args,{stdio:'inherit'});children.push(child);
  child.on('error',error=>{console.error(error.message);stop(1)});
  child.on('exit',code=>{if(!stopping) stop(code || 0)});
}
run(['--env-file-if-exists=server/private/gateway.env','--env-file-if-exists=.env','server/tracking.mjs']);
run(['--env-file-if-exists=.env','server/sandbox.mjs']);
run([resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1',...process.argv.slice(2)]);
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
