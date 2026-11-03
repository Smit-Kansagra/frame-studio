// Production tab router with isolated Chrome API mocks; no user tabs/account.
import assert from 'node:assert/strict'
import { ProjectTabs } from '../extension/project-tabs.js'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333'
const origin='https://flow.google.com',urlA=`${origin}/project/A`,urlB=`${origin}/project/B`
const tabs=new Map(),saved={},created=[]
let sequence=0
const allowed=value=>{try{const u=new URL(value);return ['flow.google.com','labs.google'].includes(u.hostname)&&u.protocol==='https:'}catch{return false}}
const api={storage:{session:{async get(){return structuredClone(saved)},async set(value){Object.assign(saved,structuredClone(value))}}},tabs:{async create(options){const tab={...options,id:++sequence,status:'complete'};tabs.set(tab.id,tab);created.push(tab.id);return tab},async get(id){if(!tabs.has(id))throw Error('No tab');return tabs.get(id)}}}
let router=new ProjectTabs(api,allowed)
const first=await router.select(a,'createProject',undefined,origin,7)
assert.equal(tabs.get(first.tabId).url,`${origin}/`)
tabs.get(first.tabId).url=urlA;await router.created(first,urlA)
const second=await router.select(b,'createProject',undefined,origin,7)
assert.notEqual(first.tabId,second.tabId)
tabs.get(second.tabId).url=urlB;await router.created(second,urlB)
assert.equal((await router.select(a,'prepare',urlA,origin,7)).tabId,first.tabId)
assert.equal((await router.select(b,'prepare',urlB,origin,7)).tabId,second.tabId)
await assert.rejects(()=>router.select(a,'prepare',urlB,origin,7),/mismatch/)
await assert.rejects(()=>router.select(c,'results',urlA,origin,7),/already owned/)
await assert.rejects(()=>router.select(a,'createProject',undefined,origin,7),/already requested/)
const before=created.length
tabs.get(first.tabId).url=urlB
await assert.rejects(()=>router.select(a,'results',urlA,origin,7),/URL changed/)
assert.equal(tabs.get(first.tabId).url,urlB,'Never repurpose a tab navigated by the user')
assert.equal(created.length,before)
tabs.get(first.tabId).url=urlA
router=new ProjectTabs(api,allowed)
assert.equal((await router.select(a,'results',urlA,origin,7)).tabId,first.tabId,'Reconnect retains the same binding')
tabs.delete(first.tabId);await router.removed(first.tabId)
const reopened=await router.select(a,'results',urlA,origin,7)
assert.notEqual(reopened.tabId,first.tabId);assert.equal(tabs.get(reopened.tabId).url,urlA)
assert.equal(tabs.get(second.tabId).url,urlB,'Closing A does not navigate B')
const uncertain=await router.select(c,'createProject',undefined,origin,7)
tabs.delete(uncertain.tabId);await router.removed(uncertain.tabId)
router=new ProjectTabs(api,allowed)
await assert.rejects(()=>router.select(c,'createProject',undefined,origin,7),/already requested/)
const recovered=await router.select(c,'nameProject',`${origin}/project/recovered-C`,origin,7)
assert.equal(recovered.url,`${origin}/project/recovered-C`)
await assert.rejects(()=>router.select(a,'results',urlA,'https://labs.google',7),/another Flow origin/)
await assert.rejects(()=>router.select('not-an-id','prepare',urlA,origin,7),/Invalid project/)
console.log('PASS separate tabs per UUID, immutable URL ownership, wrong-tab/cross-project refusal, reconnect persistence, closed-tab reopening of saved URL, uncertain creation not repeated, explicit link recovery and origin isolation.')
