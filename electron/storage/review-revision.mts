export function reviewRevisionPrompt(original: string, note: string, sourceAttemptId: string): string {
  return [
    'IMAGE EDIT REQUEST. The LAST attached image is the selected previously generated image to edit. Use that image as the base, rather than creating a different composition.',
    'Apply only the requested changes below. Preserve the person, product, outfit, framing, pose, lighting, background and existing details unless the requested change explicitly requires otherwise. Earlier attached product/theme/character photos are supporting references; keep their original roles.',
    `Selected saved image: ${sourceAttemptId}. This identifier is for association only; do not draw it or any edit instructions on the image.`,
    `REQUESTED CHANGES (user comment):\n${note}`,
    `Original project brief for context (the requested changes above override any conflicting detail):\n${original}`,
    `Final editing instruction: modify the LAST attached image according to this exact user comment, preserving everything else:\n${note}`,
  ].join('\n\n')
}
