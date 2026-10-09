import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';

export const choices={
 pi:{name:'Pi Agent',binary:'pi',args:['--mode','json','--no-session','--provider','google','{prompt}'],verified:true},
 claude:{name:'Claude Code',binary:'claude',args:['-p','--output-format','json','{prompt}'],verified:true},
 cursor:{name:'Cursor Agent',binary:'cursor-agent',args:['-p','--force','--output-format','json','{prompt}'],verified:true},
 codex:{name:'OpenAI Codex',binary:'codex',args:['exec','{prompt}'],verified:false},
 gemini:{name:'Gemini CLI',binary:'gemini',args:['-p','{prompt}'],verified:false},
 opencode:{name:'OpenCode',binary:'opencode',args:['run','{prompt}'],verified:false},
 zcode:{name:'ZCode (custom CLI bridge)',verified:false},
 windsurf:{name:'Windsurf / Cascade (custom bridge; no verified headless CLI)',verified:false},
 custom:{name:'Custom Agent (your own CLI)',verified:false}
};
export const configPath=process.env.DEVRELAY_CONFIG || join(homedir(),'.config','devrelay','config.json');
const legacyPath=process.env.PI_BRIDGE_CONFIG || join(homedir(),'.config','pi-bridge','config.json');
// One-time migration: never overwrite a new-format config.
function migrateLegacy(){if(existsSync(configPath)||!existsSync(legacyPath))return;mkdirSync(dirname(configPath),{recursive:true});writeFileSync(configPath,readFileSync(legacyPath),{mode:0o600,flag:'wx'});}
export function readConfig(){migrateLegacy();try{return JSON.parse(readFileSync(configPath,'utf8'));}catch{return {defaultAgent:'pi',agents:{}}}}
export function saveConfig(config){mkdirSync(dirname(configPath),{recursive:true});writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});}
export function resolveAgent(key,config=readConfig()){
 const preset=choices[key];if(!preset)throw new Error(`Unknown agent '${key}'`);
 const custom=config.agents?.[key]||{};
 const spec={...preset,...custom};
 if(!spec.binary||!Array.isArray(spec.args)||!spec.args.includes('{prompt}'))throw new Error(`Agent '${key}' has no valid executable profile. Configure binary and args including {prompt}.`);
 if(typeof spec.binary!=='string'||spec.args.some(x=>typeof x!=='string'))throw new Error('Invalid adapter config');
 return spec;
}
export function commandFor(key,prompt,config=readConfig()){
 const spec=resolveAgent(key,config);
 const args=spec.args.map(x=>x.replaceAll('{prompt}',prompt));
 return {binary:spec.binary,args};
}
