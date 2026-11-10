import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { publicTarget } from './product-network.cjs'
import { publicHttps } from './product-find-data.cjs'
import { canonical, candidate } from './ready-packs-core.cjs'
import { parseListingHtml } from './ready-packs-providers.cjs'
import type { Provider } from './ready-packs-providers.cjs'
import { covers } from './ready-packs-licences.cjs'
import type { BrowserStatus, PackProduct, ProviderLicence } from './ready-packs-types.cjs'
import { reject } from './ready-packs-diagnostics.cjs'

export const browserStores:Record<string,{name:string;host:string}>={myntra:{name:'Myntra',host:'www.myntra.com'},meesho:{name:'Meesho',host:'www.meesho.com'},flipkart:{name:'Flipkart',host:'www.flipkart.com'},amazon:{name:'Amazon',host:'www.amazon.in'},ajio:{name:'AJIO',host:'www.ajio.com'}}
type Snapshot={url:string;canonical?:string;title?:string;links?:string[];schemas?:unknown[];attributes?:Record<string,string>;myntra?:{brand:string;name:string;price:string;code:string;images:string[];attributes?:Record<string,string>;outOfStock:boolean}|null}
type Pending={resolve:(value:Snapshot)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;cleanup:()=>void;aborted:boolean}
const error=(message:string)=>new Error(message)

