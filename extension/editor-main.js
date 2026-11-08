// Fixed, nonce-scoped UI operations in Flow's realm. No API/session access,
// trusted-event impersonation, or repeat submission.
export async function editPromptInPage(prompt, nonce) {
  // Keep validation self-contained: Chrome serializes only this function.
  if (!/^[0-9a-f-]{36}$/i.test(nonce) || location.protocol !== 'https:' || !['flow.google.com','labs.google'].includes(location.hostname) || !/\/project\/[a-zA-Z0-9_-]+/.test(location.pathname) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 150000) throw new Error('Invalid scoped Flow prompt edit.')
  const matches=[...document.querySelectorAll('[data-frame-edit]')].filter(e=>e.getAttribute('data-frame-edit')===nonce && (e instanceof HTMLTextAreaElement || e.isContentEditable))
  if(matches.length!==1) throw new Error('The marked Flow editor is no longer unique.')
  const editor=matches[0], compact=value=>String(value||'').replace(/[\u200b-\u200f\ufeff]/g,'').replace(/\s+/g,' ').trim()
  const text=()=>editor instanceof HTMLTextAreaElement?editor.value:editor.innerText
  // Inserting identical text can legitimately return false from execCommand.
  // It is already retained: avoid modifying or duplicating the existing prompt.
  if(compact(text())===compact(prompt)) return {retained:true,changed:false}
  editor.focus()
  if(editor instanceof HTMLTextAreaElement){
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,prompt)
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:prompt}))
    editor.dispatchEvent(new Event('change',{bubbles:true}))
  }else{
    const range=document.createRange();range.selectNodeContents(editor)
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)
    document.execCommand('insertText',false,prompt)
    // Background tabs can refuse execCommand selection. Angular's editable
    // input still receives its own DOM/input transaction, scoped to this nonce.
    if(compact(text())!==compact(prompt)){
      editor.replaceChildren(document.createTextNode(prompt))
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:prompt}))
      editor.dispatchEvent(new Event('change',{bubbles:true}))
    }
  }
  await new Promise(resolve=>setTimeout(resolve,150))
  if(!editor.isConnected || compact(text())!==compact(prompt)) throw new Error('Flow did not retain the complete prompt. Nothing was submitted.')
  return {retained:true,changed:true}
}
