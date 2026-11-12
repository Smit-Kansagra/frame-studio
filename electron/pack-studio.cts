import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import type { WorkspaceManager } from './workspace-manager.cjs'
import type { PackProduct, ProviderLicence, ReadyPack } from './ready-packs-types.cjs'
import { packEntries } from './ready-packs-export.cjs'

// Reuse export validation, image rights, bounded downloads and real JPEG conversion.
// Only primary photos are imported, in the same order as the visible pack links.
export async function importPackToStudio(workspace:WorkspaceManager,pack:ReadyPack,products:PackProduct[],licences:ProviderLicence[]):Promise<string>{
 const primary=products.map(p=>({...p,images:p.images.slice(0,1)}))
 const entries=await packEntries(pack,primary,undefined,licences)
 const photos=entries.filter(entry=>/^\d{2}_primary\.jpg$/.test(entry.name))
 if(photos.length!==pack.productIds.length)throw new Error('Photo/link numbering could not be preserved. Nothing was added to Studio.')
 const signature=createHash('sha256').update(JSON.stringify(pack.productIds.map(id=>{const p=primary.find(p=>p.id===id)!;return[id,p.variant,p.images[0]?.url]}))).digest('hex')
 if(pack.studio?.signature===signature){const existing=await workspace.productOperation(products=>products.get(pack.studio!.productId));if(existing.ok&&existing.value.photos.every(photo=>photo.available))return existing.value.id}
 const ready=await workspace.status();if(!ready.ok)throw new Error(ready.error.message)
 const staging=await mkdtemp(path.join(os.tmpdir(),'frame-pack-studio-'))
 try{
  const assets:string[]=[]
  for(const photo of photos){const file=path.join(staging,photo.name);await writeFile(file,photo.data);const imported=await workspace.importImage(file);if(!imported.ok)throw new Error(imported.error.message);assets.push(imported.value.id)}
  const ordered=pack.productIds.map(id=>products.find(p=>p.id===id)!)
  const saved=await workspace.productOperation(library=>library.save({name:(pack.subcategory+' · '+new Date(pack.createdAt).toLocaleDateString('en-IN')).slice(0,120),description:ordered.map((p,i)=>`${i+1}. ${p.title}`).join('\n').slice(0,2000),notes:('Product Find pack '+pack.id+'\n'+ordered.map((p,i)=>`${i+1}. ${p.variant}\n${p.url}`).join('\n')).slice(0,2000),assetIds:assets,primaryAssetId:assets[0]}))
  if(!saved.ok)throw new Error(saved.error.message)
  pack.studio={productId:saved.value.id,signature}
  return saved.value.id
 }finally{const resolved=path.resolve(staging);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('frame-pack-studio-'))throw new Error('Temporary Studio import cleanup path is invalid.');await rm(resolved,{recursive:true,force:true})}
}
