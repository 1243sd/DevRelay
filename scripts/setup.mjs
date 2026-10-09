import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {choices,readConfig,saveConfig,resolveAgent,configPath} from './adapters.mjs';

export async function configure(preselect){
 const rl=createInterface({input,output});
 try{
  const keys=Object.keys(choices);
  console.log('\nChoose default coding agent (not your code editor):');
  keys.forEach((k,i)=>console.log(` ${i+1}. ${choices[k].name} (${k})${choices[k].verified?'':' [needs verification/configuration]'}`));
  const response=preselect || await rl.question(`Select number/name [${readConfig().defaultAgent||'pi'}]: `);
  const key=keys[Number(response)-1]||response.trim()||readConfig().defaultAgent||'pi';
  if(!choices[key])throw new Error('Unknown selection');
  const config=readConfig(); config.agents ||= {};
  if(!choices[key].binary){
   console.log('This agent has no verified built-in headless CLI; configure YOUR working CLI command.');
   const binary=(await rl.question('CLI executable path/name: ')).trim();
   const argLine=(await rl.question('CLI arguments, use {prompt} placeholder (JSON string array, e.g. ["run","{prompt}"]): ')).trim();
   const args=JSON.parse(argLine);
   if(!binary||!Array.isArray(args)||!args.includes('{prompt}'))throw new Error('Invalid executable/args');
   config.agents[key]={binary,args};
  }
  config.defaultAgent=key;
  resolveAgent(key,config);
  saveConfig(config);
  console.log(`Default: ${key}\nSaved: ${configPath}\nThe server must be restarted after changing the default agent.`);
 }finally{rl.close()}
}
