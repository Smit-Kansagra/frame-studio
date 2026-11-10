import { publicHttps } from './product-find-data.cjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { listing } from './product-find-research.cjs'
import type { ProductMarketplace } from './contracts.cjs'
import type { Category, CatalogueIdentity, FindSelection, PackProduct, PackSettings, PackStore, PlanSlot, ReadyPack } from './ready-packs-types.cjs'
export const findStores = ['meesho','flipkart','amazon','myntra','ajio','libas']
export const defaultFindSelection=():FindSelection=>({category:'auto',min:200,max:1000,size:5,stores:[],mode:'auto',storeMode:'auto'})
export function validateSelection(raw:unknown,settings:PackSettings):FindSelection {
 const s=raw as FindSelection
 if(!s||typeof s.category!=='string'||s.category!=='auto'&&!settings.categories.some(c=>c.id===s.category)||![4,5,6].includes(s.size)||!Number.isFinite(s.min)||!Number.isFinite(s.max)||s.min<0||s.max<s.min||s.max>10_000_000||!Array.isArray(s.stores)||s.storeMode!=='auto'&&!s.stores.length||s.stores.length>20||s.stores.some(id=>!findStores.includes(id)&&!/^catalogue:[a-z0-9-]{1,40}$/.test(id))||s.mode!==undefined&&!['auto','custom'].includes(s.mode)||s.storeMode!==undefined&&!['auto','manual'].includes(s.storeMode))throw new Error('Use a valid INR budget, 4–6 products and Auto stores or supported store overrides.')
 return {category:s.category,min:s.min,max:s.max,size:s.size,stores:[...new Set(s.stores)],mode:s.mode??'custom',storeMode:s.storeMode??'manual'}
}
export const families = [
 ['short kurtis','tops/T-shirts','casual co-ords','jeans','casual dresses'],
 ['long kurtis','kurta/suit sets','shirts/tunics','trousers/palazzos/cargos','skirts/shorts'],
 ['sarees','blouses','lehengas/ethnic skirts','festive gowns/Indo-western','party dresses'],
 ['jumpsuits/dungarees','blazers/jackets/shrugs','sweaters/cardigans/hoodies','activewear','nightwear/loungewear'],
]
const sixth=['maternity/nursing','modest clothing','innerwear/shapewear','swimwear/cover-ups']
export function defaultSettings():PackSettings {
 const categories=[...families.flat(),...sixth].map((name,i):Category=>({id:String(i),name,subcategories:name.split('/'),min:200,max:i>=10&&i<15?2500:1000,deferred:'',specialist:i>=20,autoEnabled:i<20}))
 categories.push({id:'leggings',name:'leggings',subcategories:['leggings'],min:200,max:1000,deferred:'',autoEnabled:true},{id:'dupattas',name:'dupattas',subcategories:['dupattas'],min:200,max:1000,deferred:'',autoEnabled:true})
 return {size:5,cooldownDays:30,season:'All seasons',occasion:'Everyday',attributes:'India; affordable women’s fashion',scheduled:false,categories,ai:{provider:'antigravity',model:'',effort:'medium'}}
}
export function makePlan(settings:PackSettings):PlanSlot[] {
 return Array.from({length:56},(_,i)=>{const week=Math.floor(i/7),day=i%7;const index=day<5?(week%4)*5+day:day===5?20+week%4:(week*3+1)%20;const c=settings.categories[index%settings.categories.length];return{id:`w${week+1}d${day+1}`,week:week+1,day:day+1,category:c.id,subcategory:c.subcategories[Math.floor(week/4)%c.subcategories.length],variation:week>=4?(c.subcategories.length>1?'Style variation: alternate subcategory; same budget':'Budget variation: maximum 20% lower; same subcategory'):'Baseline',state:c.deferred?'deferred':'pending',reason:c.deferred||(day===6?'Explore under-covered category; no repeated performance observations yet.':'')}})
}
export function emptyStore():PackStore {const settings=defaultSettings();return{version:1,settings,plan:makePlan(settings),products:[],packs:[],job:{state:'idle',message:'Ready. Click Find my next post; saved defaults will be used.',dueAt:new Date().toISOString(),attempts:0},providers:[]}}
export function planSeventhSlot(store:PackStore,slot:PlanSlot):void {
 if(slot.day!==7)return
 const groups=new Map<string,{category:string;sub:string;packs:Set<string>;rates:number[];comparable:string}>()
 for(const p of store.packs.filter(p=>p.state==='posted')){
  const observations=p.performance.filter(o=>o.reach!==null&&o.reach>0&&o.saves!==null)
  // Repeated observations must be independent dates; multiple edits are not repeated evidence.
  if(new Set(observations.map(o=>o.observedAt.slice(0,10))).size<2)continue
  const o=observations.at(-1)!;const key=[p.category,p.subcategory,o.source,o.window].join('|');const g=groups.get(key)??{category:p.category,sub:p.subcategory,packs:new Set<string>(),rates:[],comparable:o.source+'|'+o.window};g.packs.add(p.id);g.rates.push(o.saves!/o.reach!);groups.set(key,g)
 }
 const observed=[...groups.values()].filter(g=>g.packs.size>=2&&store.settings.categories.some(c=>c.id===g.category&&!c.deferred));const comparable=observed.find(g=>observed.filter(x=>x.comparable===g.comparable).length>=2)?.comparable;const supported=observed.filter(g=>g.comparable===comparable);supported.sort((a,b)=>b.rates.reduce((n,v)=>n+v,0)/b.rates.length-a.rates.reduce((n,v)=>n+v,0)/a.rates.length)
 if(supported.length>=2){const g=supported[0];slot.category=g.category;slot.subcategory=g.sub;slot.reason=`Repeat supported by ${g.packs.size} posted packs, repeated observations, and the highest comparable saves/reach among observed themes. Pack-level evidence only.`;return}
 const count=(id:string)=>store.packs.filter(p=>p.category===id&&p.productIds.length>0).length
 const c=[...store.settings.categories].filter(c=>!c.deferred).sort((a,b)=>count(a.id)-count(b.id))[0];if(!c)return
 slot.category=c.id;slot.subcategory=[...c.subcategories].sort((a,b)=>store.packs.filter(p=>p.category===c.id&&p.subcategory===a).length-store.packs.filter(p=>p.category===c.id&&p.subcategory===b).length)[0];slot.reason='Explore least-covered category/subcategory; insufficient repeated comparable performance evidence.'
}
export function canonical(raw:string,binding?:CatalogueIdentity):{url:string;retailer:string;retailerId:string;id:string} {
 if(binding){const u=new URL(publicHttps(raw)),listingUrl=new URL(publicHttps(binding.listingUrl));if(!/^catalogue:[a-z0-9-]{1,40}$/.test(binding.providerId)||!/^\d+$/.test(binding.productId)||new URL(publicHttps(binding.origin)).origin!==binding.origin||u.origin!==binding.origin||listingUrl.origin!==binding.origin||u.href!==listingUrl.href)throw new Error('Catalogue product URL is outside the observed listing identity.');return{url:u.href,retailer:binding.providerId,retailerId:binding.productId,id:createHash('sha256').update(binding.providerId+':'+binding.productId).digest('hex').slice(0,24)}}
 const ajio=new URL(publicHttps(raw));if(['ajio.com','www.ajio.com'].includes(ajio.hostname)&&/\/p\/[a-zA-Z0-9_-]+\/?$/.test(ajio.pathname)){const retailerId=ajio.pathname.match(/\/p\/([a-zA-Z0-9_-]+)/)![1];ajio.hostname='www.ajio.com';ajio.search='';ajio.hash='';return{url:ajio.href,retailer:'ajio',retailerId,id:createHash('sha256').update('ajio:'+retailerId).digest('hex').slice(0,24)}}
 const checked=new URL(publicHttps(raw));if(['www.libas.in','libas.in'].includes(checked.hostname)&&/^\/products\/[a-z0-9-]+$/.test(checked.pathname)){checked.hostname='www.libas.in';const variant=checked.searchParams.get('variant');if(variant&&!/^\d+$/.test(variant))throw new Error('Invalid variant ID.');checked.search=variant?'?variant='+variant:'';const retailerId=checked.pathname.split('/')[2];return{url:checked.href,retailer:'libas',retailerId,id:createHash('sha256').update('libas:'+retailerId).digest('hex').slice(0,24)}}
 for(const retailer of ['meesho','flipkart','myntra','amazon'] as ProductMarketplace[])try {const u=new URL(listing(raw,retailer));u.hostname=u.hostname.replace(/^(www|dl)\./,'');if(retailer==='flipkart')u.pathname=u.pathname.replace(/^\/dl\//,'/');const retailerId=retailer==='amazon'?u.pathname.split('/')[2]:retailer==='flipkart'?(u.searchParams.get('pid')??u.pathname.split('/p/')[1]):retailer==='myntra'?u.pathname.match(/\/(\d+)\/buy/)![1]:u.pathname.split('/p/')[1];return{url:u.href,retailer,retailerId,id:createHash('sha256').update(retailer+':'+retailerId).digest('hex').slice(0,24)}}catch{/* Try each supported retailer. */}
 throw new Error('Use a supported marketplace product detail URL.')
}
export function candidate(url:string,binding?:CatalogueIdentity):PackProduct {return{...canonical(url,binding),...binding?{catalogue:binding}:{},garmentId:'',title:'',category:'',subcategory:'',variant:'unknown',color:'',cut:'',price:null,currency:null,priceSource:'',observedAt:null,sizes:[],stock:'unknown',images:[],evidence:[],match:'unknown',failures:[],affiliateUrl:null,affiliateStatus:'unknown',state:'candidate',lastUsedAt:null,assessment:{fit:'Unclassified',demand:'No product-specific demand evidence',readiness:'Unverified'}}}
export function validateSettings(raw:unknown):PackSettings {
 const s=raw as PackSettings
 if(!s||![4,5,6].includes(s.size)||!Number.isInteger(s.cooldownDays)||s.cooldownDays<0||s.cooldownDays>365||typeof s.scheduled!=='boolean'||!Array.isArray(s.categories)||!s.categories.length||s.categories.length>60)throw new Error('Invalid pack settings.')
 for(const v of [s.season,s.occasion,s.attributes])if(typeof v!=='string'||v.length>300)throw new Error('Invalid audience preferences.')
 const ids=new Set<string>();for(const c of s.categories){if(!c||typeof c.id!=='string'||ids.has(c.id)||typeof c.name!=='string'||!c.name.trim()||c.name.length>120||!Array.isArray(c.subcategories)||!c.subcategories.length||c.subcategories.some(x=>typeof x!=='string'||!x.trim()||x.length>100)||!Number.isFinite(c.min)||!Number.isFinite(c.max)||c.min<0||c.max<c.min||typeof c.deferred!=='string'||c.deferred.length>300||c.specialist!==undefined&&typeof c.specialist!=='boolean'||c.autoEnabled!==undefined&&typeof c.autoEnabled!=='boolean')throw new Error('Invalid category or budget.');ids.add(c.id)}
 const savedAi=s.ai as any;const ai=!savedAi?{provider:'antigravity',model:'',effort:'medium'}:['ollama','local','hybrid'].includes(typeof savedAi==='string'?savedAi:savedAi.provider)?{provider:'antigravity',model:'',effort:'medium'}:savedAi;if(!['antigravity','none'].includes(ai.provider)||typeof ai.model!=='string'||ai.model.length>100||!['medium','high'].includes(ai.effort))throw new Error('Invalid account reasoning settings.');return {...structuredClone(s),ai:structuredClone(ai)}
}
export function matchingPhoto(p:PackProduct):boolean {
 return p.match==='exact'&&p.images.some(i=>{try{return i.variant===p.variant&&canonical(i.source,p.catalogue).id===p.id&&!!publicHttps(i.url)}catch{return false}})
}
export function photoReady(p:PackProduct,now=Date.now()):boolean {
 const o=p.photoObservation
 return !!o&&Number.isFinite(Date.parse(o.at))&&Date.parse(o.at)<=now&&now-Date.parse(o.at)<=6*3600000&&p.images.some(i=>i.url===o.url&&i.variant===p.variant)
}
export function reviewable(p:PackProduct,pack:Pick<ReadyPack,'category'|'subcategory'|'min'|'max'|'stores'>,now=Date.now()):boolean {
 try{if(canonical(p.url,p.catalogue).id!==p.id)return false}catch{return false}
 return (!pack.stores||pack.stores.includes(p.retailer))&&!/\b(men|boys|boy)\b/i.test(p.title)&&p.category===pack.category&&p.subcategory===pack.subcategory&&!!p.title.trim()&&matchingPhoto(p)&&photoReady(p,now)&&!!p.observedAt&&Number.isFinite(Date.parse(p.observedAt))&&Date.parse(p.observedAt)<=now&&now-Date.parse(p.observedAt)<=6*3600000&&p.price!==null&&p.currency==='INR'&&p.price>=pack.min&&p.price<=pack.max&&p.stock!=='out-of-stock'&&!p.failures.some(f=>f.startsWith('Revalidation failed:')||f.startsWith('Photo verification failed:')||f==='Listing reports not purchasable.')
}
export function eligible(p:PackProduct,pack:Pick<ReadyPack,'category'|'subcategory'|'min'|'max'|'stores'>,store:PackStore,exclude=new Set<string>(),now=Date.now()):boolean {
 const attributes=store.settings.attributes.toLowerCase();const required=['plus-size','petite','tall'].filter(a=>attributes.includes(a));const attributeFit=required.every(a=>p.title.toLowerCase().includes(a)||a==='plus-size'&&/\b(plus size|[2-9]xl|xxxl)\b/i.test(p.title+' '+p.sizes.join(' ')))
 const family=[p,...store.products.filter(x=>x.id!==p.id&&p.garmentId&&x.retailer===p.retailer&&x.garmentId===p.garmentId)]
 return reviewable(p,pack,now)&&attributeFit&&!exclude.has(p.id)&&!family.some(x=>x.lastUsedAt&&(!Number.isFinite(Date.parse(x.lastUsedAt))||now-Date.parse(x.lastUsedAt)<store.settings.cooldownDays*86400000))&&!store.packs.some(x=>['drafted','exported'].includes(x.state)&&family.some(member=>x.productIds.includes(member.id)))
}
export function selectProducts(pool:PackProduct[],count:number):PackProduct[] {
 const result:PackProduct[]=[];const ids=new Set<string>(),garments=new Set<string>(),photos=new Set<string>(),titles=new Set<string>()
 const sorted=[...pool].sort((a,b)=>Number(b.stock==='in-stock')-Number(a.stock==='in-stock')||b.images.length-a.images.length)
 while(result.length<count&&sorted.length){sorted.sort((a,b)=>Number(result.some(p=>p.color===a.color&&p.cut===a.cut))-Number(result.some(p=>p.color===b.color&&p.cut===b.cut)));const p=sorted.shift()!;const title=p.title.toLowerCase().replace(/\b(xs|s|m|l|xl|xxl|size|\d+)\b/g,'').replace(/\W/g,'');if(ids.has(p.id)||p.garmentId&&garments.has(p.retailer+':'+p.garmentId)||titles.has(title)||p.images.some(i=>photos.has(i.url)))continue;result.push(p);ids.add(p.id);if(p.garmentId)garments.add(p.retailer+':'+p.garmentId);titles.add(title);p.images.forEach(i=>photos.add(i.url))}
 return result
}
export function assemble(store:PackStore,slot:PlanSlot,preferredIds?:string[]):ReadyPack {
 const c=store.settings.categories.find(c=>c.id===slot.category)!;const pack:ReadyPack={id:randomUUID(),slotId:slot.id,theme:slot.subcategory,category:c.id,subcategory:slot.subcategory,min:store.selection?.min??c.min,max:store.selection?.max??c.max,requested:store.selection?.size??store.settings.size,stores:store.selection?.stores,productIds:[],state:'drafted',createdAt:new Date().toISOString(),reasons:[],performance:[],references:[]}
 const qualified=store.products.filter(p=>eligible(p,pack,store));const preferred=preferredIds?.map(id=>qualified.find(p=>p.id===id));if(preferred&&(preferred.some(p=>!p)||preferred.length>pack.requested||selectProducts(preferred as PackProduct[],preferred.length).length!==preferred.length))throw new Error('AI selection failed pack invariants.');const chosen=preferred?preferred as PackProduct[]:selectProducts(qualified,pack.requested);pack.productIds=chosen.map(p=>p.id)
 pack.theme=`${slot.subcategory} | INR ${pack.min}-${pack.max} | ${store.settings.occasion}`;pack.reasons.push(slot.variation)
 if(chosen.length<pack.requested)pack.reasons.push(`Incomplete: ${chosen.length}/${pack.requested}. Only exact-category listings with observed INR prices inside budget qualify; duplicates, cooldown and active packs excluded.`)
 if(chosen.some(p=>p.stock==='unknown'))pack.reasons.push('Stock unknown for some products; check original listings.')
 if(chosen.some(p=>!p.images.length||p.images.some(i=>i.permission!=='permitted')))pack.reasons.push('Some images are missing or lack export permission. These products are not export-ready.')
 if(!chosen.length)return pack
 for(const p of chosen){p.state='drafted';p.lastUsedAt=pack.createdAt}if(chosen.length>=pack.requested)slot.state='drafted';store.packs.push(pack);return pack
}
export class PackRepository {
 constructor(readonly folder:string){}
 async load():Promise<PackStore>{
  const file=path.join(this.folder,'ready-packs-v1.json');let text:string
  try{text=await readFile(file,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{...emptyStore(),workflowVersion:3,preferences:defaultFindSelection(),catalogues:[],sourceHealth:{}};throw e}
  if(text.length>20_000_000)throw new Error('Pack data exceeds limit.')
  const s=JSON.parse(text) as PackStore
  if(s.version!==1||s.workflowVersion!==undefined&&s.workflowVersion!==2&&s.workflowVersion!==3)throw new Error('Unsupported pack schema; existing data preserved.')
  s.settings=validateSettings(s.settings)
  if(!Array.isArray(s.plan)||!Array.isArray(s.products)||!Array.isArray(s.packs))throw new Error('Invalid pack data; existing data preserved.')
  let changed=false
  if(s.workflowVersion===undefined){
   await copyFile(file,file+'.before-simple-find.bak',1).catch(e=>{if(e.code!=='EEXIST')throw e})
   s.workflowVersion=2;changed=true
   for(const p of s.packs.filter(p=>['drafted','exported'].includes(p.state)&&p.productIds.length<p.requested)){
    if(!p.productIds.length){p.state='skipped';p.reasons.push('Empty legacy result archived; no history deleted. Theme reopened.')}
    const slot=s.plan.find(x=>x.id===p.slotId)
    if(slot&&!s.packs.some(x=>x.id!==p.id&&x.slotId===slot.id&&x.productIds.length>=x.requested&&x.state!=='skipped'))slot.state='pending'
   }
   const current=s.packs.filter(p=>p.productIds.length&&['drafted','exported'].includes(p.state)).at(-1)
   if(current&&!s.searchSession){
    const stores=current.stores??[...new Set(['meesho','flipkart','amazon','myntra','ajio',...s.products.filter(p=>current.productIds.includes(p.id)).map(p=>p.retailer)])].filter(id=>findStores.includes(id))
    const selection:FindSelection={category:current.category,min:current.min,max:current.max,size:current.requested,stores}
    const slot=s.plan.find(x=>x.id===current.slotId)??{id:current.slotId,category:current.category,subcategory:current.subcategory,week:1,day:1,variation:'Saved result',state:'pending' as const,reason:''}
    current.stores=stores;s.selection??=selection;s.searchSession={selection,slot:structuredClone(slot),packId:current.id,messages:[]}
   }
  }
  if(s.workflowVersion!==3){
   await copyFile(file,file+'.before-auto-find.bak',1).catch(e=>{if(e.code!=='EEXIST')throw e})
   s.preferences??={...defaultFindSelection(),min:s.selection?.min??200,max:s.selection?.max??1000,size:s.selection?.size??s.settings.size}
   for(const c of s.settings.categories){c.specialist??=/maternity|nursing|modest|innerwear|shapewear|swimwear|cover-ups/i.test(c.name);c.autoEnabled??=!c.specialist}
   for(const name of ['leggings','dupattas'])if(!s.settings.categories.some(c=>c.subcategories.includes(name)))s.settings.categories.push({id:name,name,subcategories:[name],min:200,max:1000,deferred:'',autoEnabled:true})
   s.catalogues??=[];s.sourceHealth??={};s.workflowVersion=3;changed=true
  }
  if(s.job.state==='running'){s.job.state='idle';s.job.message='Interrupted search recovered. Your selection and candidates are kept; no background search started.';changed=true}
  if(changed)await this.save(s)
  return s
 }
 async save(s:PackStore):Promise<void>{await mkdir(this.folder,{recursive:true});const file=path.join(this.folder,'ready-packs-v1.json');try{await copyFile(file,file+'.bak')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}await writeFile(file+'.tmp',JSON.stringify(s,null,2));await rename(file+'.tmp',file)}
}
