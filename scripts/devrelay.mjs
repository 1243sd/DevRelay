#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {choices,readConfig,saveConfig,resolveAgent,configPath} from './adapters.mjs';
import {configure} from './setup.mjs';
import {doctor} from './doctor.mjs';
const baseDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
for(const line of (existsSync(join(baseDir,'.env'))?readFileSync(join(baseDir,'.env'),'utf8'):'').split(/\r?\n/)){
 const m=line.match(/^([A-Z_]+)=(.*)$/);if(m && !process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const api=`http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3210}`;
const token=process.env.API_TOKEN;
const data=resolve(baseDir,process.env.DATA_DIR||'data');
const pidFile=join(data,'server.pid');
const logFile=join(data,'server.log');
const command=process.argv[2]||'help', args=process.argv.slice(3);
const print=(value)=>console.log(JSON.stringify(value,null,2));
function usage(){console.log(`devrelay — multi-agent development orchestrator\n\nCommands:\n  devrelay server start|stop|status\n  devrelay setup
  devrelay doctor [agent]
  devrelay cancel <task-id>
  devrelay agents list|current|use <name>|configure <name>
  devrelay run <approved-plan.json> [--agent <name>]\n  devrelay status [task-id]\n  devrelay report <task-id>\n  devrelay logs <task-id> [--follow] [--attempt N] [--type pi|test]\n  devrelay wait <task-id>\n  devrelay health\n\nRun from any directory after npm link. Configure <project>/.env before starting.`)}
async function request(path,opts={}){
 if(!token)throw new Error('API_TOKEN not set; configure .env');
 let r;
 try{r=await fetch(api+path,{...opts,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(opts.headers||{})}})}
 catch(e){throw new Error(`Cannot reach ${api}: ${e.message}`)}
 const raw=await r.text();let value;try{value=JSON.parse(raw)}catch{value={raw}};
 if(!r.ok)throw new Error(`${r.status}: ${JSON.stringify(value)}`);
 return value;
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function pid(){try{return Number(readFileSync(pidFile,'utf8').trim())}catch{return 0}}
function alive(p){if(!p)return false;try{process.kill(p,0);return true}catch{return false}}
async function main(){
 switch(command){
 case 'help':case '--help':case '-h':usage();return;
 case 'server':{
  const action=args[0]||'status';
  if(action==='status'){print({running:alive(pid()),pid:pid()||null,api});return}
  if(action==='start'){
   if(alive(pid())){print({running:true,pid:pid(),message:'Already running'});return}
   if(!existsSync(join(baseDir,'dist','server.js')))throw new Error('Missing dist/server.js; run npm run build');
   mkdirSync(data,{recursive:true});const fd=openSync(logFile,'a');
   const child=spawn(process.execPath,[join(baseDir,'dist','server.js')],{cwd:baseDir,detached:true,stdio:['ignore',fd,fd],env:process.env});
   child.unref();writeFileSync(pidFile,String(child.pid));
   await sleep(500);
   if(!alive(child.pid))throw new Error(`Server exited during startup. Check ${logFile}`);
   print({running:true,pid:child.pid,log:logFile});return;
  }
  if(action==='stop'){
   const p=pid();if(!alive(p)){print({running:false});return}process.kill(p,'SIGTERM');
   for(let i=0;i<20&&alive(p);i++)await sleep(100);
   if(!alive(p)&&existsSync(pidFile))unlinkSync(pidFile);
   print({stopped:!alive(p),pid:p,message:'Stopping the server can interrupt an active task; interrupted tasks will be marked failed on restart.'});return;
  }
  throw new Error('Usage: devrelay server start|stop|status');
 }
 case 'setup':await configure(args[0]);return;
 case 'doctor':{const bad=await doctor(args[0]);if(bad)process.exitCode=1;return;}
 case 'cancel':{if(!args[0])throw new Error('Usage: devrelay cancel <task-id>');print(await request(`/tasks/${encodeURIComponent(args[0])}/cancel`,{method:'POST'}));return;}
 case 'agents':{
  const action=args[0]||'list';const conf=readConfig();
  if(action==='list'){print(Object.fromEntries(Object.entries(choices).map(([key,value])=>[key,{name:value.name,default:key===conf.defaultAgent,configured:(()=>{try{resolveAgent(key,conf);return true}catch{return false}})()}])));return}
  if(action==='current'){print({defaultAgent:conf.defaultAgent,configPath});return}
  if(action==='use'){if(!args[1])throw new Error('Usage: devrelay agents use <name>');resolveAgent(args[1],conf);conf.defaultAgent=args[1];saveConfig(conf);print({defaultAgent:args[1],note:'Existing queued tasks retain their selected agent. Restart server to ensure config loaded in all environments.'});return}
  if(action==='configure'){await configure(args[1]);return}
  throw new Error('Usage: devrelay agents list|current|use <name>|configure <name>');
 }
 case 'run':{
  if(!args[0])throw new Error('Usage: devrelay run approved-plan.json');
  const plan=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  const ai=args.indexOf('--agent');const agent=ai>=0?args[ai+1]:(readConfig().defaultAgent||'pi');resolveAgent(agent);
  print(await request('/tasks',{method:'POST',body:JSON.stringify({approved:true,plan,agent})}));return;
 }
 case 'health':print(await request('/health'));return;
 case 'status':print(await request(args[0]?`/tasks/${encodeURIComponent(args[0])}`:'/tasks'));return;
 case 'report':{
  if(!args[0])throw new Error('Usage: devrelay report <task-id>');
  const j=await request(`/tasks/${encodeURIComponent(args[0])}`);
  print({id:j.id,status:j.status,attempt:j.attempt,report:j.report||null,error:j.error||null,worktree:j.worktree});return;
 }
 case 'wait':{
  if(!args[0])throw new Error('Usage: devrelay wait <task-id>');
  let last='';while(true){const j=await request(`/tasks/${encodeURIComponent(args[0])}`);if(j.status!==last){console.log(`${new Date().toISOString()} ${j.status} (attempt ${j.attempt})`);last=j.status}
   if(['passed','failed','cancelled'].includes(j.status)){print({id:j.id,status:j.status,report:j.report||null,error:j.error||null});if(j.status!=='passed')process.exitCode=1;return;}await sleep(3000)}
 }
 case 'logs':{
  if(!args[0])throw new Error('Usage: devrelay logs <task-id> [--follow] [--attempt N] [--type pi|test]');
  const id=args[0],follow=args.includes('--follow'),nidx=args.indexOf('--attempt'),tidx=args.indexOf('--type');
  const iteration=nidx>=0?Number(args[nidx+1]):null,kind=tidx>=0?args[tidx+1]:'pi';
  if(!['pi','test'].includes(kind))throw new Error('--type must be pi or test');
  let previous='';while(true){const j=await request(`/tasks/${encodeURIComponent(id)}`);const attempt=iteration||j.attempt;
   const file=join(data,'jobs',`${id}-${kind}-${attempt}.log`);
   const value=existsSync(file)?readFileSync(file,'utf8'):`No ${kind} log for attempt ${attempt} yet`;
   if(value!==previous){console.log(value);previous=value}
   if(!follow||['passed','failed','cancelled'].includes(j.status))return;
   await sleep(2000);
  }
 }
 default:usage();throw new Error(`Unknown command: ${command}`);
 }
}
main().catch(e=>{console.error('Error:',e.message);process.exitCode=1});
