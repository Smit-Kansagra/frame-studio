import type { ProductPhoto, ThemeContent, ThemeReferenceInstructions, ThemeReferenceSelection } from '../electron/contracts.cjs'
import { referenceInstructions } from '../electron/storage/theme-references.mjs'
import { Photo } from './Products'

export function ReferenceInstructionsEditor({ theme, images, onChange }: { theme: ThemeContent; images: ProductPhoto[]; onChange: (assetId: string, patch: Partial<ThemeReferenceInstructions>) => void }) {
  return <div className="theme-section"><h3>Reference instructions</h3><p className="field-help">Set the composition for each reference image.</p>{images.map((image, index) => {
    const item = referenceInstructions(theme, image.id, image.originalName)
    return <section className="reference-instructions-editor" key={image.id}>
      <div className="reference-instructions-photo"><Photo photo={image} name={item.name} /><span>{image.originalName}</span></div>
      <div><label className="field-label" htmlFor={`reference-name-${image.id}`}>Reference {index + 1} name</label><input id={`reference-name-${image.id}`} value={item.name} maxLength={120} onChange={event => onChange(image.id, { name: event.target.value })} />
        <label className="field-label" htmlFor={`reference-composition-${image.id}`}>Composition prompt</label><textarea id={`reference-composition-${image.id}`} rows={6} maxLength={20000} value={item.compositionPrompt} onChange={event => onChange(image.id, { compositionPrompt: event.target.value })} placeholder="Layout, pose, framing, background, lighting, accessories and text" />
      </div>
    </section>
  })}{!images.length && <p>Add visual reference images in the panel on the left.</p>}</div>
}

export function ReferencePromptPreview({ selected, images, prompt, productName }: { selected?: ThemeReferenceSelection; images: ProductPhoto[]; prompt: string; productName?: string }) {
  const image = images.find(item => item.id === selected?.assetId)
  return <section className="reference-prompt-preview" aria-label={productName ? `Reference and final prompt for ${productName}` : 'Selected reference and exact final prompt'}>
    <div className="reference-prompt-mapping">{image && <div className="reference-prompt-thumbnail"><Photo key={image.id} photo={image} name={selected!.name} original={!image.thumbnailAvailable} /></div>}<div>{productName && <strong>{productName}</strong>}<p>{selected ? `Theme reference: ${selected.name}` : 'No visual theme reference assigned'}</p>{selected && <small>{selected.compositionSource === 'reference' ? 'Uses this reference’s composition instructions' : selected.compositionPrompt ? 'Uses saved composition' : 'Uses master direction and this reference image'}</small>}</div></div>
    <pre className="assembled-prompt" tabIndex={0}>{prompt}</pre>
  </section>
}
