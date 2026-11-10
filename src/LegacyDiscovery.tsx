import { useEffect, useRef, useState } from 'react'
import type { DiscoverySettings, DiscoveryState, ProductMarketplace } from '../electron/contracts.cjs'
import './product-find.css'
const initial:DiscoverySettings={youtubeKey:'',geminiKey:'',ai:'antigravity',model:'',channels:'',pages:[]}
export function LegacyDiscovery(){
  const api=window.frameStudio?.discovery
  const [state,setState]=useState<DiscoveryState|null>(null),[settings,setSettings]=useState(initial),[pageId,setPageId]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const initialized=useRef(false)
  useEffect(()=>{if(!api)return;let active=true,pending=false;const refresh=async()=>{if(pending)return;pending=true;try{const s=await api.status();if(active){setState(s);if(!initialized.current){initialized.current=true;setSettings(s.settings);setPageId(s.settings.pages[0]?.id??'')}}}catch(e){if(active)setError(e instanceof Error?e.message:'Could not load discovery.')}finally{pending=false}};void refresh();const timer=setInterval(()=>void refresh(),2500);return()=>{active=false;clearInterval(timer)}},[api])
  const page=settings.pages.find(p=>p.id===pageId),running=state?.job.state==='running',locked=busy||running
  const patchPage=(patch:Partial<DiscoverySettings['pages'][number]>)=>setSettings(s=>({...s,pages:s.pages.map(p=>p.id===pageId?{...p,...patch}:p)}))
  async function action(work:()=>Promise<unknown>,message=''){setBusy(true);setError('');setNotice('');try{await work();if(api)setState(await api.status());setNotice(message)}catch(e){setError(e instanceof Error?e.message:'Action failed.')}finally{setBusy(false)}}
  const save=async()=>{await api!.save(settings);setSettings(s=>({...s,youtubeKey:'',geminiKey:''}))}
  const products=state?.products.filter(p=>p.pageId===pageId)??[]
  return <div className="product-find">
    <section className="find-setup">
      <div className="find-heading"><h2>Product Find</h2><span className="neutral-badge">Manual Instagram upload</span></div>
      <p>Collect recent YouTube product mentions, save original retailer photos and links, and organize them by Instagram page. Create EarnKaro links manually.</p>
      {!api&&<p>Open the desktop app to use discovery.</p>}
      <fieldset disabled={!api||locked} className="discovery-fields"><legend>Instagram pages</legend>
        <label>Choose page<select value={pageId} onChange={e=>setPageId(e.target.value)}><option value="">Select a page</option>{settings.pages.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button className="button button-secondary" disabled={settings.pages.length>=30} onClick={()=>{const id=crypto.randomUUID();setSettings(s=>({...s,pages:[...s.pages,{id,name:'New page',query:'',platforms:['myntra','meesho','flipkart'],lookbackDays:14,autoRefresh:false}]}));setPageId(id)}}>Add page</button>
        {page&&<><label>Page name<input value={page.name} maxLength={100} onChange={e=>patchPage({name:e.target.value})}/></label><label>Niche / search terms<input value={page.query} maxLength={200} placeholder="aesthetic tops women" onChange={e=>patchPage({query:e.target.value})}/></label>
        <div className="find-marketplaces">{(['myntra','meesho','flipkart','amazon'] as ProductMarketplace[]).map(p=><label key={p}><input type="checkbox" checked={page.platforms.includes(p)} onChange={e=>patchPage({platforms:e.target.checked?[...page.platforms,p]:page.platforms.filter(x=>x!==p)})}/>{p}</label>)}</div>
        <label>Recent evidence<select value={page.lookbackDays} onChange={e=>patchPage({lookbackDays:Number(e.target.value) as 7|14})}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option></select></label>
        <label className="find-repeat"><input type="checkbox" checked={page.autoRefresh} onChange={e=>patchPage({autoRefresh:e.target.checked})}/>Discover every 6 hours while app is open</label></>}
      </fieldset>
      <details><summary>Data source and AI setup</summary><fieldset disabled={!api||locked} className="discovery-fields"><legend>Discovery settings</legend>
        <label>YouTube Data API key {state?.settings.hasYoutubeKey?'(saved securely; blank keeps it)':''}<input type="password" autoComplete="off" value={settings.youtubeKey} onChange={e=>setSettings(s=>({...s,youtubeKey:e.target.value}))}/></label>
        <p>Enable YouTube Data API v3 in your Google Cloud project. This key supplies real video dates, views and description links.</p>
        <label>Creator watchlist: channel IDs (optional)<textarea rows={3} value={settings.channels} placeholder="UC... (one channel ID per line, maximum 10)" onChange={e=>setSettings(s=>({...s,channels:e.target.value}))}/></label>
        <p>Blank watchlist searches YouTube by niche. With a watchlist, search stays inside those channels.</p>
        <label>Shortlist filter<select value={settings.ai} onChange={e=>setSettings(s=>({...s,ai:e.target.value as DiscoverySettings['ai'],model:''}))}><option value="antigravity">Authenticated Antigravity account - credit overages disabled</option><option value="none">Code only - no LLM tokens</option></select></label>
        <p>Uses the official signed-in CLI with verified session credit overages off. No local LLM, API key or paid fallback. Account quota errors pause reasoning.</p>
      </fieldset></details>
      <div className="find-actions"><button className="button button-secondary" disabled={!api||locked} onClick={()=>void action(save,'Settings saved.')}>Save settings</button><button className="button button-primary" disabled={!api||locked||!page} onClick={()=>void action(async()=>{await save();await api!.start(pageId)},'Discovery started.')}>Save and find products</button>{running&&<button className="button button-secondary" disabled={busy} onClick={()=>void action(()=>api!.cancel(),'Stopping discovery...')}>Cancel</button>}</div>
      <p role="status">{state?.job.message}</p>{state?.nextRunAt&&<p>Next automatic run: {new Date(state.nextRunAt).toLocaleString()}</p>}
      <details><summary>Selection and limits</summary><p>Products come from marketplace detail links and supported short links in recent YouTube descriptions. Ranking uses creator mentions and views per day since publication. These are candidates, not guaranteed viral products. AI only filters relevance; it cannot add links or evidence.</p><p>Common product short links are resolved within a 30-link budget per run. Link hubs requiring JavaScript, comment links and Instagram research are not collected. Some retailers block photo extraction. Stock, buying-intent comments and video-to-listing identity are not verified. Old products stay in each page library with their discovery date.</p><p>Research is sequential across scheduled pages. Photo extraction reuses recent shared product data. Affiliate conversion and Instagram publishing remain manual.</p></details>
      {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="prompt-validation-error">{error}</p>}
    </section>
    <div className="find-heading"><h2>{page?.name??'Choose a page'} ({products.length})</h2></div>
    <div className="find-grid">{products.map(p=><article className="find-card" key={p.product_url}><div className="find-photo"><img src={p.image_url} alt="Original product photo" loading="lazy" referrerPolicy="no-referrer"/></div><p className="find-url">{p.product_url}</p><p className="muted">{p.state} - Found {new Date(p.foundAt).toLocaleDateString()} - {new Set(p.sources.map(s=>s.creator)).size} creator(s)</p><div className="find-actions"><button className="button button-primary" disabled={busy} onClick={()=>void action(()=>api!.download(pageId,p.product_url),'Photo save finished.')}>Download photo</button><button className="button button-secondary" disabled={busy} onClick={()=>void action(()=>api!.copy(pageId,p.product_url),'Original link copied. Paste it into EarnKaro.')}>Copy original link</button><button className="button button-secondary" disabled={busy||p.state==='posted'} onClick={()=>void action(()=>api!.markPosted(pageId,p.product_url),'Marked as manually posted.')}>Mark posted</button></div></article>)}</div>
    {!products.length&&<div className="find-empty">Add a page, configure your YouTube API key, then choose Save and find products.</div>}
  </div>
}

