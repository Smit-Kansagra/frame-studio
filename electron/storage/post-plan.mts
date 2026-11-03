import type { ProductPhoto, ProjectInfo, ThemeReferenceInstructions } from '../contracts.cjs'
import { referenceInstructions } from './theme-references.mjs'

export type PostPhoto = { id: string; index: number; name: string; product: ProductPhoto; reference: ProductPhoto | null; instructions: ThemeReferenceInstructions | null }

// The first slot keeps the old Post identifier so existing results/approvals
// remain available. Every other slot is tied to its immutable uploaded asset.
export function postPhotos(project: ProjectInfo): PostPhoto[] {
  if (project.outputType !== 'post') return []
  const theme = project.snapshot.theme
  const references = theme.referenceAssetIds
  const cover = theme.coverAssetId && references.includes(theme.coverAssetId) ? theme.coverAssetId : null
  const limited = cover !== null && theme.coverUseCount !== undefined
  const others = references.filter(id => id !== cover)
  const selectedReference = (index: number): string | null => {
    if (!limited) return references.length ? references[index % references.length] : null
    if (theme.coverUseCount === 'unlimited' || index < (theme.coverUseCount as number)) return cover
    const offset = index - (theme.coverUseCount as number)
    return others.length ? others[offset % others.length] : null
  }
  return project.snapshot.product.photos.map((product, index) => ({
    id: index === 0 ? 'post' : product.id,
    index,
    name: `Product ${index + 1}: ${product.originalName}`,
    product,
    reference: selectedReference(index) ? theme.images.find(image => image.id === selectedReference(index)) ?? null : null,
    instructions: selectedReference(index) ? referenceInstructions(theme, selectedReference(index)!, theme.images.find(image => image.id === selectedReference(index))?.originalName ?? 'Unavailable reference') : null,
  }))
}
