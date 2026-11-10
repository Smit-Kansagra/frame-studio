import { publicHttps } from './product-find-data.cjs'
import type { PackProduct } from './ready-packs-types.cjs'
import type { ProviderLicence } from './ready-packs-types.cjs'
export type { ProviderLicence } from './ready-packs-types.cjs'
export function validateLicence(value:unknown):ProviderLicence {
 const l=value as ProviderLicence
 if(!l||!['flipkart','libas'].includes(l.provider)||[l.id,l.account,l.reference].some(v=>typeof v!=='string'||!v.trim()||v.length>1000)||!Number.isFinite(Date.parse(l.grantedAt))||Date.parse(l.grantedAt)>Date.now()||l.expiresAt!==null&&!Number.isFinite(Date.parse(l.expiresAt))||!Array.isArray(l.uses)||l.uses.some(u=>!['catalogue-research','instagram-commercial','image-export'].includes(u)))throw new Error('Licence needs provider, account/grant scope, reference, grant date, permitted uses and optional expiry.')
 for(const hosts of [l.productHosts,l.imageHosts])if(!Array.isArray(hosts)||!hosts.length||hosts.length>10||hosts.some(h=>{try{return new URL(publicHttps('https://'+h)).hostname!==h}catch{return true}}))throw new Error('Licence needs explicit public product/image hostnames; wildcards are not accepted.')
 if(l.imagePathPrefixes&&(!Array.isArray(l.imagePathPrefixes)||!l.imagePathPrefixes.length||l.imagePathPrefixes.some(p=>typeof p!=='string'||!p.startsWith('/')||p.includes('..')||p.length>200)))throw new Error('Use explicit licensed image path prefixes.');if(l.imageHosts.includes('cdn.shopify.com')&&!l.imagePathPrefixes?.length)throw new Error('Shared Shopify CDN requires a merchant-specific licensed path prefix.');if(l.expiresAt&&Date.parse(l.expiresAt)<=Date.parse(l.grantedAt))throw new Error('Licence expiry must follow grant date.');return structuredClone(l)
}
export function covers(l:ProviderLicence,provider:string,use:ProviderLicence['uses'][number],now=Date.now()):boolean{return l.provider===provider&&l.uses.includes(use)&&Date.parse(l.grantedAt)<=now&&(l.expiresAt===null||Date.parse(l.expiresAt)>now)}
export function applyLicences(p:PackProduct,licences:ProviderLicence[],now=Date.now()):PackProduct {
 for(const im of p.images){
  if(p.retailer==='flipkart'&&!im.licenceId&&p.evidence.at(-1)?.kind==='catalogue'){im.permission='unknown';im.permissionNote='Scoped account licence required; legacy free text is not inherited.'}
  if(im.licenceId){im.permission='unknown';im.permissionNote='Provider licence expired, revoked or no longer covers this image.'}
  const l=licences.find(l=>covers(l,p.retailer,'instagram-commercial',now)&&covers(l,p.retailer,'image-export',now)&&l.productHosts.includes(new URL(p.url).hostname)&&l.productHosts.includes(new URL(im.source).hostname)&&l.imageHosts.includes(new URL(im.url).hostname)&&(!l.imagePathPrefixes||l.imagePathPrefixes.some(prefix=>new URL(im.url).pathname.startsWith(prefix)))&&(l.provider!=='flipkart'||im.licenceAccount===l.account))
  if(l){im.permission='permitted';im.permissionNote=l.reference;im.licenceId=l.id}
 }return p
}
