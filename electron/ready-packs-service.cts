import { HostGate, recordSource, sourceReady, sourceStatus } from './ready-packs-access.cjs'
import { nextThemes, themeQueries } from './ready-packs-planner.cjs'
import { validateCatalogue } from './ready-packs-catalogue.cjs'
import { commissionEstimate } from './ready-packs-ai.cjs'
import type { PackAdvice, FindSelection, PlanSlot } from './ready-packs-types.cjs'
import { applyLicences } from './ready-packs-licences.cjs'
import { discoveryDiagnostics, reject } from './ready-packs-diagnostics.cjs'
import { PackRepository, assemble, canonical, defaultFindSelection, eligible, matchingPhoto, photoReady, reviewable, selectProducts, validateSelection, validateSettings } from './ready-packs-core.cjs'
import { classify, importProducts } from './ready-packs-providers.cjs'
import type { Provider } from './ready-packs-providers.cjs'
import type { PackStore, PackProduct, Performance, ReadyPack } from './ready-packs-types.cjs'
import { publicHttps } from './product-find-data.cjs'
import { bytes } from './product-network.cjs'
import sharp from 'sharp'

// Workers always settle before cancellation releases the job lock or writes final state.
async function workers<T>(rows:T[],limit:number,signal:AbortSignal,work:(row:T)=>Promise<void>){
 let next=0
 await Promise.allSettled(Array.from({length:Math.min(limit,rows.length)},async()=>{while(next<rows.length&&!signal.aborted){const row=rows[next++];await work(row)}}))
}
const message=(e:unknown)=>e instanceof Error?e.message:'Source could not be read.'
export class PackService {
 state!:PackStore
 private active:AbortController|null=null
 private running:Promise<void>|null=null
 private locked=false
 private hostGate=new HostGate()
 private photoRequests=new Map<string,Promise<{url:string;at:string}>>()
 private cache=new Map<string,{at:number;products:PackProduct[]}>()
 readonly ready:Promise<void>
 constructor(readonly repository:PackRepository,private providers:()=>Promise<Provider[]>,private reasoning?:(store:PackStore,slot:PlanSlot,signal:AbortSignal)=>Promise<PackAdvice|null>) {this.ready=this.repository.load().then(s=>{this.state=s})}
 get busy(){return this.locked||!!this.active}
 get searching(){return !!this.active}
 async status(){await this.ready;this.state.providers=(await this.providers()).map(p=>sourceStatus(p,this.state));for(const p of this.state.products){applyLicences(p,this.state.licences??[]);p.commissionEstimateInr=commissionEstimate(p)}const copy=structuredClone(this.state);copy.reviewableIds=Object.fromEntries(copy.packs.map(pack=>[pack.id,pack.productIds.filter(id=>{const p=copy.products.find(p=>p.id===id);return !!p&&reviewable(p,pack)})]));return copy}
 async mutate(work:()=>Promise<void>){await this.ready;if(this.busy)throw new Error('A search is running. Cancel or wait before editing.');this.locked=true;const before=structuredClone(this.state);try{await work();await this.repository.save(this.state)}catch(e){this.state=before;throw e}finally{this.locked=false}}
 async cancel(){this.active?.abort();await this.running}
 // Product Find is click-to-search. Saved legacy schedule preferences remain intact but inactive.
 async tick(){await this.ready}
 queue(){return this.state.packs.filter(p=>p.productIds.length&&(p.state==='drafted'||p.state==='exported'))}
 pack(id:string){const p=this.state.packs.find(p=>p.id===id);if(!p)throw new Error('Pack not found.');return p}
 async preferences(value:unknown){await this.mutate(async()=>{this.state.preferences=validateSelection(value,this.state.settings)})}
 async catalogue(value:unknown){await this.mutate(async()=>{const c=validateCatalogue(value);if((this.state.catalogues??[]).some(x=>x.id!==c.id&&x.origin===c.origin))throw new Error('A source for this origin already exists; edit it instead.');if((this.state.catalogues??[]).filter(x=>x.id!==c.id).length>=8)throw new Error('Up to eight authorized store sources are supported.');this.state.catalogues=[...(this.state.catalogues??[]).filter(x=>x.id!==c.id),c];if(this.state.sourceHealth)delete this.state.sourceHealth[c.id];this.cache.clear()})}
 async recheckSource(id:string){await this.mutate(async()=>{if(!(await this.providers()).some(p=>p.status.id===id))throw new Error('Unknown source.');if(this.state.sourceHealth)delete this.state.sourceHealth[id];for(const p of this.state.products.filter(p=>p.retailer===id)){p.photoFailure=undefined;p.failures=p.failures.filter(f=>!f.startsWith('Photo verification failed:'))}this.state.actionableError=undefined;this.cache.clear()})}
 async generate(_manual=true){return this.next()}
 async next(value?:unknown,doneId?:string){
  await this.ready
  const preferences=validateSelection(value??this.state.preferences??defaultFindSelection(),this.state.settings)
  if(doneId)await this.done(doneId)
  const session=this.state.searchSession,pack=session?.packId?this.pack(session.packId):null
  if(pack&&['drafted','exported'].includes(pack.state)&&pack.productIds.length<pack.requested&&session&&preferences.category===session.selection.category&&preferences.min===session.selection.min&&preferences.max===session.selection.max&&preferences.size===session.selection.size&&preferences.storeMode===session.selection.storeMode)return this.find(session.selection,true)
  return this.find(preferences)
 }
 async find(value:unknown,more=false,replacement?:string){
  await this.ready;if(this.busy)throw new Error('A search is still running or stopping.')
  const preferences=validateSelection(more?this.state.searchSession?.selection:value??this.state.preferences??defaultFindSelection(),this.state.settings)
  this.locked=true
  try{
   if(!more)this.state.preferences=preferences
   const providers=await this.providers(),ready=providers.filter(p=>sourceReady(p,this.state));this.state.providers=providers.map(p=>sourceStatus(p,this.state))
   const selection:FindSelection={...preferences,stores:more||preferences.storeMode!=='auto'?preferences.stores:ready.map(p=>p.status.id)}
   const usable=ready.filter(p=>selection.stores.includes(p.status.id))
   if(!usable.length){
    const paused=providers.some(p=>this.state.sourceHealth?.[p.status.id]?.state==='blocked')
    const reason=paused?'Previously blocked source access is paused. Review its restriction in Settings before an explicit recheck.':'No permitted automatic catalogue source is configured. Existing browser companion supports Flow only; opening a retailer website does not connect it. Optional existing merchant/API access is managed in Settings. No purchase or paid access is required or suggested.'
    this.state.actionableError={code:paused?'source-blocked':'source-setup',message:reason,action:'Review Product Find source access in Settings'}
    this.state.job={state:'error',message:'Product source setup required',dueAt:new Date().toISOString(),attempts:0}
    await this.repository.save(this.state);return
   }
   const themes=more&&this.state.searchSession?[{slot:structuredClone(this.state.searchSession.slot),reason:this.state.searchSession.themeReason??'Continuing the same collection; theme, stores and budget unchanged.'}]:nextThemes(this.state,selection)
   if(!themes.length)throw new Error('No category is enabled for these preferences. Enable a suitable family in Settings / Coverage preferences.')
   if(more)this.cache.clear()
   const abort=new AbortController(),signal=AbortSignal.any([abort.signal,AbortSignal.timeout(180000)])
   this.photoRequests.clear();this.active=abort;this.state.actionableError=undefined
   this.state.job={state:'running',message:'Choosing your next clothing theme...',dueAt:new Date().toISOString(),attempts:0}
   // The full multi-source/multi-query lifecycle shares one lock, deadline and cancellation promise.
   this.running=(async()=>{
    try{
     for(let index=0;index<themes.length;index++){
      signal.throwIfAborted()
      const {slot,reason}=themes[index];slot.variation='Saved budget; no hidden budget variation'
      this.state.selection=selection
      if(!more)this.state.searchSession={selection:structuredClone(selection),slot,packId:null,messages:[],themeReason:(index?'Previous theme had no qualifying inventory from an accessible source. ':'')+reason}
      this.state.job.state='running';this.state.job.message='Finding '+slot.subcategory+' within INR '+selection.min+'-'+selection.max+'...'
      await this.repository.save(this.state)
      const result=await this.collect(abort,selection,slot,replacement,signal)
      if(result.count||!result.canFallback||more)break
     }
    }catch(e){if(/Account reasoning/.test(message(e)))this.state.actionableError={code:'account',message:message(e),action:'Review account status in Settings'};this.state.job={state:abort.signal.aborted?'cancelled':'error',message:abort.signal.aborted?'Search cancelled; collected candidates kept.':message(e),dueAt:new Date().toISOString(),attempts:0};await this.repository.save(this.state)}
    finally{this.active=null;this.running=null}
   })().catch(e=>{this.state.job.state='error';this.state.job.message='Could not save search: '+message(e)})
  }finally{this.locked=false}
 }
 private merge(rows:PackProduct[]){for(const p of rows){const index=this.state.products.findIndex(x=>x.id===p.id);if(index<0)this.state.products.push(p);else{const old=this.state.products[index];this.state.products[index]={...p,photoFailure:p.photoFailure??(!p.photoObservation&&p.images.some(i=>i.url===old.photoFailure?.url)&&p.variant===old.variant?old.photoFailure:undefined),photoObservation:p.photoObservation??(!p.failures.some(f=>f.startsWith('Photo verification failed:'))&&old.url===p.url&&old.variant===p.variant&&p.images.some(i=>i.url===old.photoObservation?.url)?old.photoObservation:undefined),state:old.state,lastUsedAt:old.lastUsedAt,evidence:[...old.evidence,...p.evidence].slice(-30)}}}}
 private async verifyPhoto(p:PackProduct,signal:AbortSignal):Promise<void>{
  if(!matchingPhoto(p)){p.photoObservation=undefined;return}
  const image=p.images.find(i=>{try{return i.variant===p.variant&&canonical(i.source,p.catalogue).id===p.id}catch{return false}})!
  p.images=[image,...p.images.filter(i=>i!==image)]
  if(photoReady(p)&&p.photoObservation?.url===image.url)return
  p.photoObservation=undefined
  const previous=p.photoFailure
  if(previous?.url===image.url&&(previous.retryAt===null||Date.parse(previous.retryAt)>Date.now())){if(!p.failures.some(f=>f.startsWith('Photo verification failed:')))p.failures.push('Photo verification failed: '+previous.reason);return}
  try{
   let pending=this.photoRequests.get(image.url)
   if(!pending){
    pending=(async()=>{
     const r=await this.hostGate.run(new URL(image.url).hostname,signal,()=>bytes(image.url,AbortSignal.any([signal,AbortSignal.timeout(15000)]),15_000_000))
     if(!r.type.startsWith('image/'))throw new Error('Listing photo URL did not return an image.')
     const metadata=await sharp(r.data,{limitInputPixels:40_000_000}).metadata()
     if(!metadata.width||!metadata.height||metadata.width*metadata.height>40_000_000)throw new Error('Listing photo has invalid or excessive dimensions.')
     signal.throwIfAborted();return{url:image.url,at:new Date().toISOString()}
    })()
    this.photoRequests.set(image.url,pending)
   }
   p.photoObservation=await pending;p.photoFailure=undefined
   p.failures=p.failures.filter(f=>!f.startsWith('Photo verification failed:'))
  }catch(e){p.failures.push('Photo verification failed: '+message(e));if(!signal.aborted)p.photoFailure={url:image.url,at:new Date().toISOString(),reason:message(e),retryAt:/HTTP (401|403)|challenge|captcha|Private/i.test(message(e))?null:new Date(Date.now()+15*60000).toISOString()};signal.throwIfAborted()}
 }
 private async collect(abort:AbortController,selection:FindSelection,slot:PlanSlot,replacement:string|undefined,signal:AbortSignal){
 const session=this.state.searchSession!
 const errors:string[]=[];let resultCount=0,inventoryAccessible=false,usedReasoning=false,photoAccessFailed=false
 try{
 const providers=(await this.providers()).filter(p=>selection.stores.includes(p.status.id)&&sourceReady(p,this.state))
 const definition=this.state.settings.categories.find(c=>c.id===slot.category);if(!definition||definition.deferred)throw new Error('Saved category is unavailable or deferred. Choose clothes again.');const category={...definition,min:selection.min,max:selection.max}
 const queries=themeQueries(slot,this.state.settings.season,this.state.settings.occasion);const query=queries[0]
 const reports=providers.map(p=>{p.diagnostics??=discoveryDiagnostics(p.status.id+': '+query);p.diagnostics.query=p.status.id+': '+queries.join(' | ');return p.diagnostics});this.state.diagnostics=[...(this.state.diagnostics??[]),...reports].slice(-16)
 const pools=new Map<string,PackProduct[]>()
 // Independent stores run concurrently; one failed platform never rejects another's rows.
 await workers(providers,3,signal,async provider=>{
  const found:PackProduct[]=[]
  for(const query of queries){
   if(signal.aborted||!sourceReady(provider,this.state))break
   const d=provider.diagnostics;const beforeRejects=d?.rejections.length??0
   try{
    const key=[provider.status.id,query,selection.min,selection.max].join(':');const cached=this.cache.get(key);const fromCache=!!cached&&Date.now()-cached.at<6*3600000
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(65000)])
    const rows=fromCache?structuredClone(cached!.products):await this.hostGate.run(provider.status.host??provider.status.id,requestSignal,()=>provider.search!(category,query,requestSignal))
    const selected=rows.filter(p=>selection.stores.includes(p.retailer)&&p.retailer===provider.status.id)
    found.push(...selected);pools.set(provider.status.id,[...new Map(found.map(p=>[p.id,p])).values()].slice(0,24))
    const restriction=d?.rejections.slice(beforeRejects).find(r=>/HTTP (401|403|429)|challenge|captcha|login/i.test(r.reason))
    if(restriction){recordSource(this.state,provider.status.id,restriction.reason);errors.push(provider.status.id+': '+restriction.reason);break}
    const noReliableRows=selected.length===0&&(d?.rejections.slice(beforeRejects).some(r=>['listing','parsing','variant'].includes(r.stage))??false)
    const requiredFacts=selected.some(p=>p.title.trim()&&p.price!==null&&p.price>0&&p.currency==='INR'&&p.observedAt&&Number.isFinite(Date.parse(p.observedAt))&&matchingPhoto(p))
    if(noReliableRows||selected.length>0&&!requiredFacts){const reason='Readable catalogue did not provide reliable INR listing facts and matching variant photos. This is a source-data limitation, not a category/budget mismatch.';errors.push(provider.status.id+': '+reason);recordSource(this.state,provider.status.id,reason);break}
    inventoryAccessible=true
    if(!fromCache){recordSource(this.state,provider.status.id);this.cache.set(key,{at:Date.now(),products:structuredClone(selected)})}if(this.cache.size>60)this.cache.delete(this.cache.keys().next().value!)
    const matching=found.filter(p=>{if(!p.category||!p.subcategory)classify(p,this.state.settings.categories);return p.category===slot.category&&p.subcategory===slot.subcategory&&p.currency==='INR'&&p.price!==null&&p.price>=selection.min&&p.price<=selection.max&&matchingPhoto(p)&&p.stock!=='out-of-stock'})
    if(selectProducts(matching,selection.size+2).length>=selection.size+2)break
   }catch(e){const reason=message(e);errors.push(provider.status.id+': '+reason);reject(d,'search',reason);if(!signal.aborted)recordSource(this.state,provider.status.id,reason);break}
  }
 })
 this.merge([...pools.values()].flat());signal.throwIfAborted()
 // Include retained candidates only from selected platforms. Imports are an optional fallback.
 const pool=[...pools.values()].flat();const retained=this.state.products.filter(p=>selection.stores.includes(p.retailer)&&(!p.category||p.category===slot.category)).slice(-30)
 const currentIds=session.packId?this.pack(session.packId).productIds:[]
 const currentProducts=this.state.products.filter(p=>currentIds.includes(p.id)&&selection.stores.includes(p.retailer))
 const unique=[...new Map([...currentProducts,...pool,...retained].map(p=>[p.id,p])).values()].slice(0,30).map(p=>this.state.products.find(saved=>saved.id===p.id)??p)
 const verified:PackProduct[]=[]
 await workers(unique,3,signal,async original=>{
  let p=structuredClone(original);const provider=providers.find(x=>x.status.id===p.retailer);const d=provider?.diagnostics
  try{
   const stale=!p.observedAt||!Number.isFinite(Date.parse(p.observedAt))||Date.parse(p.observedAt)>Date.now()||Date.now()-Date.parse(p.observedAt)>6*3600000
   const failed=p.failures.some(f=>f.startsWith('Revalidation failed:'))
   if((stale||failed||p.match!=='exact'||!matchingPhoto(p)||!p.title||p.price===null||p.currency!=='INR')&&provider?.details&&sourceReady(provider,this.state))p=await this.hostGate.run(provider.status.host??provider.status.id,signal,()=>{if(!sourceReady(provider,this.state))throw new Error('Source refresh paused after its access failure.');return provider.details!(p,AbortSignal.any([signal,AbortSignal.timeout(25000)]))})
   else if(stale)throw new Error('No authorized detail refresh available; listing facts are missing or stale.')
   if(p.title!==original.title){p.category='';p.subcategory='';p.aiClassification=undefined}
   if(!p.category||!p.subcategory)classify(p,this.state.settings.categories)
   if(!p.category&&p.title===original.title&&original.aiClassification){p.category=original.aiClassification.category;p.subcategory=original.aiClassification.subcategory;p.aiClassification=original.aiClassification}
   if(p.title&&p.price!==null&&p.price>0&&p.currency==='INR'&&p.price>=selection.min&&p.price<=selection.max&&p.stock!=='out-of-stock')await this.verifyPhoto(p,signal)
   if(p.photoFailure&&!photoReady(p))photoAccessFailed=true
   applyLicences(p,this.state.licences??[])
   if(p.category&&p.category!==slot.category||p.subcategory&&p.subcategory!==slot.subcategory)reject(d,'category','Observed clothing category differs from chosen theme.')
   else if(p.category===slot.category&&p.subcategory===slot.subcategory){if(d)d.counts.categoryMatches++}
   else reject(d,'category','Category unknown; requires classification from observed listing evidence.')
   if(p.price===null||p.currency!=='INR')reject(d,'budget','Observed INR price unavailable.')
   else if(p.price<selection.min||p.price>selection.max)reject(d,'budget','Observed price outside selected hard budget.')
   else if(d)d.counts.budgetMatches++
   if(p.match==='exact'){if(d)d.counts.variantMatches++}else reject(d,'variant','Listing/photo variant relationship unverified.')
   if(matchingPhoto(p)&&photoReady(p)){if(d)d.counts.usablePhotos++}else reject(d,'photos',p.photoFailure?.reason??'Photo read or exact listing/variant relationship remains unverified.')
   if(p.stock==='out-of-stock')reject(d,'stock','Listing reports out of stock.')
   p.assessment={fit:p.subcategory===slot.subcategory?'Matches selected theme':'Category classification pending',demand:'Product-specific demand unknown',readiness:matchingPhoto(p)?'Matching listing photo; export rights checked separately':'Matching photo unverified'}
  }catch(e){p.failures.push(message(e));reject(d,'listing',message(e));if(provider&&!signal.aborted&&/HTTP (401|403|429)|challenge|captcha/i.test(message(e)))recordSource(this.state,provider.status.id,message(e));if(p.observedAt)p.failures.push('Revalidation failed: '+message(e))}
  verified.push(p)
 })
 // Even cancelled searches retain collected evidence. No pack is committed after cancellation.
 this.merge(verified);signal.throwIfAborted()
 const existing=session.packId?this.pack(session.packId):null;if(existing&&!['drafted','exported'].includes(existing.state))throw new Error('This result is archived. Click Find products for a new result.')
 const view=structuredClone(this.state);view.selection=selection;view.settings.size=selection.size
 view.settings.categories=view.settings.categories.map(c=>c.id===category.id?category:c)
 // AI and assembly see only selected stores and bounded candidates, never unrelated libraries.
 const candidateIds=new Set(unique.map(p=>p.id))
 view.products=view.products.filter(p=>selection.stores.includes(p.retailer)&&candidateIds.has(p.id))
 let advice:PackAdvice|null=null
 const facts=view.products.filter(p=>p.title&&p.price!==null&&p.currency==='INR'&&p.price>=selection.min&&p.price<=selection.max&&p.observedAt&&Date.parse(p.observedAt)<=Date.now()&&Date.now()-Date.parse(p.observedAt)<=6*3600000&&p.match==='exact'&&matchingPhoto(p)&&photoReady(p)&&p.stock!=='out-of-stock'&&!p.failures.some(f=>f.startsWith('Revalidation failed:')))
 const additions=facts.filter(p=>eligible({...p,category:p.category||slot.category,subcategory:p.subcategory||slot.subcategory},{category:slot.category,subcategory:slot.subcategory,min:selection.min,max:selection.max,stores:selection.stores},view))
 if(!existing&&additions.length&&view.settings.ai?.provider!=='none'){
  this.state.job.message='Choosing from verified listing evidence...'
  if(!this.reasoning)throw new Error('Account reasoning unavailable. Collected products are saved. Choose Code only in Settings / Advanced to continue without AI.')
  view.products=facts;usedReasoning=true
  try{advice=await this.reasoning(view,slot,signal)}catch(e){signal.throwIfAborted();throw new Error('Account reasoning paused: '+message(e)+'. Collected products are saved. Choose Code only in Settings / Advanced to continue without AI.')}
 }
 signal.throwIfAborted()
 for(const p of view.products){const original=this.state.products.find(x=>x.id===p.id);if(original&&p.aiClassification){original.category=p.category;original.subcategory=p.subcategory;original.aiClassification=p.aiClassification}}
 // Existing partial packs keep their identity, theme, budget and photo/link numbering.
 let pack:ReadyPack|null=existing
 if(existing&&replacement){
  const index=existing.productIds.indexOf(replacement)
  const current=this.state.products.filter(p=>existing.productIds.includes(p.id)&&p.id!==replacement)
  const alternative=selectProducts(this.state.products.filter(p=>candidateIds.has(p.id)&&eligible(p,existing,this.state,new Set(existing.productIds))),30).find(p=>selectProducts([...current,p],current.length+1).length===current.length+1)
  if(index>=0&&alternative){const old=this.state.products.find(p=>p.id===replacement)!;old.state='skipped';alternative.state='drafted';alternative.lastUsedAt=new Date().toISOString();existing.productIds[index]=alternative.id;existing.state='drafted';existing.ai=undefined}
  else errors.push('No verified same-theme replacement found. Current result kept; no filters relaxed.')
 }else if(existing){
  const retained=existing.productIds.map(id=>this.state.products.find(p=>p.id===id)).filter((p):p is PackProduct=>!!p&&reviewable(p,existing))
  const available=this.state.products.filter(p=>candidateIds.has(p.id)&&eligible(p,existing,this.state,new Set(existing.productIds)))
  const selected=[...retained];for(const p of available){if(selected.length>=existing.requested)break;if(selectProducts([...selected,p],selected.length+1).length===selected.length+1)selected.push(p)}
  const keep=new Set(retained.map(p=>p.id))
  existing.productIds=selected.map(p=>p.id);existing.state='drafted';existing.reasons=[];existing.ai=undefined
  for(const p of selected){if(!keep.has(p.id))p.lastUsedAt=new Date().toISOString();p.state='drafted'}
 }else{
  const assembly=structuredClone(this.state);assembly.selection=selection;assembly.products=assembly.products.filter(p=>candidateIds.has(p.id));assembly.settings.size=selection.size;assembly.settings.categories=assembly.settings.categories.map(c=>c.id===category.id?category:c)
  const created=assemble(assembly,slot,advice?.selection.map(p=>p.id))
  if(created.productIds.length){pack=created;if(advice)pack.ai=advice;this.state.packs.push(pack);for(const id of pack.productIds){const p=this.state.products.find(p=>p.id===id)!;p.state='drafted';p.lastUsedAt=pack.createdAt}session.packId=pack.id}
 }
 const count=pack?.productIds.filter(id=>{const p=this.state.products.find(p=>p.id===id);return !!p&&reviewable(p,pack!)}).length??0;resultCount=count
 if(pack&&!count){pack.state='skipped';pack.reasons.push('No currently verified products; history retained. Theme remains available.');session.packId=null;pack=null}
 if(pack)pack.reasons.push(session.themeReason??'Editorial exploration; no measured trend claim.')
 if(pack&&count<selection.size)pack.reasons=[session.themeReason??'Editorial exploration; no measured trend claim.',`Partial result: ${count}/${selection.size}. Find more keeps these clothes, stores and budget.`,...errors]
 else if(pack)pack.reasons=[session.themeReason??'Editorial exploration; no measured trend claim.',...errors]
 const planned=this.state.plan.find(s=>s.id===slot.id);if(planned){planned.state=count>=selection.size?'drafted':'pending';if(count>=selection.size){planned.category=slot.category;planned.subcategory=slot.subcategory;planned.reason=slot.reason}}
 for(const provider of providers)if(provider.diagnostics)provider.diagnostics.counts.packCandidates=this.state.products.filter(p=>p.retailer===provider.status.id&&reviewable(p,{category:slot.category,subcategory:slot.subcategory,min:selection.min,max:selection.max,stores:selection.stores})).length
 for(const provider of providers){const reasons=[...new Set(provider.diagnostics?.rejections.map(r=>r.reason)??[])].slice(0,2);if(reasons.length)errors.push(provider.status.id+': '+reasons.join(' '))}
 session.messages=errors
 if(!count&&photoAccessFailed)this.state.actionableError={code:'source-blocked',message:'Listing photos could not be verified. Candidates and exact access errors are saved; category and budget were not changed to hide this source limitation.',action:'Review photo/source errors in Settings before an explicit recheck'}
 else if(!count&&!inventoryAccessible){this.state.actionableError={code:'source-blocked',message:'Configured sources did not provide readable product records. Their actual access errors are preserved; no theme was consumed. Review source status in Settings.',action:'Review source access in Settings'}}
 else if(!count)this.state.actionableError={code:'inventory',message:'Accessible sources returned no products meeting the exact theme, budget, freshness, photo and cooldown requirements.',action:'Retry this theme or customize saved preferences'}
 this.state.job={state:count||inventoryAccessible&&!photoAccessFailed?'idle':'error',message:count?`${count}/${selection.size} products found. ${count<selection.size?'Find more uses the same selection.':'Ready for review.'}`:!inventoryAccessible?'Product source setup required':'No verified products matched the saved theme and filters. No coverage consumed.',dueAt:new Date().toISOString(),attempts:0}
 }catch(e){if(/Account reasoning/.test(message(e)))this.state.actionableError={code:'account',message:message(e),action:'Review account status in Settings'};this.state.job={state:abort.signal.aborted?'cancelled':'error',message:abort.signal.aborted?'Search cancelled. Collected candidates kept; workers stopped.':message(e),dueAt:new Date().toISOString(),attempts:0};session.messages=errors}
 finally{await this.repository.save(this.state).catch(e=>{this.state.job.state='error';this.state.job.message='Could not save search: '+message(e)})}
 return {count:resultCount,canFallback:inventoryAccessible&&!signal.aborted&&this.state.job.state==='idle'&&!replacement&&resultCount===0&&!usedReasoning&&!photoAccessFailed}
 }
 async more(id?:string){await this.ready;if(!this.state.searchSession)throw new Error('Click Find my next post first.');if(id&&id!==this.state.searchSession.packId)throw new Error('Find more is available for the current selection only.');return this.find(this.state.searchSession.selection,true)}
 async review(id:string){await this.mutate(async()=>{
  const pack=this.pack(id)
  const stores=pack.stores??[...new Set(['meesho','flipkart','amazon','myntra','ajio',...this.state.products.filter(p=>pack.productIds.includes(p.id)).map(p=>p.retailer)])]
  const selection:FindSelection={category:pack.category,min:pack.min,max:pack.max,size:pack.requested,stores}
  const slot:PlanSlot={id:pack.slotId,week:1,day:1,category:pack.category,subcategory:pack.subcategory,variation:'Saved result',state:'pending',reason:''}
  this.state.selection=selection;this.state.searchSession={selection,slot,packId:pack.id,messages:[]}
 })}
 async done(id:string){await this.mutate(async()=>{const pack=this.pack(id);if(!['drafted','exported'].includes(pack.state))throw new Error('This result is already archived.');pack.state='done';const slot=this.state.plan.find(s=>s.id===pack.slotId);if(slot)slot.state='drafted';if(this.state.searchSession?.packId===id)this.state.searchSession=undefined})}
 async import(text:string){await this.mutate(async()=>this.merge(importProducts(text,this.state.settings.categories)))}
 async settings(value:unknown){await this.mutate(async()=>{this.state.settings=validateSettings(value);for(const slot of this.state.plan){const c=this.state.settings.categories.find(c=>c.id===slot.category);if(slot.state==='pending'||slot.state==='deferred'){slot.state=!c||c.deferred?'deferred':'pending';slot.reason=!c?'Category removed':c.deferred;if(c&&!c.subcategories.includes(slot.subcategory))slot.subcategory=c.subcategories[(slot.week-1)%c.subcategories.length]}}})}
 async replace(id:string,productId:string){
  let selection:FindSelection|undefined
  await this.mutate(async()=>{
   const pack=this.pack(id);if(!['drafted','exported'].includes(pack.state))throw new Error('Only unconsumed results can change.')
   const index=pack.productIds.indexOf(productId);if(index<0)throw new Error('Product not in result.')
   const alternatives=selectProducts(this.state.products.filter(p=>eligible(p,pack,this.state,new Set(pack.productIds))),30)
   const current=this.state.products.filter(p=>pack.productIds.includes(p.id)&&p.id!==productId)
   const chosen=alternatives.find(p=>selectProducts([...current,p],current.length+1).length===current.length+1)
   if(chosen){const old=this.state.products.find(p=>p.id===productId)!;old.state='skipped';chosen.state='drafted';chosen.lastUsedAt=new Date().toISOString();pack.productIds[index]=chosen.id;pack.state='drafted';pack.ai=undefined;pack.reasons.push('Replaced with a verified same-theme alternative. Earlier export is superseded.');return}
   selection={category:pack.category,min:pack.min,max:pack.max,size:pack.requested,stores:pack.stores??['meesho','flipkart','amazon','myntra','ajio']}
   const slot:PlanSlot={...(this.state.plan.find(s=>s.id===pack.slotId)??{id:pack.slotId,week:1,day:1,variation:'Replacement',state:'pending' as const,reason:''}),category:pack.category,subcategory:pack.subcategory}
   this.state.searchSession={selection,slot,packId:pack.id,messages:[]}
  })
  if(selection)await this.find(selection,true,productId)
 }
 async skip(id:string){await this.mutate(async()=>{const p=this.pack(id);if(p.state==='posted')throw new Error('Posted packs cannot be skipped.');p.state='skipped';const slot=this.state.plan.find(s=>s.id===p.slotId);if(slot)slot.state='skipped';if(this.state.searchSession?.packId===id)this.state.searchSession=undefined;p.productIds.forEach(id=>{this.state.products.find(p=>p.id===id)!.state='skipped'})})}
 async feedback(id:string,value:unknown,posted=false){await this.mutate(async()=>{const r=value as Performance;if(!r||typeof r.source!=='string'||!r.source.trim()||typeof r.window!=='string'||!r.window.trim()||!Number.isFinite(Date.parse(r.observedAt))||!Number.isFinite(Date.parse(r.publishedAt)))throw new Error('Provide publication date, metric source, observation time and time window.');if(r.postUrl){const url=new URL(publicHttps(r.postUrl));if(!/(^|\.)instagram\.com$/.test(url.hostname)||!/^\/(p|reel)\//.test(url.pathname))throw new Error('Use an Instagram post/reel URL.')}for(const key of ['reach','saves','shares','clicks','orders','commission'] as const)if(r[key]!==null&&(!Number.isFinite(r[key])||r[key]!<0))throw new Error('Metrics must be nonnegative numbers or null.');const p=this.pack(id);p.performance.push(structuredClone(r));if(posted){p.state='posted';p.productIds.forEach(id=>{this.state.products.find(p=>p.id===id)!.state='posted'})}})}
 async refresh(id:string){await this.mutate(async()=>{this.photoRequests.clear();await this.revalidate(this.pack(id))})}
 async revalidate(pack:ReadyPack){const providers=await this.providers();for(const id of pack.productIds){const p=this.state.products.find(p=>p.id===id)!;if(p.observedAt&&Date.parse(p.observedAt)<=Date.now()&&Date.now()-Date.parse(p.observedAt)<6*3600000&&matchingPhoto(p)&&photoReady(p)&&p.title&&p.price!==null&&p.currency==='INR'&&!p.failures.some(f=>f.startsWith('Revalidation failed:')))continue;try{const provider=providers.find(x=>x.status.id===p.retailer&&x.details&&sourceReady(x,this.state));if(!provider?.details)throw new Error('Listing refresh unavailable: source is unconfigured or paused. Review source status in Settings.');const next=await provider.details(p,AbortSignal.timeout(25000));classify(next,this.state.settings.categories);if(!next.category&&next.title===p.title&&p.aiClassification){next.category=p.aiClassification.category;next.subcategory=p.aiClassification.subcategory;next.aiClassification=p.aiClassification}await this.verifyPhoto(next,AbortSignal.timeout(20000));applyLicences(next,this.state.licences??[]);this.merge([next])}catch(e){p.failures.push('Revalidation failed: '+message(e));if(/HTTP (401|403|429)|challenge|captcha/i.test(message(e)))recordSource(this.state,p.retailer,message(e))}}}
}
