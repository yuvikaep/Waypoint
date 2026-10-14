import { execFileSync } from 'node:child_process';

if(process.getuid?.()!==0||process.argv[2]!=='--apply')throw Error('Run on the gateway as root with --apply.');
// Limit only the advertised segment size on GT06 TCP handshakes. Other services,
// access rules, established connections and packet contents are unchanged.
const rule=['ipv4','mangle','OUTPUT','0','-p','tcp','--sport','5023','--tcp-flags','SYN,RST','SYN','-j','TCPMSS','--set-mss','1300'];
for(const mode of [[],['--permanent']]){
  let output;
  try{output=execFileSync('/usr/bin/firewall-cmd',[...mode,'--direct','--query-rule',...rule],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
  catch(error){if(error.status!==1)throw error;output='no';}
  if(output!=='yes')execFileSync('/usr/bin/firewall-cmd',[...mode,'--direct','--add-rule',...rule],{stdio:'inherit'});
}
console.log('GPS-only MSS compatibility rule installed.');
