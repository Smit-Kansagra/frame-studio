import { app, clipboard, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { renameSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { publicHttps } from './product-find-data.cjs'
import { readRequest } from './product-find-research.cjs'
import { ProductFindRunner, findAntigravityCLI, readResearch } from './product-find-runner.cjs'
import type { ProductFindState, ProductFindRequest } from './contracts.cjs'
const allowedImages=new Set<string>()
export function allowDiscoveryImages(urls:string[]):void { for(const url of urls)allowedImages.add(url) }
export function isProductFindImage(url:string):boolean {return allowedImages.has(url)}
const interval=6*60*60*1000
export function registerProductFind(folder:string,authorized:(event:IpcMainInvokeEvent)=>boolean) {
  const runner=new ProductFindRunner(folder)
  let savedSearch:ProductFindRequest|null=null, nextRunAt:string|null=null, scheduleError=''
  let changing=false, closing=false
  const settingsFile=path.join(folder,'saved-search.json')
  const ready=(async()=>{
    try {
      const value=JSON.parse(await readFile(settingsFile,'utf8'))
      savedSearch=readRequest(value.request)
      nextRunAt=savedSearch.autoRefresh && Number.isFinite(Date.parse(value.nextRunAt))?value.nextRunAt:null
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')scheduleError='Saved search could not be loaded. Start a new search to replace it.'}
  })()
  const save=async()=>{
    await mkdir(folder,{recursive:true})
    await writeFile(settingsFile+'.tmp',JSON.stringify({request:savedSearch,nextRunAt}),'utf8')
    renameSync(settingsFile+'.tmp',settingsFile)
  }
  const start=async(value:unknown)=>{
    await ready
    if(changing||closing||runner.status().state==='running')throw new Error('Research is already running or stopping.')
    const request=readRequest(value)
    changing=true
    try {
      savedSearch=request
      nextRunAt=request.autoRefresh?new Date(Date.now()+interval).toISOString():null
      await save()
      scheduleError=''
      await runner.start(request)
    }finally{changing=false}
  }
  const stopAuto=async()=>{
    await ready
    if(changing)throw new Error('Search settings are being saved. Try again.')
    changing=true
    try{if(savedSearch)savedSearch={...savedSearch,autoRefresh:false};nextRunAt=null;await save()}finally{changing=false}
  }
  const timer=setInterval(()=>{
    void ready.then(async()=>{
      if(closing||changing||!savedSearch?.autoRefresh||!nextRunAt||Date.parse(nextRunAt)>Date.now()||runner.status().state==='running')return
      try{await start(savedSearch)}catch(error){nextRunAt=null;scheduleError=error instanceof Error?error.message:'Automatic research could not start.'}
    })
  },30000)
  timer.unref()
  app.on('before-quit',()=>{closing=true;clearInterval(timer);runner.cancel()})
  const status=async():Promise<ProductFindState>=>{
    await ready
    const research=await readResearch(folder)
    const automation=runner.status()
    if(scheduleError && automation.state!=='running')automation.message=scheduleError
    const matching=research && savedSearch && research.request.query===savedSearch.query && research.request.lookbackDays===savedSearch.lookbackDays && [...research.request.platforms].sort().join() === [...savedSearch.platforms].sort().join()
    const fresh=research && Date.now()-Date.parse(research.updatedAt)<24*60*60*1000
    const cutoff=Date.now()-(savedSearch?.lookbackDays??14)*86400000
    const products=matching&&fresh?research.products.filter(p=>p.posts.length>=2 && p.posts.some(post=>Date.parse(post.published_at)>=cutoff && post.buying_comment_url) && new Set(p.posts.filter(post=>Date.parse(post.published_at)>=cutoff).map(post=>post.creator_url)).size>=2).map(p=>({product_url:publicHttps(p.product_url),image_url:publicHttps(p.image_url)})):[]
    // Shared discovery images remain allowed while its cards are visible.
    for(const product of products)allowedImages.add(product.image_url)
    if(research&&!fresh&&automation.state!=='running')automation.message='Saved research is older than 24 hours. Run Find products to refresh evidence and availability.'
    return{folder,products,updatedAt:research?.updatedAt??null,automation,cliPath:await findAntigravityCLI(),savedSearch,nextRunAt}
  }
  const handlers:Record<string,(...args:unknown[])=>unknown>={
    status:()=>status(),start:value=>start(value),'stop-auto-refresh':()=>stopAuto(),
    cancel:async()=>{runner.cancel();await stopAuto()},
    'open-folder':async()=>{await mkdir(folder,{recursive:true});const error=await shell.openPath(folder);if(error)throw new Error(error)},
    'copy-product':async value=>{const url=publicHttps(value);if(!(await status()).products.some(p=>p.product_url===url))throw new Error('Product is no longer in current results.');clipboard.writeText(url)},
    'open-product':async value=>{const url=publicHttps(value);if(!(await status()).products.some(p=>p.product_url===url))throw new Error('Product is no longer in current results.');await shell.openExternal(url)},
  }
  for(const[name,handler]of Object.entries(handlers))ipcMain.handle(`product-find:${name}`,(event,...args:unknown[])=>{
    if(!authorized(event))throw new Error('Unauthorized product request.')
    if(args.length!==(['start','copy-product','open-product'].includes(name)?1:0))throw new Error('Invalid product request.')
    return handler(...args)
  })
}
