import { wooCatalogueProvider } from './ready-packs-catalogue.cjs'
import type { Provider } from './ready-packs-providers.cjs'
import { accountReasoner } from './antigravity-account.cjs'
import { reasonPack } from './ready-packs-ai.cjs'
import { validateLicence } from './ready-packs-licences.cjs'
import { libasProvider } from './ready-packs-libas.cjs'
import { discoveryDiagnostics } from './ready-packs-diagnostics.cjs'
import { app, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { canonical, PackRepository, reviewable } from './ready-packs-core.cjs'
import { PackService } from './ready-packs-service.cjs'
import { flipkartProvider } from './ready-packs-providers.cjs'
import type { Keys } from './ready-packs-providers.cjs'
import { exportZip } from './ready-packs-export.cjs'
import { allowDiscoveryImages } from './product-find.cjs'
import type { PackAction } from './ready-packs-types.cjs'
export function registerReadyPacks(folder:string,authorized:(e:IpcMainInvokeEvent)=>boolean){
 const keysFile=path.join(folder,'pack-keys.bin');let closing=false
 async function keys():Promise<Keys>{try{return JSON.parse(safeStorage.decryptString(await readFile(keysFile)))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{flipkartId:'',flipkartToken:'',imagePermission:''};throw new Error('Pack credentials could not be unlocked; existing file preserved.')}}
 const service:PackService=new PackService(new PackRepository(folder),async()=>{
  let k:Keys={flipkartId:'',flipkartToken:'',imagePermission:''},keyError=''
  try{k=await keys()}catch{keyError='Saved Flipkart credentials could not be unlocked; file preserved. Other sources remain available.'}
  const flipkart=flipkartProvider(k);if(keyError)flipkart.status.status=keyError
  const catalogues=(service.state?.catalogues??[]).map((c):Provider=>{try{return wooCatalogueProvider(c)}catch{return{status:{id:c.id,name:c.name,status:'Catalogue configuration is invalid; saved data preserved.',readiness:'needs-access',route:'WooCommerce Store API',setupAction:'Review saved catalogue scope in Settings.',capabilities:{search:false,details:false,images:false,evidence:false}}}}})
  return[flipkart,libasProvider(service.state?.licences??[],discoveryDiagnostics('libas: selected theme')),...catalogues,...['myntra','meesho','amazon','ajio'].map((id):Provider=>({status:{id,status:'No authorized automatic collection route configured. A browser login or original link does not establish catalogue access.',readiness:'unsupported',route:'None configured',setupAction:'No connected source for this marketplace. It is excluded from Auto; do not purchase API or proxy access.',capabilities:{search:false,details:false,images:false,stock:false,sizes:false,evidence:false,affiliate:false}}}))]
 },(store,slot,signal)=>reasonPack(folder,store,slot,signal))
 ipcMain.handle('ready-packs:status',async e=>{if(!authorized(e))throw new Error('Unauthorized pack request.');const s=await service.status();s.aiStatus=structuredClone(accountReasoner(folder).status);allowDiscoveryImages(s.products.flatMap(p=>p.images.map(i=>i.url)));return s})
 ipcMain.handle('ready-packs:action',async(e,action:PackAction)=>{if(closing||!authorized(e)||!action||typeof action.type!=='string')throw new Error('Unauthorized request or application is closing.');await service.ready;const id=action.packId??''
 switch(action.type){
 case'ai-test':{if(service.busy)throw new Error('Wait for product search to finish before testing the account.');const account=accountReasoner(folder);await account.json('Connection test only. No tools. Return {"connected":true}.',{type:'object',additionalProperties:false,properties:{connected:{type:'boolean',enum:[true]}},required:['connected']},AbortSignal.timeout(100000),{model:service.state.settings.ai?.model??'',effort:'medium',recheck:true});return}
 case'licence':return service.mutate(async()=>{const licence=validateLicence(action.value);const licences=service.state.licences??[];service.state.licences=[...licences.filter(l=>l.id!==licence.id),licence];if(service.state.sourceHealth)delete service.state.sourceHealth[licence.provider]})
 case'generate':return service.generate()
 case'next':return service.next(action.value,action.packId)
 case'preferences':return service.preferences(action.value)
 case'store-ranks':return service.storeRanks(action.value)
 case'catalogue':return service.catalogue(action.value)
 case'source-recheck':return service.recheckSource(action.productId??'')
 case'find':return service.find(action.value)
 case'more':return service.more(action.packId)
 case'done':return service.done(id)
 case'review':return service.review(id)
 case'cancel':return service.cancel()
 case'import-feedback':{const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'Performance JSON',extensions:['json']}]});if(result.canceled)return;const file=result.filePaths[0];if((await stat(file)).size>1_000_000)throw new Error('Feedback file exceeds 1 MB.');const rows=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(rows)||rows.length>200)throw new Error('Import an array of up to 200 performance records with packId.');for(const row of rows)await service.feedback(row.packId,row);return}
 case'import-text':if(typeof action.value!=='string')throw new Error('Expected product URLs or feed text.');return service.import(action.value)
 case'references':return service.mutate(async()=>{if(!Array.isArray(action.value)||action.value.length>10)throw new Error('Up to ten reference URLs.');service.pack(id).references=action.value.map(v=>{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||!/(^|\.)(instagram\.com|youtube\.com|youtu\.be)$/.test(u.hostname))throw new Error('Use Instagram or YouTube reference URLs.');return u.href})})
 case'settings':return service.settings(action.value)
 case'replace':return service.replace(id,action.productId??'')
 case'skip':return service.skip(id)
 case'feedback':case'posted':return service.feedback(id,action.value,action.type==='posted')
 case'refresh':return service.refresh(id)
 case'copy':{const pack=service.pack(id);clipboard.writeText(pack.productIds.map((id,i)=>{const p=service.state.products.find(p=>p.id===id);if(!p||!reviewable(p,pack))throw new Error('Refresh or replace unverified items before copying the whole numbered result.');return `${i+1}. ${p.title} (${service.state.providers.find(source=>source.id===p.retailer)?.name??p.retailer})\n${p.url}`}).join('\n\n'));return}
 case'copy-product':case'copy-affiliate':case'open':case'open-affiliate':{const pack=service.pack(id);if(!pack.productIds.includes(action.productId??''))throw new Error('Product not in pack.');const p=service.state.products.find(p=>p.id===action.productId)!;const affiliate=action.type.endsWith('affiliate');if(canonical(p.url,p.catalogue).id!==p.id)throw new Error('Original product URL identity is invalid.');if(affiliate&&(!p.affiliateUrl||p.affiliateStatus!=='account-api'||canonical(p.affiliateUrl,p.catalogue).id!==p.id))throw new Error('No verified account-generated affiliate link.');const url=affiliate?p.affiliateUrl!:p.url;if(action.type.startsWith('copy'))clipboard.writeText(url);else await shell.openExternal(url);return}
 case'import':{const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'Product feed or URL list',extensions:['json','csv','txt']}]});if(result.canceled)return;const file=result.filePaths[0];if((await stat(file)).size>3_000_000)throw new Error('Import exceeds 3 MB.');return service.import(await readFile(file,'utf8'))}
 case'credentials':{const v=action.value as Keys;if(!v||[v.flipkartId,v.flipkartToken,v.imagePermission].some(x=>typeof x!=='string'||x.length>1000)||/[\r\n]/.test(v.flipkartId+v.flipkartToken))throw new Error('Invalid affiliate credentials.');await service.mutate(async()=>{const old=await keys();if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption unavailable.');await mkdir(folder,{recursive:true});await writeFile(keysFile+'.tmp',safeStorage.encryptString(JSON.stringify({flipkartId:v.flipkartId||old.flipkartId,flipkartToken:v.flipkartToken||old.flipkartToken,imagePermission:v.imagePermission||old.imagePermission})));await rename(keysFile+'.tmp',keysFile);if(service.state.sourceHealth)delete service.state.sourceHealth.flipkart});return}
 case'export':{await service.refresh(id);const pack=service.pack(id);const result=await dialog.showSaveDialog({defaultPath:path.join(app.getPath('downloads'),'frame-pack-'+pack.id+'.zip'),filters:[{name:'Ready Post Pack ZIP',extensions:['zip']}]});if(result.canceled||!result.filePath)return;await service.mutate(async()=>{const zip=await exportZip(pack,service.state.products,undefined,service.state.licences??[]);await writeFile(result.filePath!,zip);if(['drafted','exported'].includes(pack.state))pack.state='exported';pack.productIds.forEach(id=>{const p=service.state.products.find(p=>p.id===id)!;if(p.state!=='posted')p.state='exported';p.images.forEach(i=>i.exportedAt=new Date().toISOString())})});return result.filePath}
 default:throw new Error('Unknown pack action.')
 }})
 // Main owns shutdown ordering; do not race its workspace/Flow cleanup with another app.quit().
 return async()=>{closing=true;await service.cancel()}
}
