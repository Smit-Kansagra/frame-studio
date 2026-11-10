// One authenticated reasoning call on real saved candidate identities; no collection or credential copying.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { AccountReasoner } from '../dist-electron/antigravity-account.cjs'
import { emptyStore, candidate } from '../dist-electron/ready-packs-core.cjs'
import { reasonPack, validateAdvice } from '../dist-electron/ready-packs-ai.cjs'
const folder=path.resolve('artifacts/antigravity-account-live');await mkdir(folder,{recursive:true})
const state=emptyStore();const source=path.join(process.env.APPDATA,'Frame Studio/product-discovery/library.json');let rows=[]
try{rows=JSON.parse(await readFile(source,'utf8')).products??[]}catch{/* Absence is reported, never filled with fixtures. */}
for(const row of rows.slice(0,20)){try{const p=candidate(row.product_url);p.evidence=(row.sources??[]).slice(0,3).map(s=>({kind:'video',url:s.url,at:row.foundAt,note:'Legacy creator/video context only; not a verified listing title: '+String(row.title??'').slice(0,160)}));if(!p.evidence.length)p.evidence=[{kind:'listing',url:p.url,at:row.foundAt??new Date().toISOString(),note:'Previously saved real listing identity; current facts unknown.'}];state.products.push(p)}catch{/* Do not reinterpret unsupported saved records. */}}
const account=new AccountReasoner(folder);const slot=state.plan.find(s=>s.state==='pending');const report={fixture:false,savedRealCandidates:state.products.length,theme:slot.subcategory,reasoning:'not-run',selectionCount:null,cacheVerified:false,discoveryAcceptance:'not-passed',realExport:'not-run'}
try{
 if(!state.products.length)throw new Error('No real saved candidate identities available; no fixture substituted.')
 const replay=process.argv.includes('--replay');const cache=replay?JSON.parse(await readFile(path.join(folder,'cache.json'),'utf8')):null;const stored=replay?Object.values(cache).sort((a,b)=>b.at-a.at)[0]?.value:null;const advice=replay?validateAdvice(stored,state,slot):await reasonPack(folder,state,slot,AbortSignal.timeout(100000),account);report.reasoning=replay?'passed-real-response-revalidated':'passed';report.responseRevalidated=replay;report.selectionCount=advice.selection.length;assert.equal(advice.selection.length,0,'Unknown listing facts must not qualify real legacy candidates.');assert.ok(state.products.every(p=>p.price===null&&p.stock==='unknown'&&p.match==='unknown'))
 if(!replay){const timestamp=account.status.lastSuccessfulCall;const cached=await reasonPack(folder,state,slot,AbortSignal.timeout(65000),account);assert.deepEqual(cached,advice);assert.equal(account.status.lastSuccessfulCall,timestamp);report.cacheVerified=true;}report.note='Real saved product IDs were evaluated and correctly left unselected because prices, stock and exact variants are unknown. No live retailer verification or export is claimed.'
}catch(e){report.reasoning=account.status.lastSuccessfulCall?'validation-failed':'blocked';report.reason=String(e.message)}
report.account=process.argv.includes('--replay')?JSON.parse(await readFile(path.join(folder,'status.json'),'utf8')):account.status;report.accountStatusSource=process.argv.includes('--replay')?'recorded-at-actual-call':'this-run';await writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
