import { candidate } from './ready-packs-core.cjs'
import { publicHttps } from './product-find-data.cjs'
import { publicTarget } from './product-network.cjs'
import { discoveryDiagnostics, reject } from './ready-packs-diagnostics.cjs'
import type { MerchantCatalogue, PackProduct } from './ready-packs-types.cjs'
import type { Provider } from './ready-packs-providers.cjs'

// Documented, keyless Store API. This does not grant a merchant's research or image licence.
// https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/products/
export function validateCatalogue(raw:unknown):MerchantCatalogue {
 const c=raw as MerchantCatalogue
 if(!c||!/^catalogue:[a-z0-9-]{1,40}$/.test(c.id)||c.kind!=='woocommerce'||typeof c.name!=='string'||!c.name.trim()||c.name.length>100||typeof c.enabled!=='boolean')throw new Error('Provide a catalogue ID, store name and WooCommerce source.')
 const u=new URL(publicHttps(c.origin))
 if(u.origin!==c.origin||u.pathname!=='/'||u.search||u.hash||u.port)throw new Error('Use a public HTTPS store origin without paths, credentials or a port.')
 if(/(^|\.)(meesho\.com|flipkart\.com|amazon\.in|myntra\.com|ajio\.com|libas\.in)$/.test(u.hostname))throw new Error('This generic API is not an integration for that marketplace.')
 const p=c.permission
 if(!p||typeof p.reference!=='string'||!p.reference.trim()||p.reference.length>1000||!Number.isFinite(Date.parse(p.grantedAt))||Date.parse(p.grantedAt)>Date.now()||p.expiresAt!==null&&(!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.parse(p.grantedAt)))throw new Error('Record an actual merchant research permission reference, grant date and optional expiry. Public API access alone is not a licence.')
 return {id:c.id,name:c.name,kind:'woocommerce',origin:u.origin,enabled:c.enabled,permission:structuredClone(p)}
}
const validGrant=(c:MerchantCatalogue)=>c.enabled&&Date.parse(c.permission.grantedAt)<=Date.now()&&(c.permission.expiresAt===null||Date.parse(c.permission.expiresAt)>Date.now())
const text=(value:unknown)=>typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim():''

export function parseWooProduct(raw:any,c:MerchantCatalogue,parent?:any):PackProduct {
 if(!Number.isSafeInteger(raw?.id)||raw.id<=0||raw.is_password_protected===true)throw new Error('Product identity unavailable or password-protected; not collected.')
 const url=new URL(publicHttps(raw.permalink));url.hash=''
 if(url.origin!==c.origin||url.pathname==='/'||/^\/(wp-admin|wp-json|wp-login)/.test(url.pathname)||[...url.searchParams.keys()].some(k=>!/^attribute_[a-z0-9_-]+$/.test(k)))throw new Error('Original detail URL/variant is not an in-scope product permalink.')
 const p=candidate(url.href,{providerId:c.id,origin:c.origin,productId:String(raw.id),listingUrl:url.href})
 p.title=text(raw.name).slice(0,500);p.garmentId=String(parent?.id??raw.id)
 const prices=raw.prices,minor=prices?.currency_minor_unit
 if(prices?.currency_code==='INR'&&Number.isInteger(minor)&&minor>=0&&minor<=4&&typeof prices.price==='string'&&/^\d+$/.test(prices.price)&&Number.isSafeInteger(Number(prices.price))){p.price=Number(prices.price)/10**minor;p.currency='INR'}
 p.priceSource=c.origin+'/wp-json/wc/store/v1/products/'+raw.id;p.observedAt=new Date().toISOString()
 p.stock=raw.is_in_stock===true?'in-stock':raw.is_in_stock===false?'out-of-stock':'unknown'
 const variation=text(raw.variation),simple=raw.has_options===false&&!variation
 if(parent){const up=raw._links?.up?.[0]?.href;if(typeof up!=='string'||new URL(up).origin!==c.origin||new URL(up).pathname.replace(/\/$/,'')!=='/wp-json/wc/store/v1/products/'+parent.id)throw new Error('Variation does not prove its parent garment identity.')}
 p.variant=variation||(simple?'Single listing SKU '+String(raw.sku||raw.id):'unknown')
 const images=(Array.isArray(raw.images)?raw.images:[]).filter((im:any)=>typeof im?.src==='string')
 // Colour is not inferred from pixels, filenames or an inherited parent gallery.
 const parentImages=new Set((parent?.images??[]).map((i:any)=>i.src))
 const specific=!!parent&&!!variation&&p.url!==new URL(publicHttps(parent.permalink)).href&&images.length>0&&images.every((i:any)=>!parentImages.has(i.src))
 p.match=simple||specific?'exact':'unknown'
 p.images=images.slice(0,4).flatMap((im:any)=>{try{return[{url:publicHttps(im.src),source:p.url,variant:p.variant,permission:'unknown' as const,permissionNote:'',exportedAt:null}]}catch{return[]}})
 p.evidence=[{url:p.priceSource,at:p.observedAt,kind:'catalogue',note:'Merchant-authorized WooCommerce Store API detail record. Product ID/permalink/images observed together; reuse rights remain unknown.'}]
 if(!simple&&!specific)p.failures.push('Variable garment image relationship unverified; parent gallery is not proof of a selected colour.')
 if(raw.is_purchasable===false)p.failures.push('Listing reports not purchasable.')
 return p
}

