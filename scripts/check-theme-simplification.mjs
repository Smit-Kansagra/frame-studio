import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {assemblePrompt} from '../dist-electron/storage/prompt-core.mjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-theme-simple-')),source=path.join(root,'product.png')
await sharp({create:{width:120,height:160,channels:3,background:'#7766aa'}}).png().toFile(source)
const ws=await Workspace.open(path.join(root,'workspace'))
try{
 const asset=await ws.importImage(source),product=await ws.products.save({name:'Product',description:'',notes:'',assetIds:[asset.id],primaryAssetId:asset.id})
 const common={name:'Master direction',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'MASTER_ONLY: soft daylight. Avoid distortion.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'',scenes:[]}
 const master=await ws.themes.save(common),project=await ws.projects.save({name:'Master only',productId:product.id,themeId:master.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0}),preview=assemblePrompt(project)
 assert.deepEqual(preview.errors,[]);assert.match(preview.text,/MASTER_ONLY/);await ws.generations.prepare(project.id,'post')
 const ref=await ws.themes.save({...common,name:'With reference',referenceAssetIds:[asset.id],referenceInstructions:[{assetId:asset.id,name:'Pose',compositionPrompt:'',negativePrompt:''}]})
 const mapped=await ws.projects.save({name:'Visual reference',productId:product.id,themeId:ref.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
 assert.deepEqual(assemblePrompt(mapped).errors,[],'A visual reference and master direction do not need an inaccessible fallback field')
 const legacy=await ws.themes.save({...common,name:'Legacy',compositionPrompt:'OLD_FALLBACK',referenceAssetIds:[asset.id],referenceInstructions:[{assetId:asset.id,name:'Reference',compositionPrompt:'',negativePrompt:'OLD_NEGATIVE'}]})
 const {images,id,revision,createdAt,updatedAt,...content}=legacy
 const edited=await ws.themes.save({...content,id,expectedRevision:revision,name:'Legacy renamed'});assert.equal(edited.compositionPrompt,'OLD_FALLBACK');assert.equal(edited.referenceInstructions[0].negativePrompt,'OLD_NEGATIVE')
 const filled=await ws.themes.save({...content,id,expectedRevision:edited.revision,referenceInstructions:[{assetId:asset.id,name:'Reference',compositionPrompt:'IMAGE_COMPOSITION',negativePrompt:'OLD_NEGATIVE'}]})
 const p=await ws.projects.save({name:'Selected image',productId:product.id,themeId:filled.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0}),prompt=assemblePrompt(p)
 assert.deepEqual(prompt.errors,[]);assert.match(prompt.text,/IMAGE_COMPOSITION/);assert.doesNotMatch(prompt.text,/OLD_FALLBACK/)
 assert.throws(()=>ws.themes.save({...common,outputType:'reel',aspectRatio:'9:16',defaultDuration:5,scenes:[]}),/Reel|scene/i)
 console.log('PASS Post save, project creation and generation preparation without separate composition; image-specific composition overrides legacy fallback, legacy data survives edits, Reel storyboard validation stays intact.')
}finally{await ws.close()}
