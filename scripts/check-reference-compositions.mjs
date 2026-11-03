// Isolated reference-specific composition, fallback and real request snapshots.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowScheduler } from '../dist-electron/flow-scheduler.cjs'
import { assemblePrompt } from '../dist-electron/storage/prompt-core.mjs'
import { postPhotos } from '../dist-electron/storage/post-plan.mjs'
import { compositionCompatibleShared } from '../dist-electron/storage/theme-references.mjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-reference-composition-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const assets=[]
for(let i=0;i<7;i++){const file=path.join(root,`${i}.png`);await writeFile(file,await sharp({create:{width:32,height:40,channels:3,background:{r:i*30,g:80,b:100}}}).png().toBuffer());assets.push(await ws.importImage(file))}
const product=await ws.products.save({name:'Four products',description:'Exact garment',notes:'Preserve embroidery',assetIds:assets.slice(0,4).map(x=>x.id),primaryAssetId:assets[0].id})
const character=await ws.characters.save({name:'Selected identity',category:null,assetIds:[assets[6].id],primaryAssetId:assets[6].id})
const base={name:'Two independent references',description:'',coverAssetId:null,referenceAssetIds:[assets[4].id,assets[5].id],masterPrompt:'Soft daylight. No heading, no bag, no watermark. Keep product details.',negativePrompt:'No heading, no bag, no extra people, no logos.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'SHARED FALLBACK COMPOSITION',scenes:[]}
let theme=await ws.themes.save({...base,referenceInstructions:[
  {assetId:assets[4].id,name:'Mirror with headline and purse',compositionPrompt:'MIRROR_ONLY: Show a full-length mirror pose with a blue bag. Add heading "Summer Edit". No extra people.',negativePrompt:'NO_MIRROR_GLARE'},
  {assetId:assets[5].id,name:'Seated studio',compositionPrompt:'SEATED_ONLY: Seated side-on pose on a white chair, plain background.',negativePrompt:'NO_CHAIR_DISTORTION'},
]})
const makeProject=theme=>ws.projects.save({name:'Reference mapping',productId:product.id,themeId:theme.id,characterId:character.id,outputType:'post',preset:'post-portrait',duration:0})
const project=await makeProject(theme),slots=postPhotos(project)
for(const slot of slots){
  const p=assemblePrompt(project,undefined,slot.id),mirror=slot.index%2===0
  assert.deepEqual(p.errors,[])
  assert.equal(p.selectedReference.assetId,assets[mirror?4:5].id)
  assert.equal(p.selectedReference.compositionSource,'reference')
  assert.ok(p.text.includes(mirror?'MIRROR_ONLY':'SEATED_ONLY'))
  assert.ok(!p.text.includes(mirror?'SEATED_ONLY':'MIRROR_ONLY'))
  assert.ok(p.text.includes(mirror?'NO_MIRROR_GLARE':'NO_CHAIR_DISTORTION'))
  assert.ok(!p.text.includes(mirror?'NO_CHAIR_DISTORTION':'NO_MIRROR_GLARE'))
  assert.ok(!p.text.includes('SHARED FALLBACK COMPOSITION'))
  assert.deepEqual(p.references.map(x=>x.id),[slot.product.id,assets[mirror?4:5].id,assets[6].id])
  assert.match(p.text,/Product images: Input image 1/);assert.match(p.text,/Theme reference:.*Input image 2/);assert.match(p.text,/Character references: Input images 3/)
  if(mirror){assert.doesNotMatch(p.text,/\bno heading\b|\bno bag\b/i);assert.match(p.text,/no watermark/i);assert.match(p.text,/extra people/i)}
  else {assert.match(p.text,/no heading/i);assert.match(p.text,/no bag/i)}
}
assert.doesNotMatch(compositionCompatibleShared('No text, bags, watermarks.','Add a heading and a red handbag.'),/\btext\b|\bbags\b/i)
assert.match(compositionCompatibleShared('No text, bags, watermarks.','Add a heading and a red handbag.'),/watermarks/)
assert.match(compositionCompatibleShared('No bags.','No bag is allowed.'),/No bags/)
assert.match(compositionCompatibleShared('No heading, no misspelled text, no bag, no watermark.','Add a heading and a bag.'),/misspelled text/)
assert.equal((await ws.themes.get(theme.id)).masterPrompt,base.masterPrompt,'Stored shared direction is preserved; conflict removal applies only to the selected request')
const requests=[],remote=new Map()
let current,submits=0
const driver={
  async createProject(commit){const url='https://flow.google.com/project/reference-mapping';await commit(url);return url},async nameProject(){},
  async prepare(_url,request){current=request;requests.push(request);const expected=assemblePrompt(project,undefined,request.sceneId);assert.equal(request.prompt,expected.text,'Preview must match the exact submitted prompt');assert.deepEqual(request.themeReference,expected.selectedReference);assert.equal(request.files.length,3);assert.ok(request.files[1].includes(expected.selectedReference.assetId));return [...remote.keys()]},
  async submit(){submits++;remote.set(`reference-${submits}`,current.prompt)},async results(_url,prompt,_kind,baseline){return [...remote].filter(([id,value])=>value===prompt&&!baseline.includes(id)).map(([id])=>({id,selector:'#result'}))},async download(){return path.join(root,'0.png')},
}
const runner=new FlowScheduler(async()=>ws,()=>driver,5,1000)
try{
  await runner.startPosts(project.id)
  const end=Date.now()+4000;while(runner.busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(runner.busy,false);assert.equal(submits,4)
  const saved=(await ws.generations.list(project.id))[0]
  assert.ok(saved.themeReference);assert.equal(saved.prompt,requests.find(r=>r.id===saved.id).prompt)
  await runner.close();await ws.close();ws=await Workspace.open(folder)
  assert.deepEqual(ws.generations.get(saved.id).themeReference,saved.themeReference,'Exact mapping survives restart')
  theme=await ws.themes.get(theme.id)
  assert.equal(theme.referenceInstructions[0].name,'Mirror with headline and purse')
  const duplicate=await ws.themes.duplicate(theme.id,theme.revision)
  assert.deepEqual(duplicate.referenceInstructions,theme.referenceInstructions)
  const removed=await ws.themes.remove(duplicate.id,duplicate.revision)
  assert.deepEqual((await ws.themes.undo(removed.token)).referenceInstructions,theme.referenceInstructions)

  const fallback=await ws.themes.save({...base,name:'Legacy fallback'})
  const older=await makeProject(fallback)
  delete older.snapshot.theme.referenceInstructions;delete older.snapshot.theme.negativePrompt
  const legacy=assemblePrompt(older)
  assert.match(legacy.text,/SHARED FALLBACK COMPOSITION/);assert.equal(legacy.selectedReference.compositionSource,'shared')
  const mixed=await ws.themes.save({...base,name:'Mixed reference and fallback',referenceInstructions:[theme.referenceInstructions[0]]})
  const mixedProject=await makeProject(mixed)
  assert.ok(!assemblePrompt(mixedProject).text.includes('SHARED FALLBACK COMPOSITION'))
  assert.match(assemblePrompt(mixedProject,undefined,assets[1].id).text,/SHARED FALLBACK COMPOSITION/)
  const allSpecific=await ws.themes.save({...base,name:'No shared fallback needed',compositionPrompt:'',referenceInstructions:theme.referenceInstructions})
  assert.deepEqual(assemblePrompt(await makeProject(allSpecific)).errors,[])
  await assert.rejects(async()=>ws.themes.save({...base,compositionPrompt:'',referenceInstructions:[theme.referenceInstructions[0]]}),/fallback/i)
  await assert.rejects(async()=>ws.themes.save({...base,referenceInstructions:[{...theme.referenceInstructions[0],assetId:assets[0].id}]}),/selected reference/)
  await assert.rejects(async()=>ws.themes.save({...base,referenceInstructions:[theme.referenceInstructions[0],theme.referenceInstructions[0]]}),/one selected/)
  const missing=structuredClone(project);missing.snapshot.theme.images=missing.snapshot.theme.images.filter(x=>x.id!==assets[4].id)
  assert.ok(assemblePrompt(missing).errors.some(e=>/assigned visual reference/.test(e)),'A missing assigned image cannot silently switch to a different reference')
  console.log('PASS per-reference names/compositions/negatives persist, correct image-to-prompt mapping and input roles, no other-reference leakage, heading/bag conflicts removed only where applicable, legacy/mixed fallback, exact request snapshots, duplication/restore and missing-image validation.')
}finally{await runner.close();await ws.close()}
