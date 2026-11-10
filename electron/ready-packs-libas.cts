import { createHash } from 'node:crypto'
import { bytes } from './product-network.cjs'
import { candidate } from './ready-packs-core.cjs'
import { publicHttps } from './product-find-data.cjs'
import { covers, applyLicences } from './ready-packs-licences.cjs'
import type { ProviderLicence } from './ready-packs-licences.cjs'
import type { Provider } from './ready-packs-providers.cjs'
import type { Category, PackProduct } from './ready-packs-types.cjs'
import { reject } from './ready-packs-diagnostics.cjs'
import type { DiscoveryDiagnostics } from './ready-packs-diagnostics.cjs'
const origin='https://www.libas.in'
function imageUrl(value:string){return publicHttps(value.startsWith('//')?'https:'+value:new URL(value,origin).href)}
export function parseShopifyProduct(raw:any,url:string,currency:string|null,licences:ProviderLicence[]):PackProduct {
 const p=candidate(url);if(typeof raw.handle!=='string'||new URL(url).pathname!=='/products/'+raw.handle||!Array.isArray(raw.variants))throw new Error('Catalogue identity/variants unavailable.')
 const variant=raw.variants.find((v:any)=>String(v.id)===new URL(url).searchParams.get('variant'))??raw.variants.find((v:any)=>v.available===true)??raw.variants[0];if(!variant)throw new Error('No product variant returned.')
 p.url=origin+'/products/'+raw.handle+'?variant='+encodeURIComponent(String(variant.id));p.title=String(raw.title??'');p.retailerId=String(raw.id);p.garmentId=String(raw.id);p.id=createHash('sha256').update('libas:'+raw.handle).digest('hex').slice(0,24)
 const options=(raw.options??[]).map((o:any)=>typeof o==='string'?o:o.name);const colorIndex=options.findIndex((o:string)=>/^(colou?r)$/i.test(o));const sizeIndex=options.findIndex((o:string)=>/^size$/i.test(o));p.color=colorIndex>=0?String(variant.options?.[colorIndex]??variant['option'+(colorIndex+1)]??''):'';p.variant=String(variant.title??'unknown');p.sizes=sizeIndex>=0?raw.variants.filter((v:any)=>v.available===true&&(!p.color||v.options?.[colorIndex]===p.color)).map((v:any)=>String(v.options?.[sizeIndex]??v['option'+(sizeIndex+1)])):[]
 p.price=typeof variant.price==='number'&&variant.price>0?variant.price/100:null;p.currency=currency;p.priceSource=p.url;p.observedAt=new Date().toISOString();p.stock=variant.available===true?'in-stock':variant.available===false?'out-of-stock':'unknown'
 const featured=variant.featured_image?.src??variant.featured_image?.url;const sizeOnly=options.length>0&&options.every((o:string)=>/^size$/i.test(o));const primary=featured??(sizeOnly?raw.featured_image:null);p.match=primary?'exact':'unknown';
 p.images=primary?[{url:imageUrl(primary),source:p.url,variant:p.variant,permission:'unknown',permissionNote:'',exportedAt:null}]:[];p.evidence=[{url:p.url,at:p.observedAt,kind:'catalogue',note:'Libas public Shopify product response; exact variant ID. Missing colour stays unknown. Price currency independently observed on original listing.'}];return applyLicences(p,licences)
}
export function libasProvider(licences:ProviderLicence[],diagnostics?:DiscoveryDiagnostics):Provider {
 const grant=licences.find(l=>covers(l,'libas','catalogue-research')&&l.productHosts.includes('www.libas.in'))
 const status={id:'libas',status:grant?'Merchant permission recorded; live catalogue access unverified':'Blocked: merchant permission for automated catalogue research required by Libas terms; https://www.libas.in/pages/contact-us',capabilities:{search:true,details:true,images:true,stock:true,sizes:true,evidence:true,affiliate:false}}
 async function details(p:PackProduct,signal:AbortSignal){if(!licences.some(l=>covers(l,'libas','catalogue-research')&&l.productHosts.includes('www.libas.in')))throw new Error('Merchant research permission expired or unavailable.');const u=new URL(p.url);const data=JSON.parse((await bytes(origin+u.pathname+'.js',signal)).data.toString('utf8'));const page=(await bytes(origin+u.pathname,signal)).data.toString('utf8');const currency=page.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/)?.[1]??page.match(/property=["']product:price:currency["'][^>]*content=["']([A-Z]{3})["']/)?.[1]??null;return parseShopifyProduct(data,p.url,currency,licences)}
 return {status,diagnostics,...grant?{details,search:async(_c:Category,query:string,signal:AbortSignal)=>{
 const url=origin+'/search/suggest.json?q='+encodeURIComponent(query.replace(/kurtis/g,'kurti'))+'&resources[type]=product&resources[limit]=10';const response=JSON.parse((await bytes(url,signal)).data.toString('utf8'));const products=response.resources?.results?.products;if(!Array.isArray(products))throw new Error('Public search response unavailable.');if(diagnostics)diagnostics.counts.searchResults+=products.length;const rows:PackProduct[]=[]
 for(const row of products.slice(0,10)){try{const url=origin+'/products/'+row.handle;if(diagnostics){diagnostics.counts.extractedUrls++;diagnostics.counts.resolvedRetailerUrls++}const result=await details(candidate(url),signal);if(diagnostics){diagnostics.counts.accessibleListings++;diagnostics.counts.parsedProducts++}rows.push(result)}catch(e){signal.throwIfAborted();reject(diagnostics,'listing',(e as Error).message,'www.libas.in')}}return rows
 }}:{}}
}
