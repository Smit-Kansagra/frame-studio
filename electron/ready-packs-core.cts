import { publicHttps } from './product-find-data.cjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { listing } from './product-find-research.cjs'
import type { ProductMarketplace } from './contracts.cjs'
import type { Category, PackProduct, PackSettings, PackStore, PlanSlot, ReadyPack } from './ready-packs-types.cjs'
export const families = [
 ['short kurtis','tops/T-shirts','casual co-ords','jeans','casual dresses'],
 ['long kurtis','kurta/suit sets','shirts/tunics','trousers/palazzos/cargos','skirts/shorts'],
 ['sarees','blouses','lehengas/ethnic skirts','festive gowns/Indo-western','party dresses'],
 ['jumpsuits/dungarees','blazers/jackets/shrugs','sweaters/cardigans/hoodies','activewear','nightwear/loungewear'],
]
const sixth=['maternity/nursing','modest clothing','innerwear/shapewear','swimwear/cover-ups']
export function defaultSettings():PackSettings {
 const categories=[...families.flat(),...sixth].map((name,i):Category=>({id:String(i),name,subcategories:name.split('/'),min:200,max:i>=10&&i<15?2500:1000,deferred:''}))
 return {size:5,cooldownDays:30,season:'All seasons',occasion:'Everyday',attributes:'India; affordable women’s fashion',scheduled:true,categories,ai:{provider:'antigravity',model:'',effort:'medium'}}
}
export function makePlan(settings:PackSettings):PlanSlot[] {
 return Array.from({length:56},(_,i)=>{const week=Math.floor(i/7),day=i%7;const index=day<5?(week%4)*5+day:day===5?20+week%4:(week*3+1)%20;const c=settings.categories[index%settings.categories.length];return{id:`w${week+1}d${day+1}`,week:week+1,day:day+1,category:c.id,subcategory:c.subcategories[Math.floor(week/4)%c.subcategories.length],variation:week>=4?(c.subcategories.length>1?'Style variation: alternate subcategory; same budget':'Budget variation: maximum 20% lower; same subcategory'):'Baseline',state:c.deferred?'deferred':'pending',reason:c.deferred||(day===6?'Explore under-covered category; no repeated performance observations yet.':'')}})
}
export function emptyStore():PackStore {const settings=defaultSettings();return{version:1,settings,plan:makePlan(settings),products:[],packs:[],job:{state:'idle',message:'Ready. Configure a source or import product records.',dueAt:new Date().toISOString(),attempts:0},providers:[]}}
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
export function canonical(raw:string):{url:string;retailer:string;retailerId:string;id:string} {
 const checked=new URL(publicHttps(raw));if(['www.libas.in','libas.in'].includes(checked.hostname)&&/^\/products\/[a-z0-9-]+$/.test(checked.pathname)){checked.hostname='www.libas.in';const variant=checked.searchParams.get('variant');if(variant&&!/^\d+$/.test(variant))throw new Error('Invalid variant ID.');checked.search=variant?'?variant='+variant:'';const retailerId=checked.pathname.split('/')[2];return{url:checked.href,retailer:'libas',retailerId,id:createHash('sha256').update('libas:'+retailerId).digest('hex').slice(0,24)}}
 for(const retailer of ['meesho','flipkart','myntra','amazon'] as ProductMarketplace[])try {const u=new URL(listing(raw,retailer));u.hostname=u.hostname.replace(/^(www|dl)\./,'');if(retailer==='flipkart')u.pathname=u.pathname.replace(/^\/dl\//,'/');const retailerId=retailer==='amazon'?u.pathname.split('/')[2]:retailer==='flipkart'?(u.searchParams.get('pid')??u.pathname.split('/p/')[1]):retailer==='myntra'?u.pathname.match(/\/(\d+)\/buy/)![1]:u.pathname.split('/p/')[1];return{url:u.href,retailer,retailerId,id:createHash('sha256').update(retailer+':'+retailerId).digest('hex').slice(0,24)}}catch{/* Try each supported retailer. */}
 throw new Error('Use a supported marketplace product detail URL.')
}
export function candidate(url:string):PackProduct {return{...canonical(url),garmentId:'',title:'',category:'',subcategory:'',variant:'unknown',color:'',cut:'',price:null,currency:null,priceSource:'',observedAt:null,sizes:[],stock:'unknown',images:[],evidence:[],match:'unknown',failures:[],affiliateUrl:null,affiliateStatus:'unknown',state:'candidate',lastUsedAt:null,assessment:{fit:'Unclassified',demand:'No product-specific demand evidence',readiness:'Unverified'}}}
export function validateSettings(raw:unknown):PackSettings {
 const s=raw as PackSettings
 if(!s||![4,5,6].includes(s.size)||!Number.isInteger(s.cooldownDays)||s.cooldownDays<0||s.cooldownDays>365||typeof s.scheduled!=='boolean'||!Array.isArray(s.categories)||!s.categories.length||s.categories.length>60)throw new Error('Invalid pack settings.')
 for(const v of [s.season,s.occasion,s.attributes])if(typeof v!=='string'||v.length>300)throw new Error('Invalid audience preferences.')
 const ids=new Set<string>();for(const c of s.categories){if(!c||typeof c.id!=='string'||ids.has(c.id)||typeof c.name!=='string'||!c.name.trim()||c.name.length>120||!Array.isArray(c.subcategories)||!c.subcategories.length||c.subcategories.some(x=>typeof x!=='string'||!x.trim()||x.length>100)||!Number.isFinite(c.min)||!Number.isFinite(c.max)||c.min<0||c.max<c.min||typeof c.deferred!=='string'||c.deferred.length>300)throw new Error('Invalid category or budget.');ids.add(c.id)}
 const savedAi=s.ai as any;const ai=!savedAi?{provider:'antigravity',model:'',effort:'medium'}:['ollama','local','hybrid'].includes(typeof savedAi==='string'?savedAi:savedAi.provider)?{provider:'antigravity',model:'',effort:'medium'}:savedAi;if(!['antigravity','none'].includes(ai.provider)||typeof ai.model!=='string'||ai.model.length>100||!['medium','high'].includes(ai.effort))throw new Error('Invalid account reasoning settings.');return {...structuredClone(s),ai:structuredClone(ai)}
}
export function eligible(p:PackProduct,pack:Pick<ReadyPack,'category'|'subcategory'|'min'|'max'>,store:PackStore,exclude=new Set<string>(),now=Date.now()):boolean {
 const attributes=store.settings.attributes.toLowerCase();const required=['plus-size','petite','tall'].filter(a=>attributes.includes(a));const attributeFit=required.every(a=>p.title.toLowerCase().includes(a)||a==='plus-size'&&/\b(plus size|[2-9]xl|xxxl)\b/i.test(p.title+' '+p.sizes.join(' ')))
 return !/\b(men|boys|boy)\b/i.test(p.title)&&attributeFit&&!exclude.has(p.id)&&p.category===pack.category&&p.subcategory===pack.subcategory&&!!p.title&&p.match==='exact'&&!!p.observedAt&&Number.isFinite(Date.parse(p.observedAt))&&Date.parse(p.observedAt)<=now&&now-Date.parse(p.observedAt)<=6*3600000&&p.price!==null&&p.currency==='INR'&&p.price>=pack.min&&p.price<=pack.max&&p.stock!=='out-of-stock'&&(!p.lastUsedAt||now-Date.parse(p.lastUsedAt)>=store.settings.cooldownDays*86400000)&&!store.packs.some(x=>['drafted','exported'].includes(x.state)&&x.productIds.includes(p.id))
}
export function selectProducts(pool:PackProduct[],count:number):PackProduct[] {
 const result:PackProduct[]=[];const ids=new Set<string>(),garments=new Set<string>(),photos=new Set<string>(),titles=new Set<string>()
 const sorted=[...pool].sort((a,b)=>Number(b.stock==='in-stock')-Number(a.stock==='in-stock')||b.images.length-a.images.length)
 while(result.length<count&&sorted.length){sorted.sort((a,b)=>Number(result.some(p=>p.color===a.color&&p.cut===a.cut))-Number(result.some(p=>p.color===b.color&&p.cut===b.cut)));const p=sorted.shift()!;const title=p.title.toLowerCase().replace(/\b(xs|s|m|l|xl|xxl|size|\d+)\b/g,'').replace(/\W/g,'');if(ids.has(p.id)||p.garmentId&&garments.has(p.retailer+':'+p.garmentId)||titles.has(title)||p.images.some(i=>photos.has(i.url)))continue;result.push(p);ids.add(p.id);if(p.garmentId)garments.add(p.retailer+':'+p.garmentId);titles.add(title);p.images.forEach(i=>photos.add(i.url))}
 return result
}
export function assemble(store:PackStore,slot:PlanSlot,preferredIds?:string[]):ReadyPack {
 const c=store.settings.categories.find(c=>c.id===slot.category)!;const pack:ReadyPack={id:randomUUID(),slotId:slot.id,theme:`${slot.subcategory} · ₹${c.min}–${c.max} · ${store.settings.occasion}`,category:c.id,subcategory:slot.subcategory,min:c.min,max:slot.variation.startsWith('Budget variation:')?Math.max(c.min,Math.floor(c.max*0.8)):c.max,requested:store.settings.size,productIds:[],state:'drafted',createdAt:new Date().toISOString(),reasons:[],performance:[],references:[]}
 const qualified=store.products.filter(p=>eligible(p,pack,store));const preferred=preferredIds?.map(id=>qualified.find(p=>p.id===id));if(preferred&&(preferred.some(p=>!p)||preferred.length>pack.requested||selectProducts(preferred as PackProduct[],preferred.length).length!==preferred.length))throw new Error('AI selection failed pack invariants.');const chosen=preferred?preferred as PackProduct[]:selectProducts(qualified,pack.requested);pack.productIds=chosen.map(p=>p.id)
 pack.theme=`${slot.subcategory} | INR ${pack.min}-${pack.max} | ${store.settings.occasion}`;pack.reasons.push(slot.variation)
 if(chosen.length<pack.requested)pack.reasons.push(`Incomplete: ${chosen.length}/${pack.requested}. Only exact-category listings with observed INR prices inside budget qualify; duplicates, cooldown and active packs excluded.`)
 if(chosen.some(p=>p.stock==='unknown'))pack.reasons.push('Stock unknown for some products; check original listings.')
 if(chosen.some(p=>!p.images.length||p.images.some(i=>i.permission!=='permitted')))pack.reasons.push('Some images are missing or lack export permission. These products are not export-ready.')
 for(const p of chosen){p.state='drafted';p.lastUsedAt=pack.createdAt}slot.state='drafted';store.packs.push(pack);return pack
}
export class PackRepository {
 constructor(readonly folder:string){}
 async load():Promise<PackStore>{const file=path.join(this.folder,'ready-packs-v1.json');try{const text=await readFile(file,'utf8');if(text.length>20_000_000)throw new Error('Pack data exceeds limit.');const s=JSON.parse(text) as PackStore;if(s.version!==1)throw new Error('Unsupported pack schema; existing data preserved.');s.settings=validateSettings(s.settings);if(!Array.isArray(s.plan)||!Array.isArray(s.products)||!Array.isArray(s.packs))throw new Error('Invalid pack data.');if(s.job.state==='running'){s.job.state='idle';s.job.message='Interrupted job recovered; saved slots prevent duplicate packs.'}return s}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return emptyStore();throw e}}
 async save(s:PackStore):Promise<void>{await mkdir(this.folder,{recursive:true});const file=path.join(this.folder,'ready-packs-v1.json');try{await copyFile(file,file+'.bak')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}await writeFile(file+'.tmp',JSON.stringify(s,null,2));await rename(file+'.tmp',file)}
}
