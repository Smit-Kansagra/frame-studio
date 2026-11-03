// Cover-only per-project assignment quotas; no Chrome/account/Flow credits.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { postPhotos } from '../dist-electron/storage/post-plan.mjs'
import { assemblePrompt } from '../dist-electron/storage/prompt-core.mjs'
import { FlowScheduler } from '../dist-electron/flow-scheduler.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-cover-count-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const assets=[]
for(let i=0;i<8;i++){const file=path.join(root,`${i}.png`);await writeFile(file,await sharp({create:{width:24,height:32,channels:3,background:{r:20+i*25,g:60,b:90}}}).png().toBuffer());assets.push(await ws.importImage(file))}
const product=await ws.products.save({name:'Five products',description:'',notes:'',assetIds:assets.slice(0,5).map(x=>x.id),primaryAssetId:assets[0].id})
const cover=assets[5].id,a=assets[6].id,b=assets[7].id
const base={name:'Cover quota',description:'',coverAssetId:cover,referenceAssetIds:[a,cover,b],masterPrompt:'Shared direction',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'SHARED_FALLBACK',scenes:[],referenceInstructions:[{assetId:cover,name:'Cover',compositionPrompt:'COVER_LAYOUT',negativePrompt:''},{assetId:a,name:'Other A',compositionPrompt:'LAYOUT_A',negativePrompt:''},{assetId:b,name:'Other B',compositionPrompt:'LAYOUT_B',negativePrompt:''}]}
const makeProject=theme=>ws.projects.save({name:'Project with quota',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
const selected=project=>postPhotos(project).map(p=>p.reference?.id??null)
let theme=await ws.themes.save({...base,coverUseCount:2})
const first=await makeProject(theme),second=await makeProject(theme)
assert.deepEqual(selected(first),[cover,cover,a,b,a]);assert.deepEqual(selected(second),selected(first),'Count resets for each project')
for(let i=0;i<5;i++){const slot=postPhotos(first)[i],prompt=assemblePrompt(first,undefined,slot.id);assert.deepEqual(prompt.errors,[]);assert.equal(prompt.selectedReference.assetId,selected(first)[i]);if(i>=2)assert.doesNotMatch(prompt.text,/COVER_LAYOUT/)}
const one={...first,snapshot:{...first.snapshot,theme:{...theme,coverUseCount:1}}}
assert.deepEqual(selected(one),[cover,a,b,a,b])
const zero={...first,snapshot:{...first.snapshot,theme:{...theme,coverUseCount:0}}}
assert.deepEqual(selected(zero),[a,b,a,b,a])
const every={...first,snapshot:{...first.snapshot,theme:{...theme,coverUseCount:'unlimited'}}}
assert.deepEqual(selected(every),Array(5).fill(cover))
const legacy=structuredClone(first);delete legacy.snapshot.theme.coverUseCount
assert.deepEqual(selected(legacy),[a,cover,b,a,cover],'Existing themes retain their original rotation')
const library=structuredClone(first);library.snapshot.theme.referenceAssetIds=[a,b]
assert.deepEqual(selected(library),[a,b,a,b,a],'A library-only cover is never sent implicitly')
const onlyCover=structuredClone(first);onlyCover.snapshot.theme.referenceAssetIds=[cover];onlyCover.snapshot.theme.coverUseCount=1
assert.deepEqual(selected(onlyCover),[cover,null,null,null,null])
const later=assemblePrompt(onlyCover,undefined,assets[1].id)
assert.match(later.text,/SHARED_FALLBACK/);assert.doesNotMatch(later.text,/COVER_LAYOUT/);assert.deepEqual(later.references.map(p=>p.id),[assets[1].id])
onlyCover.storyboard.compositionPrompt=''
assert.ok(assemblePrompt(onlyCover,undefined,assets[1].id).errors.length,'Exhausted cover with no fallback cannot silently repeat or submit an empty composition')
for(const invalid of [-1,1.5,21,NaN,'2','always'])await assert.rejects(async()=>ws.themes.save({...base,coverUseCount:invalid}),/Cover image uses/)
await assert.rejects(async()=>ws.themes.save({...base,coverAssetId:null,coverUseCount:1}),/Choose a cover/)
const requests=[],remote=new Map(),prepared=new Map()
let submits=0
const factory=id=>({
  async createProject(commit){const url=`https://flow.google.com/project/${id}`;await commit(url);return url},async nameProject(){},
  async prepare(_url,request){prepared.set(id,request);requests.push(request);const p=id===first.id?first:second,slot=postPhotos(p).find(s=>s.id===request.sceneId);assert.equal(request.themeReference.assetId,slot.reference.id);assert.ok(request.files[1].includes(slot.reference.id));return [...remote.keys()]},
  async submit(){submits++;remote.set(`quota-${submits}`,{projectId:id,prompt:prepared.get(id).prompt})},
  async results(_url,prompt,_kind,baseline){return [...remote].filter(([key,r])=>r.projectId===id&&r.prompt===prompt&&!baseline.includes(key)).map(([key])=>({id:key,selector:'#result'}))},async download(){return path.join(root,'0.png')},
})
const scheduler=new FlowScheduler(async()=>ws,factory,5,1000)
const settle=async()=>{const end=Date.now()+5000;while(scheduler.busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(scheduler.busy,false)}
try{
  await Promise.all([scheduler.startPosts(first.id),scheduler.startPosts(second.id)]);await settle()
  assert.equal(submits,10)
  for(const p of [first,second])assert.equal(requests.filter(r=>r.projectId===p.id&&r.themeReference.assetId===cover).length,2)
  await scheduler.start(first.id,'post',1);await settle()
  assert.equal(requests.at(-1).themeReference.assetId,cover,'Regeneration keeps the assigned cover without shifting any product')
  const duplicate=await ws.themes.duplicate(theme.id,theme.revision);assert.equal(duplicate.coverUseCount,2)
  const trash=await ws.themes.remove(duplicate.id,duplicate.revision);assert.equal((await ws.themes.undo(trash.token)).coverUseCount,2)
  await scheduler.close();await ws.close();ws=await Workspace.open(folder)
  assert.equal((await ws.themes.get(theme.id)).coverUseCount,2)
  assert.deepEqual(selected(await ws.projects.get(first.id)),[cover,cover,a,b,a])
  assert.equal((await ws.generations.list(first.id)).filter(r=>r.state==='ready-for-review').length,6)
  console.log('PASS cover counts 0/1/2/every-product, per-project reset, other references unchanged, legacy rotation, library-only opt-in, only-cover fallback, invalid counts, parallel request mapping, stable regeneration, duplicate/restore/restart persistence.')
}finally{await scheduler.close();await ws.close()}
