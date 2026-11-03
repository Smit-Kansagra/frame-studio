import {Worker} from 'node:worker_threads'
import path from 'node:path'
import {availableParallelism,totalmem,freemem} from 'node:os'
import sharp from 'sharp'
import type {LogoRepairArea} from '../contracts.cjs'
// Native addons read the process environment, not a worker's JS-only copy.
// Set before any worker can load ONNX Runtime.
process.env.ORT_DISABLE_TELEMETRY='1'
import {StorageError} from '../storage/errors.cjs'

export type LogoProgress=(percent:number,message:string)=>void
type Task={source:string;target:string;width?:number;height?:number;retry?:boolean;area?:LogoRepairArea}
const MB=1024*1024
export function cleanupCapacity(cpus=availableParallelism(),ram=totalmem(),free=freemem()) {
  const budget=Math.max(128*MB,Math.min(ram*.35,free*.6))
  return {limit:Math.max(1,Math.min(Math.max(1,cpus-1),Math.floor(budget/(128*MB)))),budget}
}
export class LogoQueue {
  private active=0
  private activeBytes=0
  private readonly waiting:Array<{bytes:number;launch:()=>void}>=[]
  private readonly keys=new Set<string>()
  private readonly pending=new Set<Promise<unknown>>()
  constructor(readonly concurrency=cleanupCapacity().limit,private readonly workerFile=path.join(__dirname,'logo-worker.cjs'),private readonly memoryBudget=cleanupCapacity().budget){}
  private pump(){
    while(this.active<this.concurrency&&this.waiting.length){
      const index=this.waiting.findIndex(item=>this.active===0||this.activeBytes+item.bytes<=this.memoryBudget)
      if(index<0)return
      this.waiting.splice(index,1)[0].launch()
    }
  }
  run(key:string,task:Task,progress?:LogoProgress):Promise<{removed:boolean;confidence:number}> {
    if(this.keys.has(key))return Promise.reject(new StorageError('BUSY','This image is already being processed locally.'))
    this.keys.add(key);try{progress?.(0,'Queued for local cleanup')}catch(error){this.keys.delete(key);return Promise.reject(error)}
    const pending=new Promise<{removed:boolean;confidence:number}>((resolve,reject)=>{
      let bytes=128*MB
      const launch=()=>{
        this.active++;this.activeBytes+=bytes
        let settled=false,worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined
        const finish=(error?:Error,result?:{removed:boolean;confidence:number})=>{
          if(settled)return;settled=true;clearTimeout(timer)
          const end=async()=>{await worker?.terminate().catch(()=>{});this.active--;this.activeBytes-=bytes;this.keys.delete(key);this.pump();error?reject(error):resolve(result!)}
          void end()
        }
        try{
          worker=new Worker(this.workerFile,{workerData:task,resourceLimits:{maxOldGenerationSizeMb:192},env:{...process.env,ORT_DISABLE_TELEMETRY:'1'}})
          timer=setTimeout(()=>finish(new StorageError('IMAGE_PROCESSING_FAILED','Local image cleanup timed out. The original image is preserved.')),120_000)
          worker.on('message',(value:{type:string;percent?:number;message?:string;result?:{removed:boolean;confidence:number}})=>{
            if(settled)return
            if(value.type==='progress'){try{progress?.(Math.min(95,Math.max(0,Math.floor(value.percent??0))),value.message??'Processing image')}catch(error){finish(error instanceof Error?error:new Error('Progress could not be saved.'))}}
            else if(value.type==='done')finish(undefined,value.result)
            else if(value.type==='error')finish(new StorageError('IMAGE_PROCESSING_FAILED',value.message??'Local image cleanup failed.'))
          })
          worker.once('error',()=>finish(new StorageError('IMAGE_PROCESSING_FAILED','Local image worker could not finish. The original image is preserved.')))
          worker.once('exit',()=>{if(!settled)finish(new StorageError('IMAGE_PROCESSING_FAILED','Local image cleanup was interrupted. Retry this image.'))})
        }catch(error){finish(error instanceof Error?error:new Error('Local image worker could not start.'))}
      }
      void sharp(task.source,{limitInputPixels:40_000_000}).metadata().then(meta=>{
        bytes=256*MB+(meta.width??1)*(meta.height??1)*24
        this.waiting.push({bytes,launch});this.pump()
      }).catch(()=>{this.keys.delete(key);reject(new StorageError('IMAGE_PROCESSING_FAILED','The image could not be read for local cleanup. The original is preserved.'))})
    })
    this.pending.add(pending)
    void pending.then(()=>this.pending.delete(pending),()=>this.pending.delete(pending))
    return pending
  }
  async drain(){await Promise.allSettled([...this.pending])}
}
export const logoQueue=new LogoQueue()
