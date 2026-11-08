# Frame Studio Flow Companion

Current app: 0.13.0-preview.45. Current adapter: 0.1.6-fast.24.

## Install and connect

1. Open Frame Studio Settings and choose Open companion extension folder.
2. In Chrome, open chrome://extensions, enable Developer mode, and use Load unpacked for that folder. Reload an existing installation when its files change.
3. Open your signed-in Flow workspace and refresh the tab after reloading the extension.
4. Generate a pairing code in Frame Studio Settings and connect from the extension popup on the Flow tab.
5. Keep Chrome and Frame Studio open while collecting results.

No passwords or cookies are read. Pairing is explicit, revocable, and limited to supported Flow origins. Disconnecting does not cancel a remote Flow generation.

## Projects and generation

Saving a project is local. Generate creates and names its own Flow project. Each software project UUID owns a separate Flow tab, URL, request queue and result folder. There is no app-imposed limit on concurrent projects. Different project tabs upload, prepare prompts and collect results independently. Commands within one tab remain ordered. Only foreground naming/submission turns and ambiguous native download filename capture windows are serialized across tabs; they do not hold other projects' uploads. Each project's existing three-request generation pipeline remains separate from every other project.

The native driver resolves the exact Flow document URL before finding Generate: Chrome can expose inactive tabs' buttons as visible too. Only the native ticket/click holds the foreground lock. A slow acknowledgement stays in that project's own lane, with priority over its queued result checks; other projects can submit immediately. A native failure explicitly confirmed before invocation is retryable. Errors after invocation retain submission uncertainty and cannot trigger a duplicate click.

Each uploaded product photo gets one Post request. Assigned visual references use their own name and composition prompt. Exclusions can be written in the master prompt. The Post theme editor has no separate Composition tab or per-reference negative field; stored legacy fallback/negative data is retained. New Posts can use the master direction without a separate composition. Generate starts immediately without a confirmation popup. The optional References and prompts disclosure shows assigned thumbnails with exact final prompts. Fast repeated clicks are guarded locally; submission protection remains active in the coordinator. Cover usage quotas are configured in Theme create/edit and reset for each project.

Projects with saved generation attempts reopen directly in Clips. Clips product cards show text without photo thumbnails. The main image viewer keeps product review, comments, version selection, arrows, keyboard navigation and touch swipe. Approve all approves this project's completed, locally cleaned current image versions together and preserves their descriptions. Active, failed, unfinished or changed versions are skipped. Apply changes in Flow sends the exact selected saved image and comment with supporting references. A new version starts pending review. Uncertain submissions are never automatically repeated; Resume only collects the existing request.

## Local cleanup and review

Completed originals stage under Downloads/Frame Studio, move into the managed workspace, and are matched using the selected result's exact identity. Current short media-ID filenames and older timestamp filenames are supported. A browser using another Downloads directory may require manual import.

Post images are checked for supported visible Gemini logos before theme resizing. Supported alpha masks are restored directly. When a busy background prevents that match, a bundled MI-GAN model repairs the detected small logo area locally. Cleanup engine 4 also matches signed star contours across fabric/background boundaries, where global luminance matching fails. Older missed-logo entries are rechecked once. Both methods run offline in a shared worker queue that adapts to CPU, available RAM and each image size. Percentage comes from completed decode, pattern-check, restoration, PNG and commit stages. Queued images show 0%; only a committed final file reaches 100%. The selected product shows cleanup progress while its image is hidden. The image and approval remain hidden until cleanup commits. Other products remain selectable and can process concurrently.

Clips displays only images whose local cleanup has completed. The separate Logo removed tab has been removed. Product cards show only Product N, with yellow for review pending, green for approved, and red for image or logo changes. Change image sends the selected saved image and description directly to Flow for editing. Need change in logo retries local cleanup on that same saved image without Flow credits. If automatic detection misses a visible logo, Need change in logo opens area selection directly instead of repeating the same ineffective scan. A retry that finds no logo also opens selection for that same image if it is still selected. The selected area is reconstructed locally. Unknown matches preserve pixels until a selection is made. Only the marked/detected area plus a 3-pixel border is reconstructed; dimensions and other pixels stay unchanged. Reconstructed texture needs review. Invisible SynthID removal is not used. Failed/interrupted cleanup stays unapproved until retried. Creative image edits cannot upload an image while its cleanup is running.

Final Projects contains one project folder and one file per generated version. Review and image edits use that same final file. Disposable original/normalized copies are removed after import. Existing theme, character and project data are preserved by schema 18.

## Export

Post export requires approval of the exact cleaned image version in Clips. One Approve action records both creative and cleanup approval atomically. Export all approved images uses one folder chooser and writes Image 1.png, Image 2.png, etc. in product order. Each run creates a new folder instead of overwriting existing exports. Matching PNGs are copied without re-encoding. Cancellation or a changed approval rolls back that batch's partial outputs.

Reels retain the existing local FFmpeg workflow. The image logo-cleanup worker is for Post images.

## Verification and assets

Focused worker, storage, queue, transport and isolated Chrome checks cover progress gating, parallel cleanup, input/result ownership, review comments, bulk export and recovery. Fixture checks do not establish compatibility with every live Google Flow UI or account.

Calibrated visible-logo masks and license attribution are included under third-party/gemini-watermark. The local inpainting model, pinned checksum, source and MIT code/weight licenses are included under third-party/migan. ONNX Runtime telemetry is disabled before initialization. Dark mode uses near-black backgrounds, neutral grey surfaces and restrained purple accents based on the supplied UI reference. The Studio home opens directly to projects, with the decorative start-project banner removed. Dark is the default; an existing light preference is preserved. The root README is separate project documentation.

## Failed uploads and parallel recovery

Each project has an independent browser lane without a shared project-count or submission cap. One stalled upload cannot hold another project's uploads or result checks. A product preparation failure or an explicit Flow submission rejection does not stop unrelated products. Each failed product has a Retry control in Clips. It retries the original saved prompt and reference snapshot for that product only, including while another product in the same batch is running. Duplicate queued retries coalesce. Queued retries interrupted by app shutdown become retryable again after restart. A submitted request with uncertain acceptance is checked for existing results; it is not blindly submitted twice.

Change image is available as soon as that product has a cleaned image, even while other products generate. Its exact source image, description, final prompt and reference mapping are queued immediately. Several products can queue changes, and entries survive app restart. The owned tab processes changes in order without mixing products. Transient Chrome tab-edit failures and prompt preparation failures receive bounded retries before submission; uncertain clicks do not.

Native downloads accept Flow's truncated title only alongside the selected media ID suffix. Collection first checks existing downloads for that exact result and approved origin/project before requesting another download. Original files recovered this way are validated within Downloads and moved into the project's staging folder. Actual Flow policy failures are reported only when a new failed card can be matched to the exact request; they are not automatically resubmitted. Unrelated products continue.