export function wooCatalogueProvider(raw:MerchantCatalogue):Provider {
 const c=validateCatalogue(raw),grant=validGrant(c),diagnostics=discoveryDiagnostics(c.id+': merchant catalogue')
 const provider:Provider={diagnostics,status:{id:c.id,name:c.name,host:new URL(c.origin).hostname,route:'WooCommerce Store API (GET only)',readiness:grant?'configured-unverified':'needs-access',status:grant?'Research permission recorded; API access unverified':'Store disabled or research permission expired',setupAction:'Use only a store you already have permission to research. Record its existing grant in Settings; no account, billing or API key is required by this protocol.',capabilities:{search:true,details:true,images:true,stock:true,sizes:false,evidence:true,affiliate:false}}}
 async function request(suffix:string,signal:AbortSignal):Promise<any>{
  if(!validGrant(c))throw new Error('Merchant research permission is unavailable or expired.')
  let url=c.origin+'/wp-json/wc/store/v1/products'+suffix
  for(let hop=0;hop<3;hop++){
   signal.throwIfAborted()
   const target=new URL(url)
   if(target.origin!==c.origin||!/^\/wp-json\/wc\/store\/v1\/products(?:\/\d+)?\/?$/.test(target.pathname)||[...target.searchParams.keys()].some(k=>!['search','per_page','catalog_visibility','type','parent'].includes(k)))throw new Error('Catalogue redirect left its authorized API scope.')
   const r=await fetch(await publicTarget(url),{redirect:'manual',credentials:'omit',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Accept:'application/json'}})
   if(r.status>=300&&r.status<400){const next=r.headers.get('location');await r.body?.cancel();if(!next)throw new Error('Catalogue redirect missing location.');url=new URL(next,url).href;continue}
   if(!r.ok){await r.body?.cancel();throw new Error('Catalogue HTTP '+r.status+'. No login, proxy or access bypass attempted.')}
   if(!r.headers.get('content-type')?.includes('json')){await r.body?.cancel();throw new Error('Catalogue returned HTML or a JavaScript/login challenge instead of supported JSON.')}
   if(Number(r.headers.get('content-length'))>2_000_000){await r.body?.cancel();throw new Error('Catalogue response exceeds 2 MB.')}
   const reader=r.body!.getReader(),chunks:Uint8Array[]=[];let size=0
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000)throw new Error('Catalogue response exceeds 2 MB.');chunks.push(part.value)}}finally{await reader.cancel()}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new Error('Catalogue returned invalid JSON.')}
  }
  throw new Error('Catalogue exceeded redirect limit.')
 }
 if(grant){
  provider.details=async(p,signal)=>{
   if(p.catalogue?.providerId!==c.id||p.catalogue.origin!==c.origin)throw new Error('Product is outside the configured catalogue.')
   const raw=await request('/'+encodeURIComponent(p.retailerId),signal)
   if(String(raw.id)!==p.retailerId)throw new Error('Exact catalogue ID was not returned.')
   // Variation-specific image assignments cannot be re-proven from an inherited gallery alone.
   let parent:any
   if(raw.variation){const up=raw._links?.up?.[0]?.href;if(typeof up!=='string'||new URL(up).origin!==c.origin||!/^\/wp-json\/wc\/store\/v1\/products\/\d+$/.test(new URL(up).pathname))throw new Error('Variation parent identity unavailable.');parent=await request('/'+new URL(up).pathname.split('/').at(-1),signal)}
   const next=parseWooProduct(raw,c,parent);if(next.id!==p.id||next.url!==p.url)throw new Error('Exact product permalink changed; original candidate retained for review.')
   return {...next,category:p.category,subcategory:p.subcategory,state:p.state,lastUsedAt:p.lastUsedAt}
  }
  provider.search=async(_category,query,signal)=>{
   const list=await request('?search='+encodeURIComponent(query)+'&per_page=10&catalog_visibility=visible',signal)
   if(!Array.isArray(list))throw new Error('Catalogue products collection is not an array.')
   diagnostics.counts.searchResults+=list.length
   const rows:PackProduct[]=[];let detailBudget=12
   for(const item of list.slice(0,8)){
    signal.throwIfAborted();if(detailBudget<=0)break
    try{
     if(!Number.isSafeInteger(item.id)||item.id<=0)throw new Error('Search record missing stable product ID.')
     detailBudget--;const detail=await request('/'+item.id,signal);diagnostics.counts.accessibleListings++
     if(detail.id!==item.id)throw new Error('Search/detail product IDs differ.')
     diagnostics.counts.extractedUrls++;diagnostics.counts.resolvedRetailerUrls++
     if(detail.has_options===true){
      if(detailBudget<=0)break;detailBudget--
      const variants=await request('?type=variation&parent='+item.id+'&per_page=6',signal)
      if(!Array.isArray(variants))throw new Error('Exact variation records unavailable.')
      for(const variant of variants.slice(0,6)){try{rows.push(parseWooProduct(variant,c,detail));diagnostics.counts.parsedProducts++}catch(e){reject(diagnostics,'variant',(e as Error).message)}}
     }else{rows.push(parseWooProduct(detail,c));diagnostics.counts.parsedProducts++}
    }catch(e){signal.throwIfAborted();reject(diagnostics,'listing',(e as Error).message);if(/HTTP (401|403|429)|challenge/i.test((e as Error).message))throw e}
   }
   return rows.slice(0,24)
  }
 }
 return provider
}
