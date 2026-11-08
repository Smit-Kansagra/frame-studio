// Production tab router with isolated Chrome API mocks; no user tabs/account.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import { ProjectTabs, retryTabEdit } from '../extension/project-tabs.js'
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
// Delayed session writes must not drop bindings when several projects create
// their tabs and commit Flow URLs at the same time.
let writes=0
api.storage.session.set=async value=>{await new Promise(resolve=>setTimeout(resolve,++writes%2?3:1));Object.assign(saved,structuredClone(value))}
const concurrent=Array.from({length:9},()=>randomUUID())
let tabBusy=0
assert.equal(await retryTabEdit(async()=>{if(++tabBusy<3)throw Error('Tabs cannot be edited right now (user may be dragging a tab).');return 'activated'}),'activated');assert.equal(tabBusy,3)
let refused=0;await assert.rejects(()=>retryTabEdit(async()=>{refused++;throw Error('No tab with id 100')}),/No tab/);assert.equal(refused,1,'Missing tabs are not blindly retried')
const contexts=await Promise.all(concurrent.map(id=>router.select(id,'createProject',undefined,origin,7)))
assert.equal(new Set(contexts.map(c=>c.tabId)).size,9)
await Promise.all(contexts.map(context=>{const url=`${origin}/project/${context.projectId}`;tabs.get(context.tabId).url=url;return router.created(context,url)}))
router=new ProjectTabs(api,allowed)
for(const context of contexts)assert.equal((await router.select(context.projectId,'prepare',`${origin}/project/${context.projectId}`,origin,7)).tabId,context.tabId)
console.log('PASS nine simultaneous tab creations retain distinct persistent bindings; immutable URL ownership, wrong-tab refusal, reconnect/reopen recovery, uncertain creation not repeated and origin isolation.')