// Separate from Flow and the AI classifier. Only bounded retailer reads are
// supported: no arbitrary script, URL, file, shell, account or cookie command.
export class ProductBrowser {
 private server?:Server
 private sockets?:WebSocketServer
 private socket?:WebSocket
 private token?:Buffer
 private expires=0
 private heartbeat?:NodeJS.Timeout
 private lastSeen=0
 private pending=new Map<string,Pending>()
 private state:BrowserStatus={state:'not-connected',stores:[],message:'Pair Chrome in Product Find Settings for this app session. Collection runs only after you click Find.',checkedAt:null}
 status():BrowserStatus{return structuredClone(this.state)}
 async pair(){
  await this.close()
  this.token=randomBytes(32);this.expires=Date.now()+5*60000
  const server=this.server=createServer((_req,res)=>{res.writeHead(404);res.end()})
  const sockets=this.sockets=new WebSocketServer({noServer:true,maxPayload:1_000_000,perMessageDeflate:false})
  const accepted=new Set<WebSocket>()
  server.on('upgrade',(req,socket,head)=>{
   const address=server.address()
   if(!address||typeof address==='string'||req.url!=='/product-browser'||req.headers.host!==`127.0.0.1:${address.port}`||!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin??'')||!this.token||Date.now()>this.expires||this.socket||accepted.size>=1){socket.destroy();return}
   sockets.handleUpgrade(req,socket,head,ws=>{accepted.add(ws);this.accept(ws);ws.once('close',()=>accepted.delete(ws))})
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  const address=server.address();if(!address||typeof address==='string')throw error('Could not open the local Chrome connection.')
  this.state={state:'waiting',stores:[],message:'Paste the Product Find code in the Product Finder extension. Code expires in five minutes.',checkedAt:new Date().toISOString()}
  return{code:address.port+'.'+this.token!.toString('hex'),expiresAt:new Date(this.expires).toISOString()}
 }
 private accept(ws:WebSocket){
  let authenticated=false
  const timer=setTimeout(()=>ws.close(),5000)
  ws.on('error',()=>ws.close())
  ws.on('message',raw=>{
   try{
    const data=JSON.parse(raw.toString())
    if(!authenticated){
     if(data.type!=='pair'||typeof data.token!=='string'||!/^[0-9a-f]{64}$/.test(data.token)||!this.token||Date.now()>this.expires||this.socket||!timingSafeEqual(Buffer.from(data.token,'hex'),this.token)||!Array.isArray(data.stores)||!data.stores.length||data.stores.length>5||data.stores.some((id:unknown)=>typeof id!=='string'||!Object.hasOwn(browserStores,id))){ws.close();return}
     if(data.version!=='products-2'){ws.send(JSON.stringify({type:'pair-error',error:'Refresh Product Finder from its permanent folder, then create a fresh Product Find code.'}));ws.close();return}
     authenticated=true;clearTimeout(timer);this.token=undefined;this.socket=ws;this.lastSeen=Date.now()
     this.state={state:'paired',stores:[...new Set<string>(data.stores)],message:'Chrome site access paired. Retailer collection is implemented but unverified until your first successful search. Keep Chrome and Frame Studio open.',checkedAt:new Date().toISOString()}
     ws.send(JSON.stringify({type:'paired'}))
     this.heartbeat=setInterval(()=>{if(Date.now()-this.lastSeen>45000)ws.close();else if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}))},20000)
     return
    }
    this.lastSeen=Date.now()
    if(data.type==='pong')return
    if(data.type!=='reply'||typeof data.id!=='string')return
    const pending=this.pending.get(data.id);if(!pending)return
    this.pending.delete(data.id);clearTimeout(pending.timer);pending.cleanup()
    if(pending.aborted)pending.reject(error('Chrome collection cancelled; in-flight worker settled.'))
    else if(data.ok===true&&data.value&&typeof data.value==='object')pending.resolve(data.value as Snapshot)
    else pending.reject(error(typeof data.error==='string'?data.error.slice(0,700):'Chrome could not read the retailer listing.'))
   }catch{ws.close()}
  })
  ws.on('close',()=>{clearTimeout(timer);if(this.socket!==ws)return;this.socket=undefined;clearInterval(this.heartbeat);this.state={state:'not-connected',stores:[],message:'Chrome disconnected. Collected candidates are retained. Reconnect in Product Find Settings.',checkedAt:new Date().toISOString()};this.failPending()})
 }
 private failPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup();p.reject(error('Chrome connection ended; its workers were cancelled. Reconnect before another Chrome collection.'))}this.pending.clear()}
 async request(store:string,mode:'search'|'details',input:string,signal:AbortSignal):Promise<Snapshot>{
  signal.throwIfAborted()
  const ws=this.socket,definition=browserStores[store]
  if(!definition||!ws||ws.readyState!==WebSocket.OPEN||!this.state.stores.includes(store))throw error('Connect Chrome and allow this shopping site in Product Find Settings.')
  if(mode==='details'){const u=new URL(publicHttps(input));if(u.hostname.replace(/^www\./,'')!==definition.host.replace(/^www\./,''))throw error('Detail URL is outside the selected retailer.');u.hostname=definition.host;input=await publicTarget(u.href)}
  else{if(typeof input!=='string'||input.length>300)throw error('Clothing query exceeds the request limit.');await publicTarget('https://'+definition.host)}
  signal.throwIfAborted()
  const id=randomUUID()
  return new Promise<Snapshot>((resolve,reject)=>{
   const fail=()=>{ws.terminate();this.state={state:'not-connected',stores:[],message:'Chrome worker did not settle in time. Reconnect after the extension finishes stopping.',checkedAt:new Date().toISOString()};this.failPending()}
   const stop=()=>{const p=this.pending.get(id);if(!p||p.aborted)return;p.aborted=true;clearTimeout(p.timer);p.timer=setTimeout(fail,10000);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'cancel',id}))}
   const p:Pending={resolve,reject,timer:setTimeout(fail,50000),cleanup:()=>signal.removeEventListener('abort',stop),aborted:false}
   this.pending.set(id,p);signal.addEventListener('abort',stop,{once:true})
   ws.send(JSON.stringify({type:'collect',id,store,mode,...mode==='search'?{query:input}:{url:input}}),e=>{if(e)fail()})
   if(signal.aborted)stop()
  })
 }
 async close(){
  this.token=undefined;clearInterval(this.heartbeat)
  this.socket?.terminate();this.socket=undefined;this.failPending()
  for(const ws of this.sockets?.clients??[])ws.terminate()
  this.sockets?.close();this.sockets=undefined
  const server=this.server;this.server=undefined;if(server)await new Promise<void>(resolve=>server.close(()=>resolve()))
  this.state={state:'not-connected',stores:[],message:'Chrome Product Find disconnected. Flow and saved products are unchanged.',checkedAt:new Date().toISOString()}
 }
}

