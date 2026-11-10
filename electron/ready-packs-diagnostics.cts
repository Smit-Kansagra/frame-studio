import type { DiscoveryDiagnostics } from './ready-packs-types.cjs'
export type { DiscoveryDiagnostics } from './ready-packs-types.cjs'
export function discoveryDiagnostics(query:string):DiscoveryDiagnostics {return {at:new Date().toISOString(),query,windowStart:new Date(Date.now()-14*86400000).toISOString(),counts:{searchResults:0,extractedUrls:0,resolvedRetailerUrls:0,accessibleListings:0,parsedProducts:0,categoryMatches:0,budgetMatches:0,variantMatches:0,usablePhotos:0,packCandidates:0},hosts:{},rejections:[]}}
export function reject(d:DiscoveryDiagnostics|undefined,stage:string,reason:string,host?:string){if(d&&d.rejections.length<200)d.rejections.push({stage,reason,...host?{host}:{}})}
