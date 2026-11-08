import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { renameSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { rankResearch, readRequest, researchPrompt, researchSchema, verificationPrompt } from './product-find-research.cjs'
import type { ResearchStore } from './product-find-research.cjs'
import type { ProductFindJob, ProductFindRequest } from './contracts.cjs'

export async function findAntigravityCLI(): Promise<string | null> {
  const binary = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const candidates = [
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin', binary)] : []),
    path.join(os.homedir(), '.local', 'bin', binary),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(folder => path.join(folder, binary)),
  ]
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate } catch { /* Try the next installed location. */ }
  }
  return null
}
// Tests inject a real local child process instead of using an AI account.
type RunnerOptions = { resolveCLI?: () => Promise<string | null>; prefixArgs?: string[]; timeoutMs?: number }
export async function readResearch(folder: string): Promise<ResearchStore | null> {
  try {
    const file = path.join(folder, 'research-v1.json')
    if ((await stat(file)).size > 4_000_000) throw new Error('Research file exceeds 4 MB.')
    const value = JSON.parse(await readFile(file,'utf8')) as ResearchStore
    if (value.version !== 1 || !Array.isArray(value.products) || !value.observations) throw new Error('Invalid research file.')
    readRequest(value.request)
    return value
  } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export class ProductFindRunner {
  private job: ProductFindJob = { state:'idle',message:'Ready to research recent trends.',startedAt:null }
  private child: ChildProcess | null = null
  private generation = 0
  private active = false
  private stopping = false
  constructor(private folder:string, private options:RunnerOptions = {}) {}
  status():ProductFindJob { return {...this.job} }
  cancel():void {
    if (!this.active) return
    this.generation++
    this.job={...this.job,state:'cancelled',message:'Research cancelled. Previous results were not changed.'}
    this.stopProcess()
  }
  private stopProcess():void {
    const child=this.child
    if (!child?.pid) return
    if (process.platform==='win32') {
      this.stopping=true
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false})
      killer.on('error',()=>{child.kill();this.stopping=false})
      killer.on('close',()=>{this.stopping=false})
    } else child.kill('SIGTERM')
  }
  async start(value:unknown):Promise<void> {
    if(this.active || this.stopping) throw new Error('Research is already running or stopping.')
    const request=readRequest(value), generation=++this.generation
    this.active=true
    this.job={state:'running',message:'Starting trend research...',startedAt:new Date().toISOString()}
    void this.execute(request,generation).catch(error=>{
      if(generation===this.generation) this.job={...this.job,state:'error',message:error instanceof Error?error.message:'Research failed.'}
    }).finally(()=>{this.active=false})
  }
  private ensureCurrent(generation:number):void { if(generation!==this.generation) throw new Error('Research cancelled.') }
  private async execute(request:ProductFindRequest,generation:number):Promise<void> {
    const executable=await (this.options.resolveCLI ?? findAntigravityCLI)()
    this.ensureCurrent(generation)
    if(!executable) throw new Error('Antigravity CLI is missing. Install agy and sign in once.')
    const previous=await readResearch(this.folder)
    const work=path.join(this.folder,'agent-workspace')
    await mkdir(work,{recursive:true})
    const schemaPath=path.join(work,'research-schema.json')
    await writeFile(schemaPath,JSON.stringify(researchSchema),'utf8')
    this.ensureCurrent(generation)
    this.job.message='1/3 Discovering recent creator posts and buying-interest comments...'
    const discovered=await this.runAgent(executable,work,schemaPath,researchPrompt(request,previous),generation)
    this.ensureCurrent(generation)
    const initial=rankResearch(discovered,request,previous)
    let result=initial
    if(initial.products.length) {
      this.job.message='2/3 Reopening evidence and checking exact marketplace matches...'
      const verified=await this.runAgent(executable,work,schemaPath,verificationPrompt(request,{products:initial.products,note:initial.note}),generation)
      this.ensureCurrent(generation)
      result=rankResearch(verified,request,previous)
      const originals=new Set(initial.products.map(p=>p.product_url))
      result.products=result.products.filter(p=>originals.has(p.product_url))
      result.rejected+=initial.rejected
    }
    this.ensureCurrent(generation)
    this.job.message='3/3 Ranking evidence and saving product photos and links...'
    const encoded=JSON.stringify(result,null,2)
    if(Buffer.byteLength(encoded)>4_000_000) throw new Error('Research results are too large.')
    const temporary=path.join(this.folder,`research-${generation}.tmp`)
    await writeFile(temporary,encoded,'utf8')
    this.ensureCurrent(generation)
    renameSync(temporary,path.join(this.folder,'research-v1.json'))
    this.job={...this.job,state:'complete',message:`${result.products.length} trend-backed candidates saved. ${result.rejected} candidates rejected for missing evidence. ${result.note}`}
  }
  private runAgent(executable:string,work:string,schemaPath:string,prompt:string,generation:number):Promise<unknown> {
    this.ensureCurrent(generation)
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,[...(this.options.prefixArgs??[]),'-p',prompt,'--output-format','json','--json-schema',schemaPath,'--print-timeout','10m'],{cwd:work,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']})
      this.child=child
      let output='',diagnostic='',size=0,failure:Error|null=null
      const fail=(message:string)=>{if(!failure){failure=new Error(message);this.stopProcess()}}
      const timer=setTimeout(()=>fail('Research timed out. Previous results were not changed.'),this.options.timeoutMs??600_000)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data',(chunk:string)=>{size+=Buffer.byteLength(chunk);if(size>3_000_000){fail('Antigravity response exceeded the size limit.');return}output+=chunk})
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data',(chunk:string)=>{diagnostic=(diagnostic+chunk).slice(-8000)})
      child.on('error',error=>{failure=error})
      child.on('close',code=>{
        clearTimeout(timer)
        if(this.child===child)this.child=null
        try {
          this.ensureCurrent(generation)
          if(failure)throw failure
          if(code!==0)throw new Error(/auth|sign.?in|login|credential/i.test(diagnostic)?'Antigravity sign-in is required. Run agy once, sign in, then retry.':`Antigravity exited with code ${code??'unknown'}. Check browser access, permissions and quota.`)
          let envelope
          try{envelope=JSON.parse(output)}catch{throw new Error('Antigravity returned invalid JSON. Previous results were not changed.')}
          if(envelope?.status!=='SUCCESS')throw new Error('Antigravity research did not complete. Check account and browser access.')
          const result=envelope.structured_output??JSON.parse(envelope.response)
          resolve(result)
        }catch(error){reject(error)}
      })
    })
  }
}
