import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const envFile=resolve('.env');
for(const line of readFileSync(envFile,'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
const path=process.argv[2];if(!path){console.error('Usage: node scripts/submit.mjs approved-plan.json');process.exit(2);}
const plan=JSON.parse(readFileSync(resolve(path),'utf8'));
const host=process.env.HOST||'127.0.0.1',port=process.env.PORT||3210;
const r=await fetch(`http://${host}:${port}/tasks`,{method:'POST',headers:{Authorization:`Bearer ${process.env.API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({approved:true,plan})});
console.log(await r.text());if(!r.ok)process.exit(1);
