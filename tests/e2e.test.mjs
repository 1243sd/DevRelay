import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
const serverJs=resolve('dist/server.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const git=(repo,...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr)};
async function scenario(kind){
 const temp=mkdtempSync(join(tmpdir(),'devrelay-e2e-'));const repo=join(temp,'repo');mkdirSync(repo);
 git(repo,'init');git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','E2E');writeFileSync(join(repo,'README.md'),'hello\n');git(repo,'add','.');git(repo,'commit','-m','init');
 const agent=join(temp,'mock-agent.mjs');writeFileSync(agent,`import {writeFileSync,existsSync,readFileSync} from 'node:fs';\nimport {join} from 'node:path';\nconst f=join(process.cwd(),'feature.txt');writeFileSync(f,existsSync(f)?readFileSync(f,'utf8')+'retry\\n':'first\\n');\nif(process.env.SLOW_AGENT==='1')await new Promise(r=>setTimeout(r,1000));`);
 const config=join(temp,'agents.json');writeFileSync(config,JSON.stringify({defaultAgent:'custom',agents:{custom:{binary:process.execPath,args:[agent,'{prompt}']}}}));
 let reviews=0;const mock=http.createServer(async(req,res)=>{let s='';for await(const d of req)s+=d;reviews++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({passed:kind!=='retry'||reviews>=2,issues:['please refine'],summary:'review '+reviews})}]}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const mockPort=mock.address().port;
 const port=29000+Math.floor(Math.random()*10000);const token=randomBytes(24).toString('hex');const env={...process.env,HOST:'127.0.0.1',PORT:String(port),API_TOKEN:token,PROJECT_ROOT:repo,DATA_DIR:join(temp,'data'),OPENAI_API_KEY:'test',OPENAI_MODEL:'test',OPENAI_BASE_URL:`http://127.0.0.1:${mockPort}`,DEVRELAY_CONFIG:config,TEST_COMMAND:'test -f feature.txt',MAX_RETRIES:'3',AGENT_ENV_ALLOWLIST:['cancel','recover'].includes(kind)?'SLOW_AGENT':'',SLOW_AGENT:['cancel','recover'].includes(kind)?'1':''};
 let service;const start=()=>{service=spawn(process.execPath,[serverJs],{env,stdio:['ignore','pipe','pipe']});};start();
 const call=async(url,options={})=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});return {status:r.status,data:await r.json()}};
 try{
  let ready=false;for(let i=0;i<100;i++){try{const r=await call('/health');if(r.status===200){ready=true;break}}catch{}await wait(60)}assert.ok(ready,'server ready');
  const created=await call('/tasks',{method:'POST',body:JSON.stringify({approved:true,agent:'custom',plan:{title:'Example',requirements:['Create feature'],acceptance:['test passes']}})});assert.equal(created.status,202);const id=created.data.id;
  if(kind==='cancel'){let running=false;for(let i=0;i<100;i++){const j=(await call('/tasks/'+id)).data;if(j.status==='developing'){running=true;break}await wait(50)}assert.ok(running);const c=await call('/tasks/'+id+'/cancel',{method:'POST'});assert.equal(c.data.status,'cancelled');await wait(450);assert.equal((await call('/tasks/'+id)).data.status,'cancelled');return;}
  if(kind==='recover'){let developing=false;for(let i=0;i<100;i++){const j=(await call('/tasks/'+id)).data;if(j.status==='developing'){developing=true;break}await wait(20)}assert.ok(developing);service.kill('SIGKILL');await new Promise(r=>service.once('close',r));
   start();for(let i=0;i<100;i++){try{await call('/health');break}catch{await wait(30)}}}
  let result;for(let i=0;i<400;i++){result=(await call('/tasks/'+id)).data;if(['passed','failed'].includes(result.status))break;await wait(50)}assert.equal(result.status,'passed',JSON.stringify(result));if(kind==='retry')assert.equal(result.attempt,2);assert.ok(readFileSync(join(result.worktree,'feature.txt'),'utf8').length>0);
 }finally{service?.kill('SIGTERM');await new Promise(r=>{if(service?.exitCode!==null)return r();service.once('close',r);setTimeout(r,2000)});await new Promise(r=>mock.close(r));rmSync(temp,{recursive:true,force:true});}
}
test('mock end-to-end acceptance',async()=>scenario('pass'));
test('mock end-to-end rejection then repair',async()=>scenario('retry'));
test('mock running task cancellation',async()=>scenario('cancel'));
test('mock recovery after abrupt coordinator exit',async()=>scenario('recover'));
