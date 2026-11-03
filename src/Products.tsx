import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProductPhoto } from '../electron/contracts.cjs'
import { Icon } from './icons'


export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return <dialog ref={ref} className={`product-dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="button button-secondary" onClick={onClose} aria-label="Close dialog">Close</button></div>{children}
  </dialog>
}

export function Photo({ photo, original = false, name }: { photo: ProductPhoto; original?: boolean; name?: string }) {
  const [failed, setFailed] = useState(false)
  const available = original ? photo.available : photo.thumbnailAvailable
  return available && !failed ? <img src={original ? photo.originalUrl : photo.thumbnailUrl} alt={name ?? photo.originalName} loading={original ? 'eager' : 'lazy'} onError={() => setFailed(true)} /> : <div className="photo-unavailable"><Icon name="image" size={28} /><span>Image unavailable</span></div>
}

export function Preview({ photos, initial, title, onClose }: { photos: ProductPhoto[]; initial: string; title: string; onClose: () => void }) {
  const [active, setActive] = useState(initial)
  const photo = photos.find(item => item.id === active) ?? photos[0]
  const rotated = photo.orientation >= 5
  return <Dialog title={title} onClose={onClose} wide>
    <div className="full-photo"><Photo key={photo.id} photo={photo} original /></div>
    <div className="preview-caption"><span>{photo.originalName}</span><span>{rotated ? photo.height : photo.width} × {rotated ? photo.width : photo.height} · {photo.format.toUpperCase()}</span></div>
    <div className="preview-strip" aria-label="Photographs">{photos.map((item, index) => <button type="button" className={item.id === photo.id ? 'preview-thumb is-selected' : 'preview-thumb'} key={item.id} aria-label={`View photo ${index + 1}`} aria-pressed={item.id === photo.id} onClick={() => setActive(item.id)}><Photo photo={item} />{item.id === photo.id && <Icon name="check" size={14} />}</button>)}</div>
  </Dialog>
}
