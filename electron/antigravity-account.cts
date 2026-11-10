import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { findAntigravityCLI } from './product-find-runner.cjs'
import type { AccountStatus } from './ready-packs-types.cjs'
export type { AccountStatus } from './ready-packs-types.cjs'
export const accountPolicy = {useG1Credits:false,modelProvider:'',toolPermission:'strict',allowNonWorkspaceAccess:false,permissions:{allow:[],deny:['read_file(*)','write_file(*)','command(*)','read_url(*)','execute_url(*)','mcp(*)']}}
export function accountEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {const env={...source};for(const key of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','GOOGLE_CLOUD_QUOTA_PROJECT','CLOUDSDK_CORE_PROJECT','CLOUDSDK_AUTH_ACCESS_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])delete env[key];return env}
type Execute = (exe:string,args:string[],cwd:string,signal:AbortSignal)=>Promise<string>
const execute:Execute=(exe,args,cwd,signal)=>new Promise((resolve,reject)=>{
 signal.throwIfAborted();const child=spawn(exe,args,{cwd,env:accountEnvironment(process.env),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',diagnostic='',size=0,failure:Error|null=null,stopping=false
 const stop=()=>{if(stopping)return;stopping=true;if(process.platform==='win32'&&child.pid){const p=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true});p.on('error',()=>child.kill())}else child.kill()}
 const abort=()=>{failure=new Error('Antigravity request cancelled.');stop()};signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>{failure=new Error('Antigravity timeout. No retry or paid fallback.');stop()},100000)
 child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>64000){failure=new Error('Antigravity output exceeded 64 KB.');stop()}else output+=b.toString()});child.stderr.on('data',(b:Buffer)=>{if(diagnostic.length<16000)diagnostic+=b.toString()});child.on('error',e=>{failure=e})
 child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(failure)return reject(failure);if(code!==0){const message=/quota|resource.exhausted|rate.limit|capacity/i.test(output+diagnostic)?'Antigravity quota limited. Automatic reasoning paused.':/authentication required|not logged|sign.in|oauth/i.test(output+diagnostic)?'Antigravity sign-in required. Run agy interactively once.':'Antigravity command failed. No retry or paid fallback.';return reject(new Error(message))}resolve(output)})
})
export class AccountReasoner {
 status:AccountStatus={state:'not-tested',message:'Test Antigravity connection. No local model required.',cliVersion:null,noOverageVerified:false,models:[],selectedModel:null,lastSuccessfulCall:null,checkedAt:null,quotaRemaining:null}
 private active=false
 private readonly ready:Promise<void>
 constructor(readonly folder:string,private options:{execute?:Execute;resolveCLI?:()=>Promise<string|null>}={}){this.ready=this.restore()}
 private async run(exe:string,args:string[],signal:AbortSignal){await mkdir(this.folder,{recursive:true});return (this.options.execute??execute)(exe,args,this.folder,signal)}
 private async settingsFile(){const file=path.join(this.folder,'account-session.json');await mkdir(this.folder,{recursive:true});await writeFile(file,JSON.stringify(accountPolicy));return file}
 private envelope(text:string){const value=JSON.parse(text);if(value.status!=='SUCCESS')throw new Error(/quota|resource.exhausted|rate.limit/i.test(String(value.error))?'Antigravity quota limited. Automatic reasoning paused.':/auth|login|sign.in/i.test(String(value.error))?'Antigravity sign-in required. Run agy interactively once.':'Antigravity did not complete. No retry or paid fallback.');return value}
 private async saveStatus(){await writeFile(path.join(this.folder,'status.json'),JSON.stringify(this.status))}
 async restore(){try{const s=JSON.parse(await readFile(path.join(this.folder,'status.json'),'utf8')) as AccountStatus;this.status.lastSuccessfulCall=s.lastSuccessfulCall??null;if(['quota-limited','sign-in-required'].includes(s.state)){this.status.state=s.state;this.status.message=s.message}}catch{/* No credential files are read; status is advisory only. */}}
 async inspect(model='',signal:AbortSignal=AbortSignal.timeout(65000)) {
  await this.ready;this.status.noOverageVerified=false;this.status.models=[];this.status.selectedModel=null;this.status.checkedAt=new Date().toISOString();const exe=await(this.options.resolveCLI??findAntigravityCLI)();if(!exe)throw new Error('Official Antigravity CLI unavailable. Install agy and sign in once.')
  const version=(await this.run(exe,['--version'],signal)).trim();if(!/^1\.5\.3$/.test(version))throw new Error('This Antigravity CLI version has not been verified for zero-overage requests. Expected inspected version 1.5.3.');this.status.cliVersion=version
  const file=await this.settingsFile();const base=['--settings',file,'--output-format','json','--print-timeout','20s']
  const config=this.envelope(await this.run(exe,['-p','/config',...base],signal)).command?.data?.config
  if(!config||config.useG1Credits!==false||config.modelProvider!==''||config.gcp||config.toolPermission!=='strict'||accountPolicy.permissions.deny.some(r=>!config.permissions?.deny?.includes(r)))throw new Error('Cannot verify zero-overage account configuration and tool restrictions. Model requests blocked. Set Use AI Credits off in agy /config.')
  this.status.noOverageVerified=true
  const modelText=await this.run(exe,['models'],signal)
  const models=modelText.split('\n').flatMap(line=>{const m=line.match(/^\s*([a-z0-9_.]+(?:-[a-z0-9_.]+)+)\s+(.+)$/);return m?[{id:m[1],label:m[2]}]:[]})
  if(!models.length)throw new Error('No available account model could be verified. Sign in with agy; no guessed model will be used.')
  this.status.models=models;const selected=model?models.find((m:any)=>m.id===model):models.find(m=>/\(Medium\)/.test(m.label))??models.find(m=>m.id===config.model||m.label===config.model)??models[0];if(!selected)throw new Error('Selected model is unavailable for this CLI account. Recheck connection.')
  this.status.selectedModel=selected.id;this.status.state='ready';this.status.message='CLI available; account model listed; credit overages disabled. Quota remaining is unknown.';await this.saveStatus();return {exe,file,model:selected.id}
 }
 async json(prompt:string,schema:unknown,signal:AbortSignal,options:{model?:string;effort?:'medium'|'high';recheck?:boolean}={}) {
  await this.ready;if(Buffer.byteLength(prompt)>24000||Buffer.byteLength(JSON.stringify(schema))>12000)throw new Error('Reasoning input exceeds bounded prompt/schema size.')
  if(this.active)throw new Error('Antigravity reasoning already running.')
  if(!options.recheck&&['quota-limited','sign-in-required'].includes(this.status.state))throw new Error(this.status.message)
  this.active=true
  try{
   const {exe,file,model}=await this.inspect(options.model??'',signal);const key=createHash('sha256').update(JSON.stringify(['account-v1',this.status.cliVersion,model,options.effort??'medium',prompt,schema,accountPolicy])).digest('hex');const cacheFile=path.join(this.folder,'cache.json');let cache:Record<string,{at:number;value:unknown}>={};try{cache=JSON.parse(await readFile(cacheFile,'utf8'))}catch{/* A failed cache read never enables a paid provider. */}
   if(cache[key]&&Date.now()-cache[key].at<7*86400000)return cache[key].value
   this.status.state='running';this.status.message='One bounded account reasoning call; tools denied and AI credits disabled.'
   const response=this.envelope(await this.run(exe,['-p',prompt,'--settings',file,'--model',model,'--effort',options.effort??'medium','--disable-slash-commands','--output-format','json','--json-schema',JSON.stringify(schema),'--print-timeout','90s'],signal));const value=response.structured_output??JSON.parse(response.response)
   cache=Object.fromEntries(Object.entries(cache).filter(([,v])=>Date.now()-v.at<7*86400000).slice(-63));cache[key]={at:Date.now(),value};await writeFile(cacheFile+'.tmp',JSON.stringify(cache));await rename(cacheFile+'.tmp',cacheFile);this.status.state='ready';this.status.lastSuccessfulCall=new Date().toISOString();this.status.message='Authenticated reasoning succeeded. AI credit overages disabled; remaining quota unknown.';await this.saveStatus();return value
  }catch(e){const message=e instanceof Error?e.message:'Antigravity failed.';this.status.state=/quota limited/i.test(message)?'quota-limited':/sign.in|sign in|authenticate|account model/i.test(message)?'sign-in-required':/configuration|version|unavailable|overage/i.test(message)?'blocked':'error';this.status.message=message;await this.saveStatus().catch(()=>{});throw e}finally{this.active=false}
 }
}
const instances=new Map<string,AccountReasoner>()
export function accountReasoner(folder:string){const key=path.resolve(folder,'account-reasoning');let instance=instances.get(key);if(!instance){instance=new AccountReasoner(key);instances.set(key,instance)}return instance}
