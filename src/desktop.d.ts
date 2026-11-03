import type { FrameStudioAPI } from '../electron/contracts.cjs'

declare global { interface Window { frameStudio?: FrameStudioAPI } }
