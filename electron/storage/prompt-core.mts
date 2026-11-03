import type { ProjectInfo, ProjectScene, ThemeReferenceSelection } from '../contracts.cjs'
import { postPhotos } from './post-plan.mjs'
import { compositionCompatibleShared } from './theme-references.mjs'

export type PromptPreview = { text: string; errors: string[]; warnings: string[]; references: { id: string; name: string; thumbnailUrl: string; available: boolean }[]; selectedReference?: ThemeReferenceSelection }
const ratios: Record<ProjectInfo['preset'], string> = {
  'reel-vertical': '9:16', 'reel-landscape': '16:9', 'post-square': '1:1', 'post-portrait': '4:5', 'post-story': '9:16', 'post-tall': '3:4', 'post-landscape': '1.91:1',
}
const allowed = new Set(['product_name', 'product_description', 'product_notes', 'character_name', 'character_prompt', 'scene_number', 'scene_prompt', 'aspect_ratio', 'target_duration'])
function resolve(template: string, values: Record<string, string>, errors: string[]): string {
  const remainder = template.replace(/{{[^{}]*}}/g, '')
  if (remainder.includes('{{') || remainder.includes('}}')) errors.push('A placeholder is missing a matching pair of braces.')
  const result = template.replace(/{{([^{}]*)}}/g, (_match, raw: string) => {
    const key = raw.trim()
    if (!allowed.has(key)) { errors.push(`Unknown placeholder {{${key}}}.`); return '' }
    if (!(key in values)) { errors.push(`Placeholder {{${key}}} has no value in this project.`); return '' }
    return values[key]
  })
  return result.trim()
}
function personLanguage(text: string): boolean { return /\b(person|people|character|woman|women|man|men|girl|boy|face|portrait|hands|human|presenter|model)\b/i.test(text) }
export function assemblePrompt(project: ProjectInfo, scene?: ProjectScene, postId = 'post'): PromptPreview {
  const errors: string[] = [], warnings: string[] = []
  const theme = project.snapshot.theme, product = project.snapshot.product, character = project.snapshot.character
  const posts = postPhotos(project), post = posts.find(item => item.id === postId)
  const inputPhotos = [...(project.outputType === 'post' ? (post ? [post.product, ...(post.reference ? [post.reference] : [])] : []) : [...product.photos, ...theme.images]), ...(character?.photos ?? [])].filter((photo, index, all) => all.findIndex(item => item.id === photo.id) === index)
  const inputNumber = (id: string) => inputPhotos.findIndex(photo => photo.id === id) + 1
  if (project.outputType === 'post' && !post) errors.push('Choose a product photo from this saved project.')
  if (post?.instructions && !post.reference) errors.push('The assigned visual reference image is unavailable. Restore it before generating this product.')
  const ownComposition = post?.instructions?.compositionPrompt.trim()
  const composition = scene?.prompt ?? (ownComposition || project.storyboard.compositionPrompt)
  const number = scene ? project.storyboard.scenes.findIndex(item => item.id === scene.id) + 1 : (post?.index ?? 0) + 1
  const values: Record<string, string> = {
    product_name: product.name, product_description: product.description, product_notes: product.notes,
    // Old templates may contain these placeholders; keep them readable but do not
    // send character text to Flow. Character references are supplied as photos below.
    character_name: '', character_prompt: '',
    scene_number: String(number), scene_prompt: composition, aspect_ratio: ratios[project.preset], target_duration: project.outputType === 'reel' ? `${scene?.sourceDuration ?? project.duration}s` : 'not applicable',
  }
  const resolvedComposition = resolve(composition, { ...values, scene_prompt: '' }, errors)
  values.scene_prompt = resolvedComposition
  const shared = resolve(theme.masterPrompt, values, errors)
  const blocks = [`Shared creative direction:\n${project.outputType === 'post' ? compositionCompatibleShared(shared, resolvedComposition) : shared}`]
  const factual = [`Product: ${product.name}`, product.description && `Description: ${product.description}`, product.notes && `Preservation notes: ${product.notes}`].filter(Boolean).join('\n')
  blocks.push(factual)
  if (post) {
    blocks.push(`Product photo ${number} of ${posts.length}: ${post.product.originalName}. Generate exactly one still image of this product. The first attached image is the product to preserve; retain its design, colour, shape, labels and other defining details. Do not combine different products. Follow the selected composition for any inset or multi-panel layout.`)
    if (post.reference) blocks.push(`Theme reference: ${post.instructions?.name ?? post.reference.originalName}. Input image ${inputNumber(post.reference.id)} is the selected theme reference for layout, pose, framing, background, lighting, and the accessories/text specified in this composition. Follow only this selected reference and its composition instructions. Its selected composition overrides conflicting generic shared layout/accessory/text restrictions. It does not define the product design or the selected character's identity.`)
    blocks.push('Product images: Input image 1 is the assigned product photograph. Preserve its exact design, colour, fabric/material, pattern, shape, neckline, sleeves, length, construction, embroidery, print and labels where present. Do not replace these details with the theme reference’s product. Composition-specified accessories may be included without changing the product design.')
    blocks.push(character?.photos.length ? `Character references: Input images ${character.photos.map(photo => inputNumber(photo.id)).join(', ')} show the selected character. Preserve that character’s identity, facial features, skin tone, hair and body proportions. Use the theme reference for pose and layout, not its model’s identity.` : 'Character references: none selected. The theme reference supplies composition rather than an instruction to copy its model’s identity.')
  }
  blocks.push(scene ? `Scene ${number}: ${scene.name}\n${resolvedComposition}` : `Composition (${ownComposition ? 'selected reference' : 'shared fallback'}): ${resolvedComposition}`)
  const sharedNegative = resolve(theme.negativePrompt ?? '', values, errors)
  const applicableSharedNegative = project.outputType === 'post' ? compositionCompatibleShared(sharedNegative, resolvedComposition) : sharedNegative
  if (applicableSharedNegative) blocks.push(`Shared negative prompt:\n${applicableSharedNegative}`)
  const selectedNegative = post?.instructions?.negativePrompt ? resolve(post.instructions.negativePrompt, values, errors) : ''
  if (selectedNegative) blocks.push(`Selected reference negative prompt:\n${selectedNegative}`)
  if (scene) blocks.push(scene.relationship === 'continue'
    ? 'Continuity: Continue the visual continuity of the preceding scene. Preserve the established subject appearance, outfit, product details, and setting where applicable.'
    : 'Continuity: Treat this as a new shot. Follow the saved references and project details without assuming a previous scene.')
  blocks.push(project.outputType === 'reel' ? `Output: Video · ${ratios[project.preset]} aspect ratio · requested source clip length ${scene?.sourceDuration ?? project.duration}s, subject to available Flow controls. Final timeline target: ${project.duration}s.` : `Output: Still image · ${ratios[project.preset]} aspect ratio.`)
  const sourceText = [theme.masterPrompt, composition, scene?.prompt ?? ''].join('\n')
  if (project.outputType === 'reel') {
    const total = project.storyboard.scenes.reduce((sum, item) => sum + item.editDuration, 0)
    if (Math.abs(total - project.duration) > 0.005) errors.push(`Timeline edit durations total ${Number(total.toFixed(3))}s, but the final target is ${project.duration}s. Adjust timeline edit durations or deliberately use their total as the target.`)
  }
  if (!character && personLanguage(sourceText)) warnings.push('Product only is selected, but the theme text mentions a person. Review the wording before using this prompt.')
  const references = inputPhotos.map(photo => ({ id: photo.id, name: photo.originalName, thumbnailUrl: photo.thumbnailUrl, available: photo.available }))
  return { text: blocks.filter(Boolean).join('\n\n'), errors: [...new Set(errors)], warnings, references, ...(post?.instructions ? { selectedReference: { ...post.instructions, compositionPrompt: resolvedComposition, negativePrompt: selectedNegative, compositionSource: ownComposition ? 'reference' : 'shared' } as ThemeReferenceSelection } : {}) }
}
