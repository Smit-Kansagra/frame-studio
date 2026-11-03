import type { ThemeContent, ThemeReferenceInstructions } from '../contracts.cjs'

export function referenceInstructions(theme: Pick<ThemeContent, 'referenceInstructions'>, assetId: string, filename: string): ThemeReferenceInstructions {
  return theme.referenceInstructions?.find(item => item.assetId === assetId) ?? { assetId, name: filename.trim().slice(0, 120) || 'Reference image', compositionPrompt: '', negativePrompt: '' }
}

/** Remove only global bans on features explicitly requested by this composition.
 * Stored theme text remains intact. Reference-specific negatives are never edited. */
export function compositionCompatibleShared(text: string, composition: string): string {
  const positive = composition.split(/[.!?;,\n]+|\bbut\b/).filter(part => !/\b(?:no|without|avoid|omit|exclude|do not|don't|must not|never)\b/i.test(part)).join(' ')
  const allowText = /\b(?:heading|headline|caption|title|lettering|text|typography)\b/i.test(positive)
  const allowBag = /\b(?:bag|bags|handbag|handbags|purse|purses|clutch|potli|backpack)\b/i.test(positive)
  if (!allowText && !allowBag) return text
  const feature = new RegExp(`\\b(?:${[allowText && 'headings?|headlines?|captions?|titles?|lettering|text|typography', allowBag && 'bags?|handbags?|purses?|clutch(?:es)?|potli|backpacks?'].filter(Boolean).join('|')})\\b`, 'i')
  return text.split(/([.!?;\n]+)/).map((part, index) => {
    if (index % 2) return part
    if (!/\b(?:no|without|avoid|omit|exclude|do not|don't|must not|never)\b/i.test(part) || !feature.test(part)) return part
    const chunks = part.split(/,|\band\b|\bor\b/i)
    const retained = chunks.filter(chunk => !feature.test(chunk) || /\b(?:misspelled|misspelt|unreadable|garbled|distorted|wrong|incorrect|extra|duplicated|random|invented)\b/i.test(chunk)).map(chunk => chunk.trim()).filter(chunk => chunk && !/^(?:no|without|avoid|omit|exclude|do not|don't|add|include|use|extra|any|a|an)$/i.test(chunk))
    if (!retained.length) return ''
    return /^\s*(?:no|without|avoid|omit|exclude|do not|don't|never)\b/i.test(retained[0]) ? retained.join(', ') : `Avoid ${retained.join(', ')}`
  }).join('').replace(/^[\s.!?;]+|[\s;]+$/g, '').replace(/(?:[.!?;]\s*){2,}/g, '. ').replace(/([.!?;])(?=\p{L})/gu, '$1 ').trim()
}
