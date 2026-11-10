import type { Provider } from './ready-packs-providers.cjs'
import type { PackStore, ProviderStatus } from './ready-packs-types.cjs'

export function sourceReady(p:Provider,store:PackStore):boolean {
 const h=store.sourceHealth?.[p.status.id]
 return !!p.search&&!!p.details&&p.status.capabilities.search===true&&p.status.capabilities.details===true&&p.status.capabilities.images===true&&p.status.readiness!=='needs-access'&&p.status.readiness!=='unsupported'&&!(h&&(h.state==='blocked'||h.state==='error'&&!!h.retryAt&&Date.parse(h.retryAt)>Date.now()))
}
export function sourceStatus(p:Provider,store:PackStore):ProviderStatus {
 const h=store.sourceHealth?.[p.status.id]
 if(!p.search||!p.details||p.status.readiness==='needs-access'||p.status.readiness==='unsupported')return {...p.status,lastSuccessfulAt:h?.lastSuccessfulAt??null}
 if(h?.state==='blocked'||h?.state==='error'&&!!h.retryAt&&Date.parse(h.retryAt)>Date.now())return {...p.status,readiness:'paused',status:h.message,lastSuccessfulAt:h.lastSuccessfulAt,setupAction:'Review the source restriction in Settings. Recheck is explicit; no blocked request is repeated automatically.'}
 return {...p.status,...h?.state==='accessible'?{readiness:'accessible' as const,lastSuccessfulAt:h.lastSuccessfulAt,status:'Catalogue was accessible at '+h.lastSuccessfulAt+'. Listing facts still require per-product checks.'}:{}}
}
export function recordSource(store:PackStore,id:string,error?:string):void {
 const now=new Date().toISOString(),previous=store.sourceHealth?.[id]
 store.sourceHealth??={}
 const blocked=!!error&&/HTTP (401|403|404)|challenge|captcha|login|permission|outside.*scope|unsupported.*response/i.test(error)
 store.sourceHealth[id]=error?{state:blocked?'blocked':'error',message:error,attemptedAt:now,lastSuccessfulAt:previous?.lastSuccessfulAt??null,retryAt:blocked?null:new Date(Date.now()+(/429/.test(error)?3600000:15*60000)).toISOString()}:{state:'accessible',message:'Catalogue request succeeded; individual products may still fail verification.',attemptedAt:now,lastSuccessfulAt:now,retryAt:null}
}

// Serial per origin, parallel across independent stores. Cancellation also drains queued workers.
export class HostGate {
 private tails=new Map<string,Promise<void>>()
 async run<T>(host:string,signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  const previous=this.tails.get(host)??Promise.resolve();let release!:()=>void
  const current=new Promise<void>(resolve=>{release=resolve});this.tails.set(host,current)
  await previous
  try{signal.throwIfAborted();return await work()}finally{release();if(this.tails.get(host)===current)this.tails.delete(host)}
 }
}
