import type { ProjectInfo } from '../electron/contracts.cjs'
import type { PromptPreview } from '../electron/storage/prompt-core.mjs'
import { reelSettingsLabel } from '../electron/storage/reel-plan.mjs'
import { Photo } from './Products'

export function ReelPromptPreview({ project, preview }: { project: ProjectInfo; preview: PromptPreview }) {
  const { theme, product, character } = project.snapshot
  const storyboard = theme.images.find(photo => photo.id === theme.storyboardAssetId)
  const photos = [...product.photos, ...theme.images, ...(character?.photos ?? [])]
  return <section className="reel-prompt-preview" aria-label="Storyboard, references and final reel prompt">
    <div className="scene-preview-heading"><h4>Storyboard photo</h4><span>One final reel · 15 seconds</span></div>
    {storyboard ? <div className="reel-storyboard-photo"><Photo photo={storyboard} name="Reel storyboard photo" original /></div> : <p className="project-helper">Add a storyboard photo in the selected theme.</p>}
    <h4>All references</h4><div className="project-reference-strip">{preview.references.map(reference => {
      const photo = photos.find(photo => photo.id === reference.id)
      const role = reference.mediaType === 'video' ? 'Video' : reference.id === theme.storyboardAssetId ? 'Storyboard' : product.photos.some(photo => photo.id === reference.id) ? 'Product' : character?.photos.some(photo => photo.id === reference.id) ? 'Character' : 'Theme'
      return <div className="project-reference" key={reference.id}>{reference.mediaType === 'video' ? <video controls preload="metadata" src={reference.thumbnailUrl} aria-label={reference.name} /> : photo && <Photo photo={photo} name={reference.name} />}<span>{role} · {reference.name}</span>{!reference.available && <small>Unavailable</small>}</div>
    })}</div>
    <p className="reel-flow-settings">{reelSettingsLabel}</p>
    <div className="scene-preview-heading"><h4>Final prompt</h4></div><pre className="assembled-prompt" tabIndex={0}>{preview.text}</pre>
  </section>
}
