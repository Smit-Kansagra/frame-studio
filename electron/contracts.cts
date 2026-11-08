export type ErrorCode = 'STORAGE_UNAVAILABLE' | 'SCHEMA_TOO_NEW' | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'BUSY' | 'FILE_UNREADABLE' | 'UNSUPPORTED_IMAGE' | 'IMAGE_TOO_LARGE' | 'INVALID_IMAGE' | 'IMAGE_PROCESSING_FAILED' | 'IMPORT_FAILED' | 'ASSET_NOT_FOUND' | 'INVALID_PRODUCT' | 'PRODUCT_NOT_FOUND' | 'PRODUCT_CHANGED' | 'UNDO_UNAVAILABLE' | 'INVALID_THEME' | 'THEME_NOT_FOUND' | 'THEME_CHANGED' | 'INVALID_PROMPT_FILE' | 'INVALID_CHARACTER' | 'CHARACTER_NOT_FOUND' | 'CHARACTER_CHANGED' | 'INVALID_PROJECT' | 'PROJECT_NOT_FOUND' | 'PROJECT_CHANGED'
export type AppResult<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }
export type ImageFormat = 'jpeg' | 'png' | 'webp'
export type StorageIssue = { code: 'MISSING_MEDIA' | 'UNREADABLE_MEDIA' | 'INTERRUPTED_IMPORT'; message: string; assetId?: string }
export type WorkspaceInfo = {
  folder: string
  schemaVersion: number
  assetCount: number
  issues: StorageIssue[]
}
export type FlowConnection = { state: 'not-connected' | 'opening' | 'connected' | 'needs-attention' | 'offline'; message: string; pageTitle: string | null; checkedAt: string | null }
export type FlowActivity = { id: string; label: string; state: 'pending' | 'running' | 'done' | 'error' | 'uncertain'; detail: string; updatedAt: string }
export type FlowActivityUpdate = Omit<FlowActivity, 'updatedAt'>
export type FlowProject = { projectId: string; url: string | null; state: 'creating' | 'ready' | 'needs-attention'; message: string; revision: number; activity?: FlowActivity[] }
export type FlowJob = { attemptId: string; projectId: string; stage: 'preparing' | 'submitting' | 'waiting' | 'downloading' | 'complete' | 'needs-attention'; message: string; projectUrl: string; baseline: string[]; resultIds: string[]; imported: Record<string, string>; outputs: number; updatedAt: string; activity?: FlowActivity[]; abandoned?: boolean; submissionAcknowledged?: boolean; submissionRejected?:boolean; generationFailed?:boolean; editQueued?:boolean; retryQueued?:boolean; submittedAt?: string; collectionStopped?: boolean; nextCollectionAt?: string; collectionFailures?: number; postBatch?: { id?: string; index: number; total: number; productName: string } }
export type FlowActiveRequest = { attemptId: string; projectId: string; projectName: string; state: GenerationState; automatic: boolean }
export type GenerationState = 'queued' | 'paused' | 'submission-uncertain' | 'ready-for-review' | 'failed'
export type SceneReview = { projectId: string; sceneId: string; selectedAttemptId: string | null; status: 'pending' | 'approved' | 'needs-changes' | 'needs-recheck'; note: string; updatedAt: string }
export type LogoReview = { projectId: string; attemptId: string; status: 'pending' | 'approved' | 'needs-changes' | 'processing'; cleanup: 'removed' | 'not-detected' | 'not-checked'; message: string; checkedAt: string | null; updatedAt: string; percent?:number; phase?:'queued'|'cleaning'|'saving'|'complete'|'failed'; runId?:string; startedAt?:string; durationMs?:number; cleanupVersion?:number; parallelLimit?:number }
export type PostBatchExport = { projectId: string; folder: string; files: ExportRecord[] }
export type LogoRepairArea = {x:number;y:number;width:number;height:number}
export type GenerationAttempt = { id: string; projectId: string; sceneId: string; outputType: 'reel' | 'post'; prompt: string; references: string[]; preset: ProjectPreset; sourceDuration: number | null; state: GenerationState; resultPath: string | null; error: string | null; createdAt: string; updatedAt: string; revision?: { sourceAttemptId: string; note: string }; themeReference?: ThemeReferenceSelection }
export type ExportProgress = { projectId: string; stage: 'starting' | 'rendering' | 'validating'; percent: number | null; message: string }
export type ExportRecord = { id: string; projectId: string; outputType: 'reel' | 'post'; preset: ProjectPreset; path: string; width: number; height: number; duration: number | null; createdAt: string; sourceAttemptIds: string[] }
export type ExportSceneInfo = { sceneId: string; name: string; attemptId: string | null; reviewStatus: string; logoReviewStatus?: string; duration: number | null; width: number | null; height: number | null; hasAudio: boolean; byteSize: number | null; issue: string | null }
export type ExportPlan = { projectId: string; outputType: 'reel' | 'post'; width: number; height: number; targetDuration: number | null; toolAvailable: boolean; toolMessage: string; videoEncoder: 'libx264' | 'mpeg4' | null; canExport: boolean; reasons: string[]; upscaledSources: boolean; scenes: ExportSceneInfo[]; lastExport: ExportRecord | null }
export type ExportSettings = { order: string[]; trims: { sceneId: string; inPoint: number; outPoint: number }[]; fit: 'pad' | 'crop'; muteAll: boolean; postSceneId?: string }
export type AssetInfo = {
  id: string
  originalName: string
  format: ImageFormat
  width: number
  height: number
  orientation: number
  byteSize: number
  sha256: string
  thumbnailWidth: number
  thumbnailHeight: number
  originalUrl: string
  thumbnailUrl: string
  revision: number
  createdAt: string
  edit?: ImageTransform & { sourceAssetId: string }
}
export type ImageTransform = { rotation: 0 | 90 | 180 | 270; crop: { x: number; y: number; width: number; height: number } }
export type ThemeScene = { id: string; name: string; prompt: string; duration: number; relationship: 'new-shot' | 'continue'; transition: 'cut' }
export type ThemeReferenceInstructions = { assetId: string; name: string; compositionPrompt: string; negativePrompt: string }
export type ThemeReferenceSelection = ThemeReferenceInstructions & { compositionSource: 'reference' | 'shared' }
export type ThemeContent = {
  name: string; description: string; coverAssetId: string | null; referenceAssetIds: string[]
  masterPrompt: string; outputType: 'post' | 'reel'; aspectRatio: '9:16' | '16:9' | '1:1' | '4:5' | '3:4' | '1.91:1'
  defaultDuration: number; compositionPrompt: string; scenes: ThemeScene[]
  referenceInstructions?: ThemeReferenceInstructions[]; negativePrompt?: string
  coverUseCount?: number | 'unlimited'
}
export type ThemeDraft = ThemeContent & { id?: string; expectedRevision?: number }
export type ThemeInfo = ThemeContent & { id: string; revision: number; createdAt: string; updatedAt: string; images: ProductPhoto[] }
export type ThemeTrashInfo = { token: string; themeName: string; removedAt: string }
export type CharacterContent = { name: string; category: 'female' | 'male' | 'other' | null; assetIds: string[]; primaryAssetId: string }
export type CharacterDraft = CharacterContent & { id?: string; expectedRevision?: number }
export type CharacterInfo = CharacterContent & { id: string; revision: number; photos: ProductPhoto[]; createdAt: string; updatedAt: string }
export type CharacterTrashInfo = { token: string; kind: 'character' | 'photo'; characterName: string; photoName: string | null; removedAt: string; canUndo: boolean }
export type ProductPhoto = AssetInfo & { available: boolean; thumbnailAvailable: boolean }
export type ProductInfo = {
  id: string; name: string; description: string; notes: string; primaryAssetId: string
  photos: ProductPhoto[]; revision: number; createdAt: string; updatedAt: string
}
export type ProductDraft = {
  id?: string; expectedRevision?: number; name: string; description: string; notes: string
  assetIds: string[]; primaryAssetId: string
}
export type ProductTrashInfo = { token: string; kind: 'product' | 'photo'; productName: string; photoName: string | null; removedAt: string; canUndo: boolean }
export type ProjectPreset = 'reel-vertical' | 'reel-landscape' | 'post-square' | 'post-portrait' | 'post-story' | 'post-tall' | 'post-landscape'
export type ProjectScene = Omit<ThemeScene, 'duration'> & { sourceDuration: number; editDuration: number }
export type ProjectStoryboard = { scenes: ProjectScene[]; compositionPrompt: string }
export type ProjectDraft = { id?: string; expectedRevision?: number; name: string; productId: string; themeId: string; characterId: string | null; outputType: 'post' | 'reel'; preset: ProjectPreset; duration: number; storyboard?: ProjectStoryboard }
export type ProjectSnapshot = { product: ProductInfo; theme: ThemeInfo; character: CharacterInfo | null }
export type ProjectInfo = Omit<ProjectDraft, 'storyboard'> & { id: string; revision: number; createdAt: string; updatedAt: string; snapshot: ProjectSnapshot; storyboard: ProjectStoryboard }
export type DeletedProjectInfo = { id: string; name: string; revision: number; deletedAt: string }
export type ImageSelection = { assets: AssetInfo[]; failures: { filename: string; message: string }[] }
export type FoundProduct = { product_url: string; image_url: string }
export type ProductFindJob = { state: 'idle' | 'running' | 'complete' | 'error' | 'cancelled'; message: string; startedAt: string | null }
export type ProductMarketplace = 'myntra' | 'meesho' | 'flipkart' | 'amazon'
export type ProductFindRequest = { query: string; platforms: ProductMarketplace[]; lookbackDays: 7 | 14; autoRefresh: boolean }
export type ProductFindState = { folder: string; products: FoundProduct[]; updatedAt: string | null; cliPath: string | null; automation: ProductFindJob; savedSearch: ProductFindRequest | null; nextRunAt: string | null }
export type DiscoverySettings = { youtubeKey: string; geminiKey: string; hasYoutubeKey?: boolean; hasGeminiKey?: boolean; ai: 'none' | 'ollama' | 'antigravity' | 'hybrid'; model: string; channels: string; pages: { id: string; name: string; query: string; platforms: ProductMarketplace[]; lookbackDays: 7 | 14; autoRefresh: boolean }[] }
export type DiscoveryProduct = FoundProduct & { pageId: string; title: string; sources: { url: string; creator: string; views: number; published: string }[]; state: 'ready' | 'downloaded' | 'posted'; foundAt: string }
export type DiscoveryState = { settings: DiscoverySettings; products: DiscoveryProduct[]; job: ProductFindJob; nextRunAt: string | null }
export type FrameStudioAPI = {
  discovery: {
    status: () => Promise<DiscoveryState>
    save: (settings: DiscoverySettings) => Promise<void>
    start: (pageId: string) => Promise<void>
    cancel: () => Promise<void>
    download: (pageId: string, url: string) => Promise<void>
    markPosted: (pageId: string, url: string) => Promise<void>
    copy: (pageId: string, url: string) => Promise<void>
  }
  productFind: {
    start: (request: ProductFindRequest) => Promise<void>
    stopAutoRefresh: () => Promise<void>
    cancel: () => Promise<void>
    status: () => Promise<ProductFindState>
    openFolder: () => Promise<void>
    openProduct: (url: string) => Promise<void>
    copyProduct: (url: string) => Promise<void>
  }

  readonly platform: 'windows'
  readonly phase: 11
  flow: {
    activeRequest: (projectId?: string) => Promise<AppResult<FlowActiveRequest | null>>
    status: () => Promise<FlowConnection>
    connect: () => Promise<FlowConnection>
    open: () => Promise<FlowConnection>
    show: () => Promise<FlowConnection>
    check: () => Promise<FlowConnection>
    disconnect: () => Promise<FlowConnection>
    openManual: () => Promise<FlowConnection>
    project: (projectId: string) => Promise<AppResult<FlowProject | null>>
    linkProject: (projectId: string, url: string) => Promise<AppResult<FlowProject>>
    job: (projectId: string) => Promise<AppResult<FlowJob | null>>
    jobs: (projectId: string) => Promise<AppResult<FlowJob[]>>
    generate: (projectId: string, sceneId: string, outputs: number) => Promise<AppResult<FlowJob>>
    generatePosts: (projectId: string) => Promise<AppResult<FlowJob>>
    resume: (attemptId: string) => Promise<AppResult<FlowJob>>
    retry: (attemptId: string) => Promise<AppResult<FlowJob>>
    resumePosts: (projectId: string) => Promise<AppResult<FlowJob[]>>
    pairCompanion: () => Promise<AppResult<{ code: string; expiresAt: string }>>
    copyPairingCode: () => Promise<AppResult<null>>
    openExtensionFolder: () => Promise<AppResult<null>>
    openResultsFolder: (projectId: string) => Promise<AppResult<null>>
  }
  projects: {
    list: () => Promise<AppResult<ProjectInfo[]>>
    get: (id: string) => Promise<AppResult<ProjectInfo>>
    save: (draft: ProjectDraft) => Promise<AppResult<ProjectInfo>>
    trash: (id: string, expectedRevision: number) => Promise<AppResult<DeletedProjectInfo>>
    deleted: () => Promise<AppResult<DeletedProjectInfo[]>>
    restore: (id: string, expectedRevision: number) => Promise<AppResult<ProjectInfo>>
    deletePermanently: (id: string, expectedRevision: number) => Promise<AppResult<{ cleanupWarnings: number }>>
  }
  generations: {
    list: (projectId: string) => Promise<AppResult<GenerationAttempt[]>>
    prepare: (projectId: string, sceneId: string) => Promise<AppResult<GenerationAttempt>>
    setState: (id: string, state: 'paused' | 'queued' | 'submission-uncertain' | 'failed') => Promise<AppResult<GenerationAttempt>>
    importResult: (id: string) => Promise<AppResult<GenerationAttempt | null>>
    reviews: (projectId: string) => Promise<AppResult<SceneReview[]>>
    review: (projectId: string, sceneId: string, attemptId: string, status: 'pending' | 'approved' | 'needs-changes', note: string) => Promise<AppResult<SceneReview>>
    approvePost: (attemptId:string,note:string) => Promise<AppResult<{review:SceneReview;logo:LogoReview}>>
    approveAll: (projectId:string,items:{attemptId:string;note:string}[]) => Promise<AppResult<{approved:number;skipped:number;reviews:SceneReview[];logos:LogoReview[]}>>
    logoReviews: (projectId: string) => Promise<AppResult<LogoReview[]>>
    reviewLogo: (attemptId: string, status: 'approved' | 'needs-changes') => Promise<AppResult<LogoReview>>
    retryLogo: (attemptId: string,area?:LogoRepairArea) => Promise<AppResult<LogoReview>>
    onLogoProgress: (callback:(value:LogoReview)=>void)=>()=>void
  }
  exports: {
    inspect: (projectId: string) => Promise<AppResult<ExportPlan>>
    start: (projectId: string, settings: ExportSettings) => Promise<AppResult<ExportRecord | null>>
    startPostBatch: (projectId: string) => Promise<AppResult<PostBatchExport | null>>
    cancel: (projectId: string) => Promise<AppResult<null>>
    openFolder: (exportId: string) => Promise<AppResult<null>>
    onProgress: (callback: (progress: ExportProgress) => void) => () => void
  }
  workspace: {
    status: () => Promise<AppResult<WorkspaceInfo>>
    retry: () => Promise<AppResult<WorkspaceInfo>>
  }
  images: {
    chooseAndImport: () => Promise<AppResult<AssetInfo | null>>
    chooseManyAndImport: (limit?: number) => Promise<AppResult<ImageSelection | null>>
    get: (id: string) => Promise<AppResult<AssetInfo>>
    transform: (id: string, edit: ImageTransform) => Promise<AppResult<AssetInfo>>
  }
  themes: {
    list: () => Promise<AppResult<ThemeInfo[]>>
    get: (id: string) => Promise<AppResult<ThemeInfo>>
    save: (draft: ThemeDraft) => Promise<AppResult<ThemeInfo>>
    duplicate: (id: string, revision: number) => Promise<AppResult<ThemeInfo>>
    remove: (id: string, revision: number) => Promise<AppResult<{ token: string }>>
    trash: () => Promise<AppResult<ThemeTrashInfo[]>>
    undo: (token: string) => Promise<AppResult<ThemeInfo>>
    importPrompt: () => Promise<AppResult<{ name: string; text: string } | null>>
  }
  characters: {
    list: () => Promise<AppResult<CharacterInfo[]>>
    get: (id: string) => Promise<AppResult<CharacterInfo>>
    save: (draft: CharacterDraft) => Promise<AppResult<CharacterInfo>>
    duplicate: (id: string, revision: number) => Promise<AppResult<CharacterInfo>>
    remove: (id: string, revision: number) => Promise<AppResult<{ token: string }>>
    trash: () => Promise<AppResult<CharacterTrashInfo[]>>
    undo: (token: string) => Promise<AppResult<CharacterInfo>>
  }
  products: {
    list: (search?: string) => Promise<AppResult<{ items: ProductInfo[]; total: number }>>
    get: (id: string) => Promise<AppResult<ProductInfo>>
    save: (draft: ProductDraft) => Promise<AppResult<ProductInfo>>
    remove: (id: string, revision: number) => Promise<AppResult<{ token: string }>>
    trash: () => Promise<AppResult<ProductTrashInfo[]>>
    undo: (token: string) => Promise<AppResult<ProductInfo>>
  }
}
