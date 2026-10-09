import {readFileSync} from 'node:fs';
for(const line of readFileSync('.env','utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
const id=process.argv[2];const base=`http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3210}`;
const r=await fetch(base+(id?`/tasks/${id}`:'/tasks'),{headers:{Authorization:`Bearer ${process.env.API_TOKEN}`}});
console.log(JSON.stringify(await r.json(),null,2));if(!r.ok)process.exit(1);
