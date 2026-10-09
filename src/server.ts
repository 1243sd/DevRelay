import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';

function loadEnv() {
  const p = resolve('.env'); if (!existsSync(p)) return;
  for (const line of readFileSync(p,'utf8').split(/\r?\n/)) {
    const m=line.match(/^([A-Z_]+)=(.*)$/); if(m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
  }
}
loadEnv();
const env = (k:string, fallback='') => process.env[k] || fallback;
const HOST=env('HOST','127.0.0.1'), PORT=Number(env('PORT','3210'));
const TOKEN=env('API_TOKEN'), ROOT=resolve(env('PROJECT_ROOT','.'));
const DATA=resolve(env('DATA_DIR','./data')); const JOBS=join(DATA,'jobs');const WORK=join(DATA,'worktrees');
const MAX_RETRIES=Math.max(1,Math.min(10,Number(env('MAX_RETRIES','3'))));
const PI_TIMEOUT=Number(env('PI_TIMEOUT_MS','1800000'));
const TEST_TIMEOUT=Number(env('TEST_TIMEOUT_MS','300000'));
const TEST_COMMAND=env('TEST_COMMAND','npm test');
const agentConfigFile=env('DEVRELAY_CONFIG',join(env('HOME',env('USERPROFILE','.')),'.config','devrelay','config.json'));
function agentConfig():any { try {return JSON.parse(readFileSync(agentConfigFile,'utf8'));} catch {return {defaultAgent:'pi',agents:{}};} }
const profiles:Record<string,{binary?:string;args?:string[]}>= {pi:{binary:'pi',args:['--mode','json','--no-session','--provider',env('PI_PROVIDER','google'),...(env('PI_MODEL')?['--model',env('PI_MODEL')]:[]),'{prompt}']},claude:{binary:'claude',args:['-p','--output-format','json','{prompt}']},cursor:{binary:'cursor-agent',args:['-p','--force','--output-format','json','{prompt}']},codex:{binary:'codex',args:['exec','{prompt}']},gemini:{binary:'gemini',args:['-p','{prompt}']},opencode:{binary:'opencode',args:['run','{prompt}']},zcode:{},windsurf:{},custom:{}};
function selectAgent(key:string,prompt:string){const conf=agentConfig(), spec={...profiles[key],...(conf.agents?.[key]||{})};if(!profiles[key]||!spec.binary||!Array.isArray(spec.args)||!spec.args.includes('{prompt}')||spec.args.some((x:string)=>typeof x!=='string'))throw new Error('Unconfigured/invalid agent profile: '+key);return {bin:spec.binary,args:spec.args.map((x:string)=>x.replaceAll('{prompt}',prompt))};}
if (!TOKEN || TOKEN.length<24 || !env('OPENAI_API_KEY') || !env('OPENAI_MODEL') || !env('PROJECT_ROOT')) {
  throw new Error('Set API_TOKEN (>=24 characters), OPENAI_API_KEY, OPENAI_MODEL, PROJECT_ROOT in .env');
}
if (!['127.0.0.1','::1','localhost'].includes(HOST)) throw new Error('Bind localhost only; do not expose this execution API publicly');
if (!Number.isInteger(PORT) || PORT<1 || PORT>65535) throw new Error('Invalid PORT');
if (!existsSync(join(ROOT,'.git'))) throw new Error('PROJECT_ROOT must be a git repo with .git directory (not a linked worktree)');
mkdirSync(JOBS,{recursive:true});mkdirSync(WORK,{recursive:true});

type State='queued'|'developing'|'testing'|'reviewing'|'passed'|'failed'|'cancelled';
type Plan={title:string;requirements:string[];acceptance:string[]};
type Job={id:string;agent:string;status:State;plan:Plan;createdAt:string;updatedAt:string;attempt:number;branch:string;worktree:string;history:{at:string;stage:string;detail:string}[];report?:unknown;error?:string};
const all=new Map<string,Job>();let active:string|null=null;
const controllers=new Map<string,AbortController>();
const sensitive=/([A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\s*[=:]\s*)[^\s]+/gi;
function redact(s:string){return s.replace(sensitive,'$1[REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED_KEY]');}
function cancelled(job:Job){return (job.status as State)==='cancelled';}
function ensureAllowedProject(){
 const resolved=realpathSync(ROOT);
 if(resolved==='/' || resolved===process.env.HOME)throw new Error('Unsafe project root');
 if(DATA===ROOT || DATA.startsWith(ROOT+'/')) throw new Error('DATA_DIR must be outside project checkout');
}
ensureAllowedProject();

const now=()=>new Date().toISOString();
function save(job:Job){job.updatedAt=now();const file=join(JOBS,job.id+'.json'),tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(job,null,2));renameSync(tmp,file);all.set(job.id,job);}
function note(j:Job,stage:string,detail:string){j.history.push({at:now(),stage,detail:redact(detail).slice(0,1500)});save(j);}
for (const f of readdirSync(JOBS).filter(x=>x.endsWith('.json'))) {
 try {const j=JSON.parse(readFileSync(join(JOBS,f),'utf8')) as Job;
   if(['developing','testing','reviewing'].includes(j.status)){j.status='queued';j.history.push({at:now(),stage:'recovered',detail:'Interrupted process: retry this attempt from a clean worktree; previous working tree is retained for inspection'});save(j);} else all.set(j.id,j);
 } catch(e){console.error('Invalid job file',f,e);}
}

async function run(bin:string,args:string[],cwd:string,timeout:number,logFile?:string,signal?:AbortSignal):Promise<{code:number;out:string;err:string}> {
 if(signal?.aborted)throw new Error('Cancelled');
 return await new Promise((ok,reject)=>{
  const child=spawn(bin,args,{cwd,env:childEnv(),stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
  let out='',err='',done=false;let timedOut=false,aborted=false;
  const cap=2_000_000;
  const terminate=()=>{if(child.pid && process.platform!=='win32'){try{process.kill(-child.pid,'SIGTERM')}catch{}}else child.kill('SIGTERM');setTimeout(()=>{if(child.pid && process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL')}catch{}}else child.kill('SIGKILL');},2000).unref();};
  const onAbort=()=>{aborted=true;terminate()};signal?.addEventListener('abort',onAbort,{once:true});
  child.stdout?.on('data',(d:Buffer)=>{out=(out+d.toString()).slice(-cap)});
  child.stderr?.on('data',(d:Buffer)=>{err=(err+d.toString()).slice(-cap)});
  const timer=setTimeout(()=>{timedOut=true;terminate()},timeout);
  const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort)};
  child.on('error',e=>{if(done)return;done=true;clean();reject(e)});
  child.on('close',code=>{if(done)return;done=true;clean();if(logFile)writeFileSync(logFile,redact(`EXIT=${code} TIMEOUT=${timedOut} CANCELLED=${aborted}\nSTDOUT\n${out}\nSTDERR\n${err}`),{mode:0o600});ok({code:aborted?-2:timedOut?-1:code??-1,out,err})});
 });
}
function childEnv():NodeJS.ProcessEnv {
 const allowed=['PATH','HOME','USER','USERPROFILE','TMPDIR','TEMP','TMP','LANG','LC_ALL','SHELL','SYSTEMROOT','COMSPEC','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','TERM','CI'];
 const out:NodeJS.ProcessEnv={};for(const k of allowed){if(process.env[k])out[k]=process.env[k]}
 // Provider auth should be scoped to credentials in the user's standard CLI config. Explicit opt-in for env-based credentials.
 for(const k of env('AGENT_ENV_ALLOWLIST').split(',').map(x=>x.trim()).filter(Boolean)){if(process.env[k])out[k]=process.env[k]}
 return out;
}
async function git(args:string[],cwd=ROOT){const r=await run('git',args,cwd,60000);if(r.code!==0)throw new Error('git '+args.join(' ')+' failed: '+r.err.slice(-1200));return r.out.trim();}
async function review(plan:Plan,diff:string,tests:string,attempt:number,signal?:AbortSignal):Promise<{passed:boolean;issues:string[];summary:string}> {
 const schema={type:'object',additionalProperties:false,required:['passed','issues','summary'],properties:{passed:{type:'boolean'},issues:{type:'array',items:{type:'string'}},summary:{type:'string'}}};
 const response=await fetch(env('OPENAI_BASE_URL','https://api.openai.com/v1')+'/responses',{signal,method:'POST',headers:{Authorization:'Bearer '+env('OPENAI_API_KEY'),'Content-Type':'application/json'},body:JSON.stringify({model:env('OPENAI_MODEL'),instructions:'You are an independent code acceptance reviewer. Inspect requirements, test output, and unified diff. Reject when functionality is unproven, insecure, incomplete or diff evidence insufficient. Tests already passed, but do not assume that proves requirements. Output structured JSON.',input:JSON.stringify({plan,diff,tests,attempt}),text:{format:{type:'json_schema',name:'acceptance',strict:true,schema}}})});
 const body=await response.json() as any;if(!response.ok)throw new Error('OpenAI error '+response.status+': '+JSON.stringify(body).slice(0,700));
 const text=body.output?.flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('') || body.output_text;
 if(!text)throw new Error('No acceptance response returned');
 const parsed=JSON.parse(text);if(typeof parsed.passed!=='boolean'||!Array.isArray(parsed.issues))throw new Error('Malformed review');return parsed;
}
async function execute(job:Job){
 active=job.id;const controller=new AbortController();controllers.set(job.id,controller);const signal=controller.signal;
 try{
  const branch=job.branch,folder=job.worktree;
  if(!existsSync(folder)){
   // After restart a former worktree may exist; if missing branch, create it.
   const branches=await git(['branch','--list',branch]);
   if(branches.trim())await git(['worktree','add',folder,branch]);
   else await git(['worktree','add','-b',branch,folder,'HEAD']);
  }
  note(job,'init','Using worktree '+folder);
  let feedback:string[]=[];
  for(let n=1;n<=MAX_RETRIES;n++){
   if(cancelled(job)||signal.aborted)return;
   job.attempt=n;job.status='developing';note(job,'developing',job.agent+' attempt '+n);
   const prompt=`Work only in this repository checkout. Implement the approved plan; run checks when useful. Do not commit, push, deploy, access secrets, or change external systems. Approved plan:\n${JSON.stringify(job.plan)}\nPrevious review issues:\n${JSON.stringify(feedback)}\nWhen done, briefly report changes.`;
   const selected=selectAgent(job.agent||'pi',prompt);
   const pi=await run(selected.bin,selected.args,folder,PI_TIMEOUT,join(JOBS,job.id+`-pi-${n}.log`),signal);
   if(signal.aborted)return;
   if(pi.code!==0){feedback=[job.agent+' exited with code '+pi.code+': '+pi.err.slice(-500)];note(job,'pi-error',feedback[0]);continue;}
   job.status='testing';note(job,'testing','Running trusted configured test command');
   const test=await run(process.platform==='win32'?'cmd':'sh',process.platform==='win32'?['/d','/s','/c',TEST_COMMAND]:['-c',TEST_COMMAND],folder,TEST_TIMEOUT,join(JOBS,job.id+`-test-${n}.log`),signal);
   if(signal.aborted)return;
   if(test.code!==0){feedback=['Tests failed (exit '+test.code+'): '+(test.out+'\n'+test.err).slice(-5000)];note(job,'tests-failed',feedback[0]);continue;}
   // git add -N makes new files appear in git diff without staging actual content
   await git(['add','-N','.'],folder);
   const diff=await git(['diff','--no-ext-diff','--no-color','HEAD','--'],folder);
   if(!diff.trim()){feedback=['No code changes detected'];note(job,'review-failed',feedback[0]);continue;}
   if(diff.length>120_000){feedback=['Diff exceeds 120k characters; split task into smaller changes'];note(job,'review-failed',feedback[0]);break;}
   job.status='reviewing';note(job,'reviewing','Submitting diff and tests to OpenAI');
   const verdict=await review(job.plan,diff,(test.out+'\n'+test.err).slice(-15000),n,signal);if(signal.aborted)return;job.report=verdict;save(job);
   if(verdict.passed){job.status='passed';note(job,'passed',verdict.summary);return;}
   feedback=verdict.issues.length?verdict.issues:['Reviewer did not approve implementation'];note(job,'review-failed',feedback.join('; '));
  }
  job.status='failed';job.error=feedback.join('; ')||'No successful acceptance';note(job,'failed',job.error);
 }catch(e){if(!cancelled(job)){job.status='failed';job.error=redact(String(e));note(job,'failed',job.error);}}finally{controllers.delete(job.id);active=null;setImmediate(dispatch);}
}
function dispatch(){if(active)return;const job=[...all.values()].filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(job){active=job.id;void execute(job);}}
setImmediate(dispatch);
function respond(res:http.ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function parse(req:http.IncomingMessage){let s='';for await(const chunk of req){s+=chunk;if(s.length>50_000)throw new Error('Request too large');}return JSON.parse(s||'{}');}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url||'/',`http://${HOST}:${PORT}`);
  if(url.pathname==='/health'&&req.method==='GET')return respond(res,200,{ok:true,active,queued:[...all.values()].filter(j=>j.status==='queued').length});
  const supplied=(req.headers.authorization||'').replace(/^Bearer /,'');
  const a=Buffer.from(supplied),b=Buffer.from(TOKEN);
  if(a.length!==b.length||!timingSafeEqual(a,b))return respond(res,401,{error:'Unauthorized'});
  if(req.method==='POST'&&url.pathname==='/tasks'){
    const body=await parse(req);
    const p=body.plan;
    if(!p||typeof p.title!=='string'||p.title.length>200||!Array.isArray(p.requirements)||!Array.isArray(p.acceptance)||!p.requirements.length||!p.acceptance.length||p.requirements.length>40||p.acceptance.length>40||[...p.requirements,...p.acceptance].some((v:any)=>typeof v!=='string'||v.length>2000))return respond(res,400,{error:'Invalid plan; requires title, requirements[], acceptance[]'});
    if(body.approved!==true)return respond(res,400,{error:'approved:true required from authenticated operator'});
    const agent=body.agent || agentConfig().defaultAgent || 'pi'; if(typeof agent!=='string')return respond(res,400,{error:'Invalid agent'});try{selectAgent(agent,'test')}catch(e){return respond(res,400,{error:String(e)})}
    const id=randomUUID();const j:Job={id,agent,status:'queued',plan:p,attempt:0,branch:'pi-auto/'+id.slice(0,8),worktree:join(WORK,id),createdAt:now(),updatedAt:now(),history:[]};save(j);note(j,'queued','Approved task submitted');setImmediate(dispatch);return respond(res,202,{id,status:j.status});
  }
  const cancelMatch=url.pathname.match(/^\/tasks\/([a-f0-9-]{36})\/cancel$/);
  if(req.method==='POST'&&cancelMatch){
   const j=all.get(cancelMatch[1]);if(!j)return respond(res,404,{error:'Not found'});
   if(['passed','failed','cancelled'].includes(j.status))return respond(res,409,{error:'Already terminal',status:j.status});
   j.status='cancelled';note(j,'cancelled','Cancelled by operator');controllers.get(j.id)?.abort();return respond(res,200,{id:j.id,status:j.status});
  }
  if(req.method==='GET'&&url.pathname==='/tasks')return respond(res,200,{tasks:[...all.values()].map(j=>({id:j.id,title:j.plan.title,agent:j.agent||'pi',status:j.status,attempt:j.attempt,updatedAt:j.updatedAt}))});
  const match=url.pathname.match(/^\/tasks\/([a-f0-9-]{36})$/);
  if(req.method==='GET'&&match){const j=all.get(match[1]);return j?respond(res,200,j):respond(res,404,{error:'Not found'});}
  return respond(res,404,{error:'Not found'});
 }catch(e){respond(res,400,{error:String(e)});}
});
server.listen(PORT,HOST,()=>console.log(`Orchestrator listening on http://${HOST}:${PORT}`));
