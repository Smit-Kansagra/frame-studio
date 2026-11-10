import { bytes, publicTarget } from './product-network.cjs'
import { filterShortlist } from './product-shortlist.cjs'
import { app, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { publicHttps } from './product-find-data.cjs'
import { listing } from './product-find-research.cjs'
import { allowDiscoveryImages } from './product-find.cjs'
import type { DiscoverySettings, DiscoveryProduct, DiscoveryState, ProductFindJob, ProductMarketplace } from './contracts.cjs'
const roots: Record<ProductMarketplace,string> = { myntra:'myntra.com', meesho:'meesho.com', flipkart:'flipkart.com', amazon:'amazon.in' }
const defaults: DiscoverySettings = { youtubeKey:'', geminiKey:'', ai:'antigravity', model:'', channels:'', pages:[] }
function searchTerms(query:string,platforms:ProductMarketplace[]):string {
  const words=query.toLowerCase().replace(/\b(asthetic|asthetic|aesthatic)\b/g,'aesthetic').replace(/\bwoman\b/g,'women').replace(/\b(find|give|show|please|products?|photos?|links?|for|me)\b/g,' ').replace(/\b\d+\b/g,' ').replace(/\s+/g,' ').trim()
  return (words+' '+platforms.join(' ')+' haul').trim()
}
const shortHosts=['fkrt.cc','fkrt.it','dl.flipkart.com','amzn.in','amzn.to','myntr.it','myntr.in','bit.ly','tinyurl.com','wishlink.com','ekaro.in','cuelinks.com']
function directListing(raw:string,platforms:ProductMarketplace[]):string|null {
  for(const platform of platforms)try{return listing(raw,platform)}catch{/* Try another selected marketplace. */}
  return null
}
async function resolveListing(raw:string,platforms:ProductMarketplace[],signal:AbortSignal):Promise<string|null> {
  let url=raw
  for(let hop=0;hop<7;hop++){
    signal.throwIfAborted()
    const direct=directListing(url,platforms);if(direct)return direct
    const response=await fetch(await publicTarget(url),{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])})
    const location=response.headers.get('location');await response.body?.cancel()
    if(response.status>=300&&response.status<400&&location){url=new URL(location,url).href;continue}
    return null
  }
  return null
}
function decode(s:string):string {return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')}
function imageFromHtml(html:string):string {
  for(const tag of html.match(/<meta\s[^>]*>/gi)??[]) {
    const attrs:Record<string,string>={}
    for(const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g))attrs[match[1].toLowerCase()]=decode(match[3])
    if(['og:image','og:image:secure_url','twitter:image'].includes(attrs.property??attrs.name))try{return publicHttps(attrs.content)}catch{/* Try another image. */}
  }
  throw new Error('No original product image exposed by retailer.')
}
function validate(value:unknown):DiscoverySettings {
  const raw=value as DiscoverySettings;const s=raw?{...raw,ai:['ollama','hybrid','gemini'].includes(raw.ai)?'antigravity':raw.ai,model:raw.ai==='none'?'':raw.ai==='antigravity'?raw.model:''} as DiscoverySettings:raw
  if(!s || !['none','ollama','antigravity','hybrid'].includes(s.ai)||typeof s.model!=='string'||s.model.length>100||!/^[-a-zA-Z0-9_.:]*$/.test(s.model)||typeof s.channels!=='string'||s.channels.length>3000||!Array.isArray(s.pages)||s.pages.length>30)throw new Error('Invalid discovery settings.')

  const channels=s.channels.split(/[\s,]+/).filter(Boolean)
  if(channels.length>10||channels.some(c=>!/^UC[\w-]{22}$/.test(c)))throw new Error('Use up to 10 YouTube channel IDs, one per line (UC...).')
  const ids=new Set<string>()
  for(const p of s.pages){if(!p||typeof p.id!=='string'||!/^[\w-]{1,80}$/.test(p.id)||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>100||typeof p.query!=='string'||!p.query.trim()||p.query.length>200||![7,14].includes(p.lookbackDays)||typeof p.autoRefresh!=='boolean'||!Array.isArray(p.platforms)||!p.platforms.length||p.platforms.some(x=>!Object.hasOwn(roots,x)))throw new Error('Every page needs a name, niche, and marketplace.');ids.add(p.id)}
  for(const key of [s.youtubeKey,s.geminiKey])if(typeof key!=='string'||key.length>500)throw new Error('Invalid API key.')
  return {...s,channels:channels.join('\n'),pages:s.pages.map(p=>({...p,platforms:[...new Set(p.platforms)]}))}
}
export function registerDiscovery(folder:string,authorized:(e:IpcMainInvokeEvent)=>boolean) {
  let settings=structuredClone(defaults), products:DiscoveryProduct[]=[], nextRunAt:string|null=null
  let job:ProductFindJob={state:'idle',message:'Add a page and configure a YouTube Data API key.',startedAt:null}
  let controller:AbortController|null=null, mutating=false, persisting=Promise.resolve()
  const file=path.join(folder,'library.json'),secrets=path.join(folder,'keys.bin')
  const ready=(async()=>{try{const data=JSON.parse(await readFile(file,'utf8'));if(['ollama','hybrid','gemini'].includes(data.settings.ai))await copyFile(file,file+'.before-account-ai.bak',1).catch(e=>{if(e.code!=='EEXIST')throw e});settings=validate({...data.settings,youtubeKey:'',geminiKey:''});products=data.products;nextRunAt=data.nextRunAt??null;if(!Array.isArray(products)||products.length>3000)throw new Error('Invalid product library.');for(const p of products){publicHttps(p.product_url);publicHttps(p.image_url)}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Product library could not be loaded. Existing data was preserved.')}
    try{const keys=JSON.parse(safeStorage.decryptString(await readFile(secrets)));settings.youtubeKey=keys.youtubeKey??'';settings.geminiKey=''}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')job.message='Saved API keys could not be unlocked. Enter them again.'}
  })();void ready.catch(e=>{job={...job,state:'error',message:e.message}})
  const persist=()=>{const snapshot=JSON.stringify({settings:{...settings,youtubeKey:'',geminiKey:''},products,nextRunAt});const operation=persisting.then(async()=>{await mkdir(folder,{recursive:true});await writeFile(file+'.tmp',snapshot);await rename(file+'.tmp',file)});persisting=operation.catch(()=>{});return operation}
  async function api(endpoint:string,params:Record<string,string>,signal:AbortSignal) {
    const url=new URL('https://www.googleapis.com/youtube/v3/'+endpoint);for(const[k,v]of Object.entries({...params,key:settings.youtubeKey}))url.searchParams.set(k,v)
    const r=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});if(!r.ok)throw new Error(`YouTube API HTTP ${r.status}. Check key, enabled Data API and quota.`);return await r.json()
  }
  async function start(id:string) {
    await ready;if(controller||mutating)throw new Error('A discovery job or settings save is already running.')
    const page=settings.pages.find(p=>p.id===id);if(!page)throw new Error('Save this page first.');if(!settings.youtubeKey)throw new Error('Add a YouTube Data API key. Gemini Plus login is not an API key.')
    const abort=new AbortController();controller=abort;job={state:'running',message:`Collecting recent YouTube evidence for ${page.name}...`,startedAt:new Date().toISOString()}
    void (async()=>{
      const signal=abort.signal, cutoff=new Date(Date.now()-page.lookbackDays*86400000).toISOString()
      const diagnostics={searchQuery:searchTerms(page.query,page.platforms),videos:0,links:0,shortLinks:0,resolved:0,unresolved:0,candidates:0,afterAI:0,photos:0,unavailable:0}
      const channels=settings.channels.split('\n').filter(Boolean);const ids=new Set<string>()
      for(const channel of channels.length?channels:['']){const result=await api('search',{part:'snippet',type:'video',q:diagnostics.searchQuery,order:'relevance',maxResults:'50',publishedAfter:cutoff,...(channel?{channelId:channel}:{})},signal);for(const item of result.items??[])if(item.id?.videoId)ids.add(item.id.videoId)}
      const videos:any[]=[];const all=[...ids];for(let i=0;i<all.length;i+=50){const result=await api('videos',{part:'snippet,statistics',id:all.slice(i,i+50).join(',')},signal);videos.push(...result.items??[])}
      diagnostics.videos=videos.length
      const resolvedLinks=new Map<string,string|null>()
      let resolutionBudget=30
      const candidates=new Map<string,{title:string;sources:DiscoveryProduct['sources'];weight:number}>()
      for(const video of videos){const published=video.snippet?.publishedAt;if(!published||published<cutoff)continue
        const source={url:'https://www.youtube.com/watch?v='+video.id,creator:video.snippet.channelId,views:Number(video.statistics?.viewCount??0),published}
        for(const matched of (video.snippet.description??'').match(/https?:\/\/[^\s<>"']+/g)??[]){
          diagnostics.links++
          const raw=decode(matched).replace(/[),.;\]}]+$/,'')
          let url=directListing(raw,page.platforms)
          if(!url){
            let host='';try{host=new URL(raw).hostname.toLowerCase()}catch{continue}
            if(!shortHosts.some(root=>host===root||host.endsWith('.'+root)))continue
            diagnostics.shortLinks++
            if(!resolvedLinks.has(raw)){
              if(resolutionBudget<=0){diagnostics.unresolved++;continue}
              resolutionBudget--;job.message='Resolving product short links...'
              try{resolvedLinks.set(raw,await resolveListing(raw.replace(/^http:/,'https:'),page.platforms,signal))}catch{signal.throwIfAborted();resolvedLinks.set(raw,null)}
            }
            url=resolvedLinks.get(raw)??null
            if(url)diagnostics.resolved++;else diagnostics.unresolved++
          }
          if(!url)continue
          const row:{title:string;sources:DiscoveryProduct['sources'];weight:number}=candidates.get(url)??{title:video.snippet.title,sources:[],weight:0}
          if(!row.sources.some(s=>s.url===source.url))row.sources.push(source)
          row.weight=row.sources.reduce((n,s)=>n+s.views/Math.max(1,(Date.now()-Date.parse(s.published))/86400000),0);candidates.set(url,row)
        }
      }
      diagnostics.candidates=candidates.size
      let shortlist=[...candidates].sort((a,b)=>new Set(b[1].sources.map(s=>s.creator)).size-new Set(a[1].sources.map(s=>s.creator)).size||b[1].weight-a[1].weight).slice(0,20)
      if(settings.ai!=='none'&&shortlist.length){job.message='Filtering a bounded shortlist with '+settings.ai+'...'
        const chosen=await filterShortlist(folder,settings,page.query,shortlist.map(([url,row])=>({title:row.title,slug:decodeURIComponent(new URL(url).pathname)})),signal)
        shortlist=shortlist.filter((_,i)=>chosen.includes(i))
      }
      diagnostics.afterAI=shortlist.length
      const found:DiscoveryProduct[]=[];let blocked=0
      for(const[url,row]of shortlist){signal.throwIfAborted();job.message=`Reading original listing photos: ${found.length} found, ${blocked} unavailable...`
        try{const existing=products.find(p=>p.product_url===url&&Date.now()-Date.parse(p.foundAt)<86400000);const image_url=existing?.image_url??imageFromHtml((await bytes(url,signal)).data.toString('utf8'));found.push({pageId:id,product_url:url,image_url,title:row.title,sources:row.sources,state:products.find(p=>p.pageId===id&&p.product_url===url)?.state??'ready',foundAt:new Date().toISOString()})}catch{signal.throwIfAborted();blocked++}
      }
      signal.throwIfAborted();const map=new Map(products.map(p=>[p.pageId+'|'+p.product_url,p]));for(const p of found)map.set(id+'|'+p.product_url,p);products=[...map.values()].slice(-3000);await persist()
      diagnostics.photos=found.length;diagnostics.unavailable=blocked
      await writeFile(path.join(folder,'last-run.json'),JSON.stringify({at:new Date().toISOString(),pageId:id,...diagnostics},null,2))
      const counts=diagnostics.videos+' videos; '+diagnostics.candidates+' product links; '+diagnostics.afterAI+' after AI; '+found.length+' photos saved; '+blocked+' photo failures. '
      const reason=!diagnostics.videos?'No recent videos matched. Try broader keywords or 14 days.':!diagnostics.candidates?'No selected-marketplace product links found. '+diagnostics.shortLinks+' short links seen; '+diagnostics.resolved+' resolved; '+diagnostics.unresolved+' unresolved/skipped. Try another marketplace or broader niche.':!diagnostics.afterAI?'AI rejected all candidates as unrelated. Try Code only to review them without AI filtering.':!found.length?'Retailers did not expose downloadable photos.':'Candidates saved. Popularity and availability are not guaranteed.'
      job={...job,state:found.length?'complete':'error',message:counts+reason}

    })().catch(e=>{job={...job,state:abort.signal.aborted?'cancelled':'error',message:abort.signal.aborted?'Discovery cancelled.':e instanceof Error?e.message:'Discovery failed.'}}).finally(()=>{controller=null})
  }
  const timer=setInterval(()=>{void ready.then(async()=>{if(controller||mutating||!nextRunAt||Date.parse(nextRunAt)>Date.now())return;const pages=settings.pages.filter(p=>p.autoRefresh);nextRunAt=pages.length?new Date(Date.now()+6*3600000).toISOString():null;await persist();for(const p of pages){if(controller)break;await start(p.id);while(controller)await new Promise(resolve=>setTimeout(resolve,500));}}).catch(e=>{job={...job,state:'error',message:e.message}})},30000);timer.unref();app.on('before-quit',()=>{clearInterval(timer);controller?.abort()})
  const handlers:Record<string,(...args:any[])=>Promise<unknown>>={
    status:async():Promise<DiscoveryState>=>{await ready;allowDiscoveryImages(products.map(p=>p.image_url));return{settings:{...settings,youtubeKey:'',geminiKey:'',hasYoutubeKey:!!settings.youtubeKey,hasGeminiKey:!!settings.geminiKey},products,job:{...job},nextRunAt}},
    save:async value=>{await ready;if(controller||mutating)throw new Error('Stop discovery before editing settings.');mutating=true;try{const next=validate(value);next.youtubeKey=next.youtubeKey||settings.youtubeKey;next.geminiKey='';if((next.youtubeKey||next.geminiKey)&&!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable.');await mkdir(folder,{recursive:true});await writeFile(secrets+'.tmp',safeStorage.encryptString(JSON.stringify({youtubeKey:next.youtubeKey,geminiKey:next.geminiKey})));await rename(secrets+'.tmp',secrets);settings=next;nextRunAt=settings.pages.some(p=>p.autoRefresh)?new Date(Date.now()+6*3600000).toISOString():null;await persist()}finally{mutating=false}},
    start:async id=>start(id),cancel:async()=>{controller?.abort()},
    copy:async(id,url)=>{await ready;const p=products.find(p=>p.pageId===id&&p.product_url===url);if(!p)throw new Error('Product not found.');clipboard.writeText(p.product_url)},
    posted:async(id,url)=>{await ready;const p=products.find(p=>p.pageId===id&&p.product_url===url);if(!p)throw new Error('Product not found.');p.state='posted';await persist()},
    download:async(id,url)=>{await ready;const p=products.find(p=>p.pageId===id&&p.product_url===url);if(!p)throw new Error('Product not found.');const result=await dialog.showSaveDialog({defaultPath:path.join(app.getPath('downloads'),'product-'+createHash('sha256').update(url).digest('hex').slice(0,10)+'.jpg'),filters:[{name:'JPEG photo',extensions:['jpg']}]});if(result.canceled||!result.filePath)return;const response=await bytes(p.image_url,AbortSignal.timeout(30000),15_000_000);if(!response.type.startsWith('image/'))throw new Error('Retailer did not return a photo.');const jpeg=await sharp(response.data,{limitInputPixels:40_000_000}).rotate().flatten({background:'#ffffff'}).jpeg({quality:95}).toBuffer();await writeFile(result.filePath,jpeg);if(p.state!=='posted')p.state='downloaded';await persist()},
  }
  for(const[name,handler]of Object.entries(handlers))ipcMain.handle('discovery:'+name,(event,...args:unknown[])=>{if(!authorized(event))throw new Error('Unauthorized discovery request.');const count=name==='save'||name==='start'?1:['copy','posted','download'].includes(name)?2:0;if(args.length!==count)throw new Error('Invalid request.');return handler(...args)})
}