function listingSnapshot(original:PackProduct,snapshot:Snapshot):PackProduct {
 if(typeof snapshot.url!=='string'||canonical(snapshot.url).id!==original.id)throw error('Browser detail page does not match the exact requested product ID.')
 const schemas=Array.isArray(snapshot.schemas)?snapshot.schemas:[]
 if(schemas.length>20||JSON.stringify(schemas).length>200000)throw error('Listing structured data exceeds the bounded read limit.')
 const nodes:Record<string,any>[]=[]
 const walk=(value:unknown,depth=0):void=>{if(depth>15||nodes.length>20)return;if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return}if(!value||typeof value!=='object')return;const node=value as Record<string,any>;const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];if(types.some((type:unknown)=>typeof type==='string'&&/(?:^|[/#])Product$/.test(type)))nodes.push(node);for(const child of Object.values(node))if(child&&typeof child==='object')walk(child,depth+1)}
 schemas.forEach(schema=>walk(schema))
 const sameUrl=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.trim().startsWith('#'))return false;try{const u=new URL(value,snapshot.url);if(u.protocol==='http:')u.protocol='https:';return canonical(u.href).id===original.id}catch{return false}}
 const bound=nodes.filter(node=>node.sku===original.retailerId||node.productID===original.retailerId||[node.url,node['@id'],...(Array.isArray(node.offers)?node.offers:[node.offers]).filter(Boolean).map((offer:any)=>offer.url)].some(sameUrl))
 // SKU/productID proof can bind a retailer Product whose JSON-LD omits its URL.
 // The URL below is the already observed original, never a generated product URL.
 const exact=bound.length===1?bound[0]:null
 const html=(exact?[{...exact,url:original.url}]:schemas).map(schema=>'<script type="application/ld+json">'+JSON.stringify(schema).replace(/</g,'\\u003c')+'</script>').join('')
 let product:PackProduct
 try{product=parseListingHtml(original,html)}catch{product=candidate(original.url)}
 if(exact&&typeof exact.name!=='string')product.title=''
 if(exact&&typeof exact.color!=='string'){product.color='';product.variant='unknown';product.match='unknown';product.images=product.images.map(image=>({...image,variant:'unknown'}))}
 product.listingAttributes=undefined
 if(snapshot.attributes&&typeof snapshot.attributes==='object'&&!Array.isArray(snapshot.attributes))product.listingAttributes=Object.fromEntries(Object.entries(snapshot.attributes).slice(0,30).filter(([key,value])=>/^(?:Length Type|Length|Type|Ideal For|Gender|Color|Colour|Pattern|Style Code|Sleeve Length|Shape)$/i.test(key)&&typeof value==='string'&&value.length<200))
 if(exact&&original.retailer==='flipkart'&&new URL(original.url).searchParams.get('pid')===original.retailerId&&product.title&&product.currency==='INR'&&product.price!==null&&product.images.length){
  if(!product.color){product.variant='Listing '+original.retailerId+' (colour name unknown)';product.images=product.images.map(image=>({...image,variant:product.variant}))}
  product.match='exact'
  product.evidence.push({url:original.url,at:product.observedAt!,kind:'listing',note:'Product JSON-LD explicitly bound to the requested Flipkart PID by its supplied product URL or exact SKU/productID. Photos belong to that bound Product node. No colour name, stock or export permission inferred.'})
 }
 if(product.listingAttributes&&product.observedAt)product.evidence.push({url:original.url,at:product.observedAt,kind:'listing',note:'Observed listing specifications: '+JSON.stringify(product.listingAttributes).slice(0,900)})
 const m=snapshot.myntra
 // A missing colour name is unknown, not a false mismatch. An observed Myntra
 // style ID, exact canonical listing, product code and its own main gallery bind
 // this photo to the linked style. Do not use recommendations or a different ID.
 if(original.retailer==='myntra'&&m&&typeof m.name==='string'&&m.name.trim()&&typeof m.brand==='string'&&typeof m.code==='string'&&new RegExp('\\b'+original.retailerId+'\\b').test(m.code)&&snapshot.canonical&&canonical(snapshot.canonical).id===original.id&&Array.isArray(m.images)&&m.images.length){
  const amount=/^(?:₹|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)\s*$/.exec(m.price??'')
  const price=amount?Number(amount[1].replace(/,/g,'')):NaN
  if(Number.isFinite(price)&&price>0){
   product=structuredClone(original);product.listingAttributes=undefined;product.category='';product.subcategory='';product.aiClassification=undefined;product.title=(m.brand+' '+m.name).trim().slice(0,500);product.price=price;product.currency='INR';product.priceSource=original.url;product.observedAt=new Date().toISOString();product.variant='Listing '+original.retailerId+' (colour name unknown)';product.color='';product.match='exact';product.stock=m.outOfStock===true?'out-of-stock':'unknown';product.sizes=[];product.failures=[]
   product.images=m.images.slice(0,4).flatMap(url=>{try{return[{url:publicHttps(url),source:product.url,variant:product.variant,permission:'unknown' as const,permissionNote:'',exportedAt:null}]}catch{return[]}})
   if(m.attributes&&typeof m.attributes==='object'&&!Array.isArray(m.attributes)){
    product.listingAttributes=Object.fromEntries(Object.entries(m.attributes).slice(0,30).filter(([key,value])=>key.length<100&&typeof value==='string'&&value.length<200))
    product.evidence.push({url:original.url,at:product.observedAt,kind:'listing',note:'Observed listing specifications: '+JSON.stringify(product.listingAttributes).slice(0,900)})
   }
   product.evidence.push({url:original.url,at:product.observedAt,kind:'listing',note:'Observed in Chrome: exact canonical/style ID and product code; price from current PDP; photos only from this listing main gallery. Colour name, sizes and unreported stock remain unknown. Export rights not granted by browser access.'})
  }
 }
 // Preserve scope identifiers so applyLicences can still revoke/expire an old
 // inherited grant after a refresh. A parsed image is never a new permission.
 for(const image of product.images){const old=original.images.find(previous=>previous.url===image.url);if(old?.licenceId)image.licenceId=old.licenceId;if(old?.licenceAccount)image.licenceAccount=old.licenceAccount}
 if(!product.title||product.price===null||product.currency!=='INR'||product.match!=='exact'||!product.images.length){const missing=[!product.title?'listing title':'',product.price===null||product.currency!=='INR'?'observed INR price':'',product.match!=='exact'?'exact Product URL/SKU-to-variant proof':'',!product.images.length?'listing-specific photos':''].filter(Boolean);product.failures.push('Listing still needs '+missing.join(', ')+'. Candidate retained; unknown facts were not fabricated.')}
 return product
}
export function browserProvider(id:string,browser:ProductBrowser,licences:ProviderLicence[]):Provider {
 const definition=browserStores[id],connection=browser.status()
 const restricted=['amazon','ajio'].includes(id)
 const grant=licences.some(l=>covers(l,id,'catalogue-research')&&l.productHosts.includes(definition.host))
 const access=connection.state==='paired'&&connection.stores.includes(id)&&(!restricted||grant)
 const provider:Provider={status:{id,name:definition.name,host:definition.host,route:'User-paired Chrome; rendered public search and product pages',readiness:access?'configured-unverified':'needs-access',status:restricted&&!grant?'Automatic browser collection requires an existing explicit merchant research grant for this store. Chrome site permission alone does not override retailer restrictions.':access?'Chrome access paired; actual retailer listing collection is unverified.':'Connect Product Find to Chrome and allow this shopping site once.',setupAction:restricted&&!grant?'Only record permission you already have; no purchase or paid service is required or suggested.':'Settings → Product Find → Chrome product collection. Pair the extension, then click Find my next post.',capabilities:{search:true,details:true,images:true,stock:false,sizes:false,evidence:true,affiliate:false}}}
 if(access){
  provider.details=async(p,signal)=>listingSnapshot(p,await browser.request(id,'details',p.url,signal))
  provider.search=async(_category,query,signal)=>{
   const rows:PackProduct[]=[];provider.collected=rows
   const snapshot=await browser.request(id,'search',query,signal)
   if(typeof snapshot.url!=='string'||new URL(snapshot.url).hostname!==definition.host)throw error('Search page left the selected retailer.')
   const products=new Map<string,PackProduct>()
   for(const url of Array.isArray(snapshot.links)?snapshot.links.slice(0,100):[]){try{const p=candidate(url);if(p.retailer!==id)continue;products.set(p.id,p)}catch{/* Only supported original product detail URLs qualify. */}}
   if(provider.diagnostics){provider.diagnostics.counts.searchResults+=products.size;provider.diagnostics.counts.extractedUrls+=products.size;provider.diagnostics.counts.resolvedRetailerUrls+=products.size}
   if(!products.size)throw error('Readable retailer search page contained no supported product detail links. JavaScript, login or layout may prevent collection; no products were invented.')
   for(const p of [...products.values()].slice(0,8)){
    signal.throwIfAborted()
    try{const product=await provider.details!(p,signal);rows.push(product);if(provider.diagnostics){provider.diagnostics.counts.accessibleListings++;provider.diagnostics.counts.parsedProducts++}}
    catch(e){signal.throwIfAborted();const reason=e instanceof Error?e.message:'Listing could not be read.';reject(provider.diagnostics,'listing',reason);if(/denied|blocked|captcha|sign.in|login|connection ended|page failed:|Frame with ID .*error page|navigation did not finish/i.test(reason))break}
   }
   return rows
  }
 }
 return provider
}
