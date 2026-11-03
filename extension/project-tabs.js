const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const pause = () => new Promise(resolve => setTimeout(resolve, 100))
export function sameProject(first, second) {
  try { const a=new URL(first),b=new URL(second);return a.origin===b.origin && a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'') && /\/project\/[a-zA-Z0-9_-]+$/.test(a.pathname.replace(/\/$/,'')) } catch { return false }
}
/** Persistent project UUID -> owned tab + immutable Flow URL. Titles/names and
 * the user's current active tab are never used to route a command. */
export class ProjectTabs {
  records = new Map()
  constructor(api, allowed) { this.api=api;this.allowed=allowed }
  async load() {
    if (!this.loading) this.loading=(async()=>{
      const saved=(await this.api.storage.session.get('frameProjectTabs')).frameProjectTabs || {}
      for(const [id,value] of Object.entries(saved)) {
        if(projectIdPattern.test(id) && value && ['https://flow.google.com','https://labs.google'].includes(value.origin) && (value.tabId===null || Number.isInteger(value.tabId)) && (value.url===null || (this.allowed(value.url)&&sameProject(value.url,value.url)))) this.records.set(id,value)
      }
    })()
    await this.loading
  }
  async save() { await this.api.storage.session.set({frameProjectTabs:Object.fromEntries(this.records)}) }
  owned(url, projectId) { return [...this.records].some(([id,record])=>id!==projectId && record.url && sameProject(record.url,url)) }
  async verify(context, expected) {
    const tab=await this.api.tabs.get(context.tabId)
    if(!this.allowed(tab.url) || new URL(tab.url).origin!==context.origin || (expected && !sameProject(tab.url,expected))) throw new Error('Project tab URL changed or belongs to another project. No upload, submit or result import is allowed. Restore this tab to its saved Flow project URL.')
    return tab
  }
  async ready(tabId, url) {
    const deadline=Date.now()+30000
    while(Date.now()<deadline) {
      const tab=await this.api.tabs.get(tabId)
      if(tab.status==='complete' && (tab.url===url || sameProject(tab.url,url))) return
      if(tab.url && !this.allowed(tab.url)) throw new Error('Project tab left Flow. Finish Google sign-in manually and reconnect.')
      await pause()
    }
    throw new Error('The project tab has not finished loading. Existing work is preserved.')
  }
  async select(projectId, action, url, origin, windowId) {
    if(!projectIdPattern.test(projectId)) throw new Error('Invalid project scope. No tab was selected.')
    await this.load()
    let record=this.records.get(projectId)
    if(record && record.origin!==origin) throw new Error('This project belongs to another Flow origin. Connect its original Chrome workspace.')
    const creating=action==='createProject'
    if(creating && record?.creationStarted) throw new Error('Flow project creation was already requested for this project. Recover its existing URL; a duplicate project will not be created.')
    if(!creating) {
      if(!this.allowed(url) || new URL(url).origin!==origin || !sameProject(url,url)) throw new Error('Invalid scoped Flow project URL.')
      if(record?.url && !sameProject(record.url,url)) throw new Error('Project scope URL mismatch. This command cannot switch another project’s tab.')
      if(this.owned(url,projectId)) throw new Error('This Flow project URL is already owned by another software project.')
    }
    if(!record) { record={tabId:null,origin,url:creating?null:url,creationStarted:creating};this.records.set(projectId,record);await this.save() }
    if(!creating && !record.url) { record.url=url;await this.save() }
    if(creating && record.url) throw new Error('This project already has a Flow URL. Duplicate creation is refused.')
    let tab
    if(Number.isInteger(record.tabId)) { try { tab=await this.api.tabs.get(record.tabId) } catch {} }
    if(tab) {
      await this.verify(record,creating?undefined:record.url)
    } else {
      const home=origin==='https://flow.google.com'?`${origin}/`:'https://labs.google/fx/tools/flow'
      const target=creating?home:record.url
      // Persist creation intent before any remote create click. A closed tab can
      // reopen a known URL, but never retries an uncertain New project action.
      tab=await this.api.tabs.create({url:target,active:false,...(Number.isInteger(windowId)?{windowId}:{})})
      record.tabId=tab.id;await this.save();await this.ready(tab.id,target)
    }
    return {...record,projectId}
  }
  async created(context,url) {
    if(!this.allowed(url) || !sameProject(url,url) || this.owned(url,context.projectId)) throw new Error('New Flow URL is invalid or belongs to another software project. Nothing was uploaded.')
    await this.verify(context,url)
    const record=this.records.get(context.projectId)
    if(record.url && !sameProject(record.url,url)) throw new Error('Existing project association cannot be replaced.')
    record.url=url;record.creationStarted=true;await this.save();context.url=url
  }
  async removed(tabId) {
    await this.load()
    for(const record of this.records.values()) if(record.tabId===tabId) record.tabId=null
    await this.save()
  }
}
