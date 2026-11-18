import type { ProjectInfo, ProjectStoryboard, ThemeInfo } from '../contracts.cjs'

export const reelSettings = { model: 'Omni Flash 1.2', resolution: '720p', duration: 15, outputs: 1, aspectRatio: '9:16' } as const
export const reelSettingsLabel = 'Video · 9:16 · Omni Flash 1.2 · 720p · 1 clip · 15 seconds'
export const isSingleReel = (project: Pick<ProjectInfo, 'outputType' | 'storyboard'>) => project.outputType === 'reel' && project.storyboard.singleClip === true

export function singleReelStoryboard(theme: ThemeInfo): ProjectStoryboard {
  return { singleClip: true, compositionPrompt: theme.compositionPrompt, scenes: [{
    id: theme.scenes[0]?.id ?? theme.id, name: 'Final reel',
    prompt: theme.scenes.map(scene => scene.prompt).filter(Boolean).join('\n\n') || 'Follow the master prompt and storyboard image.',
    sourceDuration: 15, editDuration: 15, relationship: 'new-shot', transition: 'cut',
  }] }
}

export function reelImages(project: ProjectInfo) {
  const { product, theme, character } = project.snapshot
  const themeIds = new Set([theme.storyboardAssetId, ...theme.referenceAssetIds])
  return [...product.photos, ...theme.images.filter(photo => themeIds.has(photo.id)), ...(character?.photos ?? [])]
    .filter((photo, index, all) => all.findIndex(item => item.id === photo.id) === index)
}
