import { eligible, selectProducts, planSeventhSlot } from './ready-packs-core.cjs'
import type { Category, FindSelection, PackStore, PlanSlot } from './ready-packs-types.cjs'

export function autoCategory(c:Category,season:string):boolean {
 if(c.deferred||c.autoEnabled===false||c.specialist&&c.autoEnabled!==true)return false
 // India has varied climates; only explicit saved preferences justify seasonal exclusions.
 return !(/summer/i.test(season)&&/sweater|winter|cardigan|hoodie/i.test(c.name))
}
export function ensureCoverage(store:PackStore):void {
 const enabled=store.settings.categories.filter(c=>autoCategory(c,store.settings.season))
 if(!enabled.length)return
 const available=store.plan.filter(s=>s.state==='pending'&&enabled.some(c=>c.id===s.category&&c.subcategories.includes(s.subcategory)))
 let week=Math.max(0,...store.plan.map(s=>s.week))
 if(!available.length){
  const cycle=week+1
  for(let i=0;i<56;i++){
   const c=enabled[i%enabled.length]
   store.plan.push({id:`auto-${cycle}-${i}`,week:cycle+Math.floor(i/7),day:i%7+1,category:c.id,subcategory:c.subcategories[Math.floor(i/enabled.length)%c.subcategories.length],variation:'Editorial exploration; saved budget unchanged',state:'pending',reason:'Continuing coverage; previous history retained.'})
  }
  week=cycle+7
 }
 // Add newly enabled families without replacing old plan slots or resetting history.
 for(const c of enabled)if(!store.plan.some(s=>s.state==='pending'&&s.category===c.id))store.plan.push({id:`coverage-${week+1}-${c.id}-${store.plan.length}`,week:week+1,day:1,category:c.id,subcategory:c.subcategories[0],variation:'Editorial exploration',state:'pending',reason:'Family added to automatic coverage.'})
}
export function nextThemes(store:PackStore,selection:FindSelection):{slot:PlanSlot;reason:string}[] {
 ensureCoverage(store)
 let slots=store.plan.filter(s=>s.state==='pending'&&store.settings.categories.some(c=>c.id===s.category&&c.subcategories.includes(s.subcategory)&&(selection.category==='auto'?autoCategory(c,store.settings.season):!c.deferred&&c.id===selection.category)))
 if(selection.category!=='auto'&&!slots.length){const c=store.settings.categories.find(c=>c.id===selection.category);if(c&&!c.deferred)slots=[{id:'manual-'+c.id+'-'+store.packs.length,week:Math.max(1,...store.plan.map(s=>s.week)),day:1,category:c.id,subcategory:[...c.subcategories].sort((a,b)=>store.packs.filter(p=>p.productIds.length&&p.category===c.id&&p.subcategory===a).length-store.packs.filter(p=>p.productIds.length&&p.category===c.id&&p.subcategory===b).length)[0],variation:'Manual category; saved budget unchanged',state:'pending',reason:'Manual category override.'}]}
 const history=store.packs.filter(p=>p.productIds.length),recent=history.slice(-3)
 const scored=slots.map((original,index)=>{
  const slot=structuredClone(original)
  if(selection.category==='auto'&&slot.day===7){planSeventhSlot(store,slot);if(!store.settings.categories.some(c=>c.id===slot.category&&autoCategory(c,store.settings.season)))Object.assign(slot,original)}
  const inventory=selectProducts(store.products.filter(p=>eligible(p,{category:slot.category,subcategory:slot.subcategory,min:selection.min,max:selection.max,stores:selection.stores},store)),selection.size).length
  const coverage=history.filter(p=>p.category===slot.category&&p.subcategory===slot.subcategory).length
  const repetition=recent.filter(p=>p.category===slot.category).length
  const score=(inventory>=selection.size?200:inventory*20)-coverage*4-repetition*12-index/1000
  const reason=slot.reason.startsWith('Repeat supported by')?slot.reason:inventory?`Editorial exploration with ${inventory} currently verified saved matches; saved budget and cooldown applied. No trend or sales claim.`:'Editorial exploration to broaden clothing coverage and avoid recent repeats. No measured demand claim.'
  return{slot,score,reason}
 }).sort((a,b)=>b.score-a.score)
 const result:typeof scored=[]
 for(const row of scored){if(!result.some(p=>p.slot.category===row.slot.category&&p.slot.subcategory===row.slot.subcategory))result.push(row);if(result.length>=(selection.category==='auto'?2:1))break}
 return result.map(({slot,reason})=>({slot,reason}))
}

export function themeQueries(slot:PlanSlot,season:string,occasion:string):string[] {
 const aliases:Record<string,string>={'short kurtis':'short kurti','long kurtis':'long kurta','T-shirts':'tshirt','casual co-ords':'co ord set','casual dresses':'casual dress','suit sets':'suit set','shirts':'women shirt','tunics':'women tunic','trousers':'women trouser','palazzos':'palazzo','leggings':'women leggings','dupattas':'dupatta','nightwear':'women nightdress','loungewear':'women lounge set'}
 const suffix=[season==='All seasons'?'':season,occasion==='Everyday'?'':occasion].filter(Boolean).join(' ')
 const first=[slot.subcategory,suffix].filter(Boolean).join(' ')
 const second=[aliases[slot.subcategory]??'women '+slot.subcategory,suffix].filter(Boolean).join(' ')
 return [...new Set([first,second])].slice(0,2)
}
