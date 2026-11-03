// Focused extension download association checks; no app/database or generation.
import assert from 'node:assert/strict'
import { captureOriginal, safeMediaUrl, matchesOriginalName } from '../extension/result-download.js'
const projectUrl='https://flow.google.com/project/existing-result'
const mediaId='981ed90b-1ef1-4f17-9230-13158641ff87'
const nonce='11111111-1111-4111-8111-111111111111'
const listeners=new Set()
const api={onDeterminingFilename:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}
const item=(changes={})=>({id:7,url:`https://flow-content.google/image/${mediaId}?signed=1`,filename:'Woman_taking_mirror_selfie.jpg',referrer:projectUrl,startTime:new Date().toISOString(),...changes})
function emit(value){const suggestions=[];for(const fn of listeners)fn(value,suggestion=>suggestions.push(suggestion));return suggestions}
assert.equal(safeMediaUrl('https://evil.example/file.jpg',new URL(projectUrl).origin),false)
assert.equal(safeMediaUrl('https://flow-content.google.evil.example/file.jpg',new URL(projectUrl).origin),false)
assert.equal(safeMediaUrl('https://flow-content.google/image/a',new URL(projectUrl).origin),true)
const title='Woman taking mirror selfie fashion', filename='Woman_taking_mirror_selfie_fashion_20261025213408.jpg'
assert.equal(matchesOriginalName(filename,title),true)
assert.equal(matchesOriginalName('Other_photo_20261025213408.jpg',title),false)
assert.equal(matchesOriginalName('Woman_taking_mirror_selfie_fashion_extra_20261025213408.jpg',title),false)
const currentName='Woman_taking_mirror_selfie_fashion_981ed90b (1).jpg'
assert.equal(matchesOriginalName(currentName,title,mediaId),true)
assert.equal(matchesOriginalName(currentName,title),false,'A short ID needs the selected media ID')
assert.equal(matchesOriginalName(currentName,title,'11111111-1111-4111-8111-111111111111'),false)
assert.equal(matchesOriginalName('Other_photo_981ed90b.jpg',title,mediaId),false)
assert.equal(matchesOriginalName('Woman_taking_mirror_selfie_fashion_981ed90.jpg',title,mediaId),false)
assert.equal(matchesOriginalName('Woman_taking_mirror_selfie_4bf7b01f.jpg','Woman taking mirror selfie','4bf7b01f-505b-4cb9-a018-9d18b49b346b'),true)
let currentSuggestion
const current=await captureOriginal(api,{projectUrl,mediaId,nonce,title},async()=>{
  const url='blob:https://flow.google.com/22222222-2222-4222-8222-222222222222'
  assert.deepEqual(emit(item({url,referrer:'',filename:currentName.replace('981ed90b','11111111')})),[undefined])
  assert.deepEqual(emit(item({url,referrer:'https://flow.google.com/project/another',filename:currentName})),[undefined])
  currentSuggestion=emit(item({url,referrer:'',filename:currentName}))
})
assert.equal(await current.run(),7)
assert.deepEqual(currentSuggestion,[{filename:`Frame Studio/${nonce}.jpg`,conflictAction:'uniquify'}]);current.dispose()
let blobSuggestion
const blob=await captureOriginal(api,{projectUrl,mediaId,nonce,title},async()=>{
  const url='blob:https://flow.google.com/22222222-2222-4222-8222-222222222222'
  assert.deepEqual(emit(item({url,referrer:'https://flow.google.com/project/another',filename})),[undefined])
  assert.deepEqual(emit(item({url,referrer:'',filename:'Other_photo_20261025213408.jpg'})),[undefined])
  assert.deepEqual(emit(item({url:'https://flow-content.google/image/33333333-3333-4333-8333-333333333333',referrer:'',filename})),[undefined])
  blobSuggestion=emit(item({url,referrer:'',filename}))
})
assert.equal(await blob.run(),7)
assert.deepEqual(blobSuggestion,[{filename:`Frame Studio/${nonce}.jpg`,conflictAction:'uniquify'}]);blob.dispose()
let suggested
const capture=await captureOriginal(api,{projectUrl,mediaId,nonce},async()=>{
  assert.deepEqual(emit(item({url:'https://evil.example/a.jpg',referrer:projectUrl})),[undefined])
  assert.deepEqual(emit(item({url:'https://flow-content.google/image/other',referrer:'https://flow.google.com/project/another'})),[undefined])
  assert.deepEqual(emit(item({startTime:'2000-01-01T00:00:00Z'})),[undefined])
  suggested=emit(item())
})
assert.equal(await capture.run(),7)
assert.deepEqual(suggested,[{filename:`Frame Studio/${nonce}.jpg`,conflictAction:'uniquify'}])
capture.assertUnique();capture.dispose();assert.equal(listeners.size,0)
const duplicate=await captureOriginal(api,{projectUrl,mediaId,nonce},async()=>{emit(item());emit(item({id:8}))})
await assert.rejects(duplicate.run(),/Ambiguous/);assert.equal(listeners.size,0)
const failed=await captureOriginal(api,{projectUrl,mediaId,nonce},async()=>{throw new Error('UI unavailable')})
await assert.rejects(failed.run(),/UI unavailable/);assert.equal(listeners.size,0)
console.log('PASS original and blob downloads: exact title, project/media association, unrelated files excluded, duplicates rejected, nonce staging; no generation submitted.')
