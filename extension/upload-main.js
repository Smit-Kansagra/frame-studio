// A fixed upload operation, not an arbitrary page-script endpoint. Executed in
// the explicitly paired Flow tab so File/DataTransfer/events use Flow's realm.
export function uploadInPage(file, nonce) {
  if (!/^[0-9a-f-]{36}$/i.test(nonce) || !file || typeof file.name !== 'string' || file.name.length > 200 || /[\\/]/.test(file.name) || !['image/jpeg','image/png','image/webp'].includes(file.type) || typeof file.base64 !== 'string' || file.base64.length > 28000000) throw new Error('Invalid scoped reference upload.')
  const inputs=[...document.querySelectorAll('input[type="file"]')].filter(input=>input.getAttribute('data-frame-upload')===nonce)
  if(inputs.length!==1 || inputs[0].disabled) throw new Error('The marked Flow upload input is no longer unique and enabled.')
  const input=inputs[0], transfer=new DataTransfer()
  const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))
  transfer.items.add(new File([bytes],file.name,{type:file.type}))
  input.files=transfer.files
  const assigned=input.files.length===1 && input.files[0].name===file.name
  if(!assigned) throw new Error('Flow input did not retain the reference file.')
  // A real file chooser emits both events. Do not impersonate trusted events,
  // modify browser security, or call any Google/internal upload API.
  input.dispatchEvent(new Event('input',{bubbles:true,composed:true}))
  input.dispatchEvent(new Event('change',{bubbles:true,composed:true}))
  input.removeAttribute('data-frame-upload')
  return {assigned:true,connectedAfterEvents:input.isConnected}
}
