import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files=readdirSync('server').filter(name=>name.endsWith('.test.mjs')).map(name=>`server/${name}`);
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{encoding:'utf8',maxBuffer:10*1024*1024});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.status!==0&&process.env.GITHUB_ACTIONS){
  const failures=(result.stdout||'').match(/not ok [\s\S]*?\n\s*\.\.\./g)||[result.stderr||result.error?.message||'Cloud tests failed.'];
  for(const failure of failures)console.log(`::error::${failure.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A')}`);
}
process.exitCode=result.status??1;
