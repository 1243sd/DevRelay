import {spawn} from 'node:child_process';
import {choices,readConfig,resolveAgent} from './adapters.mjs';
function which(bin){return new Promise(resolve=>{const cmd=process.platform==='win32'?'where':'which';const c=spawn(cmd,[bin],{stdio:['ignore','pipe','ignore']});let o='';c.stdout.on('data',d=>o+=d);c.on('error',()=>resolve(''));c.on('close',code=>resolve(code===0?o.trim().split(/\r?\n/)[0]:''));});}
function probe(bin,args,ms=6000){return new Promise(resolve=>{let output='';const c=spawn(bin,args,{stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>c.kill('SIGTERM'),ms);for(const stream of [c.stdout,c.stderr])stream.on('data',d=>output=(output+d).slice(0,500));c.on('error',e=>{clearTimeout(timer);resolve({ok:false,detail:e.message})});c.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,detail:output.trim().slice(0,220)||`exit ${code}`})});});}
const authChecks={claude:['auth','status'],codex:['login','status'],gemini:['--version'],pi:['--version'],cursor:['--version'],opencode:['--version']};
export async function doctor(agent){const conf=readConfig();const keys=agent?[agent]:Object.keys(choices);let bad=0;for(const key of keys){let spec;try{spec=resolveAgent(key,conf)}catch(e){console.log(`${key}: NOT CONFIGURED (${e.message})`);continue;}
 const found=await which(spec.binary);if(!found){console.log(`${key}: NOT INSTALLED (${spec.binary} not in PATH)`);bad++;continue;}
 const version=await probe(spec.binary,['--version']);let auth='unverified (no safe universal auth probe)';
 if(key==='claude'||key==='codex'){const a=await probe(spec.binary,authChecks[key],8000);auth=a.ok?'login check OK':`login check inconclusive: ${a.detail}`;}
 console.log(`${key}: ${version.ok?'READY':'FOUND'} ${found}; ${auth}`);
 if(!version.ok)bad++;
 }return bad;}
