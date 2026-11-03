import type { ProjectPreset, ThemeContent } from '../contracts.cjs'

export const outputSizes: Record<ProjectPreset, { width: number; height: number }> = {
  'post-square': { width: 1080, height: 1080 },
  'post-portrait': { width: 1080, height: 1350 },
  'post-tall': { width: 1080, height: 1440 },
  'post-landscape': { width: 1080, height: 566 },
  'post-story': { width: 1080, height: 1920 },
  'reel-vertical': { width: 1080, height: 1920 },
  'reel-landscape': { width: 1920, height: 1080 },
}
export const outputRatios: Record<ProjectPreset, string> = {
  'post-square': '1:1', 'post-portrait': '4:5', 'post-tall': '3:4',
  'post-landscape': '1.91:1', 'post-story': '9:16',
  'reel-vertical': '9:16', 'reel-landscape': '16:9',
}
export function presetForTheme(theme: Pick<ThemeContent, 'outputType' | 'aspectRatio'>): ProjectPreset {
  if (theme.outputType === 'reel') return theme.aspectRatio === '16:9' ? 'reel-landscape' : 'reel-vertical'
  return ({ '1:1': 'post-square', '4:5': 'post-portrait', '3:4': 'post-tall', '1.91:1': 'post-landscape', '9:16': 'post-story', '16:9': 'post-landscape' } as const)[theme.aspectRatio]
}
