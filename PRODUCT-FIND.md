# Product Find — Auto workflow (0.13.0-preview.54)

## Permanent extension folder (preview.54)

Product Finder 0.1.1 now uses `%APPDATA%\Frame Studio\browser-extensions\product-finder`, prepared from the app's bundled extension assets on startup. The Settings folder action opens this stable path. Load it once; after future app updates, finish/cancel collection and click **Refresh extension** in its popup or **Reload** in Chrome. Refresh is refused while a worker is active. Existing users loaded from a versioned release or resource folder must switch to the permanent folder once; future version-directory cleanup does not remove this path. The app copies only an explicit extension-asset list with staged writes, unchanged-file preservation, manifest-last ordering and rollback on write failure. It never installs extensions, touches Chrome's profile or stores a permanent pairing token. Pairing after refresh/restart is still required. Saved app products, credentials and projects stay untouched. Runtime/browser tests remain unrun, per owner instruction.

**Preview.54 delivery:** `npm run build:installer` completed the repository's required TypeScript checks, renderer build, Electron compilation and Windows packaging. Packaged resource inspection confirmed Product Finder 0.1.1 and its Refresh button. No fixture, runtime, Chrome, retailer or model tests were run, and nothing was installed. Output: `release/0.13.0-preview.54/Frame-Studio-0.13.0-preview.54-x64-Setup.exe` (176,829,539 bytes), SHA-256 `2F5E91B7AE1482113D6FD1A005F503441F053CF041A877796C2117796BDD44E5`.

At the owner's request, eight obsolete generated release directories (preview.46 through preview.53) were removed after the new installer completed, reclaiming 5,046,363,792 bytes. Their paths were checked for containment, running app processes, reparse points and personal database/credential files before deletion. The current packaging debug file was also removed. Required source, documentation, dependencies, cached offline build tools, model assets and the current release were retained. Existing app profile data and Chrome installations were not deleted. Historical delivery paths below refer to removed old builds.

## Extension names and icons (preview.53)

The former combined extension is now two separately loadable extensions. **Flow Bridge 0.1.9** has a blue bridge/play icon and remains in the existing `extension` source / `resources/flow-companion` packaged folder. **Product Finder 0.1.0** has a purple clothing/search icon and lives in `extension-product-finder` source / `resources/product-finder` packaged folder. Toolbar, extension-manager, popup favicon and popup header use the corresponding real PNG icons at 16/32/48/128 pixels. Settings folder buttons and pairing instructions point to the correct extension. The existing Flow page adapter and product collection/verification code are retained.

Reload the existing companion to update it to Flow Bridge. Then in **Settings / Product Find / Advanced**, click **Open Product Finder folder**, load that folder through Chrome's **Load unpacked**, and pair a fresh Product Find code in Product Finder. Its separate extension identity requires its own selected-site permission approval. No app data, user preferences, projects, credentials, history or downloaded models are deleted; no extension is installed automatically. Retailer access restrictions and commercial image permission checks are unchanged. No runtime/browser/fixture/model tests were run. Real 4–6-product collection/export remains pending manual testing.

Earlier preview notes below document historical code and delivery; their combined-popup instructions are superseded by this section.

**Preview.53 delivery:** `npm run build:installer` completed its required TypeScript checks, production renderer build, Electron compilation and Windows packaging. A final packaging-only pass included the shortened Chrome manifest description. Read-only resource inspection confirmed both named extension folders and all eight PNG icons. No runtime, fixture, browser, retailer or model tests were run; nothing was installed or launched. Output: `release/0.13.0-preview.53/Frame-Studio-0.13.0-preview.53-x64-Setup.exe` (176,828,149 bytes). SHA-256: `21231415E23711919D6C61F0A1F641512B01A3D817DD352AEC6DA29019F968EA`.

Preview.52 improves exact Product/SKU binding and Chrome failure handling in the existing one-click Chrome/priority workflow. It visits actual retailer public search and product pages, collects observed facts through an isolated DOM reader, and feeds the existing verification, selection, persistence and export service. It does not use EarnKaro or convert affiliate links. The new fixes have not been runtime-tested; no real pack/export success or all-five-platform access is claimed. Existing projects, photos, settings, credentials and libraries retain their profile and locations.

## Owner-reported failure and source-only fixes (preview.52)

Read-only inspection of the owner's saved run showed Flipkart counts: 40 search results/links, 8 accessible/parsed listings, 8 budget matches, 0 category matches, 0 variant matches, 0 usable photos and 0 pack candidates. All eight retained records had observed INR prices and image URLs; sampled records also had colour names. The parser's exact URL match did not establish identity; missing price or colour alone was not the cause. The original raw JSON-LD was not saved, so availability of exact SKU/productID proof in those responses is not established by this audit.

New parsing can bind a supplied Product using its actual exact URL (including safe normalization of HTTP metadata URLs) or exact SKU/productID against the observed original listing identity. Only a uniquely bound Product can supply Flipkart PID-specific photo proof. Missing identity evidence remains unknown; no stored candidate is retroactively marked verified. Public specification tables supply allowlisted fields such as Length Type and Ideal For. Short/long kurti classification requires an explicit observed length; missing length is not short. Known men's-only specifications are excluded. Newly verified inventory can influence the one existing Auto fallback; manual category, budget and partial selection are unchanged.

Myntra/Meesho saved search counts were zero with Chrome's `Frame with ID 0 is showing error page`. This establishes a Chrome page/read failure, but not its exact DNS, SSL, network, site-access or navigation cause. The collector now waits for committed retailer navigation, stops rather than injecting after a 28-second navigation timeout, includes store/stage/requested original URL in the error, stops subsequent detail/query attempts after that failure, and retains the failed collection tab for the owner to inspect. Successful/cancelled tabs still close. No CAPTCHA, login, security warning or site restriction is bypassed. These are error-handling fixes, not proof that those external navigation failures are resolved.

Reload extension `0.1.8-products.2` from this app's companion folder, then create/paste a fresh Product Find code. The version handshake rejects stale product readers; Flow's page adapter remains unchanged. Explicit pairing clears prior source-health pauses for another owner-initiated run; saved products, packs, history, credentials and the SQLite database are not deleted or modified by this source audit. No tests, live retailer requests, browser probes or model calls were run for these fixes. Real-pack acceptance remains pending owner testing.

Refresh also preserves inherited image licence/account identifiers, allowing the existing permission layer to revoke or expire a grant after reparsing. Parsing a photo does not grant new usage permission.

**Preview.52 delivery:** final `npm run build:installer` passed its required TypeScript checks, UI build, Electron compilation and Windows packaging. An initial packaging attempt encountered a temporary Windows executable lock; an intermediate restricted rebuild encountered `spawn EPERM`; the final rebuild completed with approved packaging permissions. No app process was terminated. Read-only archive inspection confirmed app `0.13.0-preview.52`, extension `0.1.8-products.2`, exact SKU binding, inherited licence scope, the new handshake and failed-tab handling. This checks packaged source presence, not retailer compatibility. Feature/fixture tests, live requests, browser probes and model calls were not run. The app was not installed or launched.

Output: `release/0.13.0-preview.52/Frame-Studio-0.13.0-preview.52-x64-Setup.exe` (176,813,057 bytes); SHA-256 `943A4BC73A8171881F14EE95813ACF710A138C7FA98F464D46A9032A278EE06D`.

## Chrome collection setup (preview.52; owner testing required)

1. Open **Settings / Product Find / Advanced / Chrome product collection**. Click **Open companion folder**.
2. In Chrome, open `chrome://extensions`, enable Developer mode, then **Load unpacked** and select that folder. Reload/update an existing installation from the new app folder. Verify extension `0.1.8-products.2`.
3. Keep a normal Chrome window open. Click **Create Product Find code** in the app.
4. Open the companion popup. In **Product Find**, select shopping sites, paste the code and click **Allow sites and connect Product Find**. Allow the selected site origins in Chrome. This is separate from Flow pairing.
5. Save manual numbers in **Platform priority** (1 first, 2 next; blanks last). Leave Product Find on Auto stores. Click **Find my next post**. No category/budget/store selection is needed on each search.
6. Repeat pairing after restarting the app or Chrome. Saved packs/candidates survive disconnection. Browser permissions alone do not grant commercial photo rights.

The extension uses the official optional-host-permissions, scripting-in-isolated-world and WebSocket APIs. Only selected retailer origins are requested; no `<all_urls>`, cookie, history, browser-debugger or account-token permission is added. The app serves a single-use, five-minute connection capability on an ephemeral loopback port; HTTP requests receive 404, and only authenticated Chrome-extension WebSockets can submit replies. No VPS/service is installed. Commands contain only bounded public clothing queries or validated original detail links. No arbitrary script or file command exists. The existing AI runner never receives browser permissions.

Myntra's reader can verify its canonical/style ID against visible product code, current INR PDP price and that listing's own main gallery. A missing colour name stays unknown; the variant label explicitly identifies the observed listing. Explicit observed length specifications can classify short versus long kurtis without altering the real title. Other pages need exact structured Product/Offer/colour/image relationships. Missing facts stay unknown and are retained, not promoted to verified products.

Myntra, Meesho and Flipkart have implemented, unverified Chrome search/detail paths after pairing. Optional approved Flipkart API access takes precedence if already saved. Amazon/AJIO have implemented structured page readers but automatic use is gated on genuine existing `catalogue-research` permission because Chrome access does not override retailer restrictions. No new paid access is required or suggested; a disabled restricted store never blocks eligible stores.

At most three retailer workers run, with per-host serialization, bounded query/detail requests, the existing total deadline and exact hard filters. Cancellation sends a scoped cancel, waits for the extension's worker/tab cleanup acknowledgement, and only then settles the request. A missing acknowledgement disconnects the transport and prevents another Chrome job until reconnecting. Completed detail reads are buffered so a later timeout/cancel does not discard already collected candidates. Browser/login/CAPTCHA errors are visible and paused, without bypass. No background discovery is introduced.

**Current checklist:** Chrome bridge, popup permissions/pairing, rendered search/detail reads, active runtime wiring, buffered cancellation, source status and original link/photo mapping are implemented and source-reviewed. Fixture tests: not run. Runtime/extension/live retailer/model calls for this revision: not run, per owner instruction. Real 4–6-product acceptance and export: pending owner testing. Packaging status is recorded after the requested installer build. Older audit notes below describe earlier versions, not a live verification of these new readers.

**Preview.51 build delivery:** TypeScript compilation/checks and the production UI build completed through `npm run build:installer`. Its first packaging attempt encountered a Windows executable lock; packaging-only retry also needed permission to spawn outside the restricted sandbox. `node scripts/package-win.mjs --isolated-output` then exited successfully. No app processes were terminated and no security settings were changed. Read-only archive/resource inspection confirmed app version, compiled Chrome bridge, extension `0.1.7-products.1`, optional shopping origins and unchanged Flow origin scope. This is artifact inspection, not runtime acceptance. No tests, Chrome probes, retailer requests or model calls ran for the implementation. Nothing was installed or launched, and production profile/database files were not edited.

Installer: `release/0.13.0-preview.51/Frame-Studio-0.13.0-preview.51-x64-Setup.exe`; 176,810,603 bytes; SHA-256 `81B87C9CE2EEDDE760DCEC55E032A92DFA4A33DEA9B61E694B6ECF74F9045C62`.

## Install and preserve data

Before any future update, close Frame Studio and back up the complete `%APPDATA%\Frame Studio` directory and the workspace shown in Settings. Keep the backup until testing finishes. The preview.52 installer includes Chrome collection fixes and saved manual platform priority; installation remains manual:

`release/0.13.0-preview.52/Frame-Studio-0.13.0-preview.52-x64-Setup.exe`

The existing application ID and profile path are unchanged. Do not use third-party uninstall/data cleaners. Windows-encrypted credentials remain tied to the original Windows user/key context.

## Current source workflow (manual verification pending)

Open Product Find and click **Find my next post**. New defaults are women's fashion in India, INR 200–1,000, five products, Auto category and Auto stores. Existing saved budget/count are preserved during migration. The editable summary and collapsed **Customize** control save optional category/store overrides and 4/5/6-product choices. The saved budget is always a hard limit; a manual category never changes automatically. Flow's connection badge is hidden on Product Find because Flow does not collect products.

Auto chooses enabled clothing families/subcategories using coverage, recent collections, genuinely verified saved inventory and cooldown. Supported repeated performance observations can inform the existing seventh-slot repeat logic; otherwise choices are labelled editorial exploration. Specialist categories are excluded from Auto by default and can be enabled individually in Settings. Leggings and dupattas extend the existing taxonomy. Coverage appends future pending slots beyond eight weeks, preserving previous slots and history. Only explicit season preferences justify seasonal exclusions; the app does not assume all India has the same climate.

Auto stores includes only configured adapters with search, details and images, excluding unavailable credentials/permissions and paused access. Configuration alone is labelled unverified. A successful catalogue request records its actual time separately from per-product verification. Missing access stops before retailer requests or model calls with **Product source setup required**. It does not change categories to hide a source failure.

Set platform numbers once in **Settings / Product Find / Advanced / Platform priority**: 1 first, 2 next, through 99; blank stores follow numbered stores. Equal numbers share a priority. These are manual preferences, not commission rates. Find my next post uses the saved numbers when bounding candidates and assembling a collection: take eligible distinct products from higher-priority usable stores, then fill remaining places from lower-priority stores. AI preferences can order products within a priority but cannot override store priority. The theme, hard budget, stock/variant/photo checks and cooldown still apply. Blocked/unconfigured stores remain excluded even if ranked first.

Priority is snapshotted into each new collection and saved session. Find more retains existing qualifying products, numbering and that snapshot; Replace uses the same priority for alternatives and same-theme search. Editing priorities affects subsequent new collections, not saved results. The optional `settings.storeRanks`, `selection.storeRanks` and pack `storeRanks` fields are additive to the existing JSON schema; absent fields mean equal priority. Normal atomic saves retain the previous `.bak`. No SQLite migration, data deletion, credential changes or account requests are needed to save priorities. Existing older app versions tolerate these optional fields; keep a separate copy of the profile before downgrading.

Automatic EarnKaro rate collection and affiliate-link conversion are out of scope after the owner's latest clarification. The owner chooses platform numbers and converts original links independently. No new source connection or commercial-photo licence is inferred from those numbers.

Collection runs at most two equivalent queries within one theme, across up to three independent sources concurrently, serializing requests to the same host. The entire job has a 180-second deadline. Only a genuine zero-match inventory result from a readable source permits one alternative Auto theme; manual categories, partial retries, source restrictions and model failures never trigger that fallback. A partial collection is retained rather than discarded to chase another category. At most one reasoning batch is attempted per new collection job. Empty results consume no coverage and create no pack.

**Find more matching products** appears only for partial results and keeps their theme, budget, stores and qualifying product order. **Replace** uses a verified saved alternative or searches the same theme once. **Done** archives without claiming a post was published. **Done / Next collection** explicitly starts the next collection. No queue management is required.

Cards show the export number, original listing photo, observed title/INR price, platform, variant, observation time and full selectable original URL. Open/copy actions use that original URL. Genuine account-generated affiliate URLs appear separately. Otherwise cards say "Original link — convert in EarnKaro"; no tracking is added. Copy all produces numbered title/platform/original-URL entries in photo order.

Photo permission is separate from review eligibility. Products need observed fresh facts and a matching photo, but unknown image reuse rights do not block review or copying. Download is enabled only when all numbered products remain verified and all exported photos have recorded rights. Existing safe JPEG conversion, limits and ZIP mapping remain in place.

Account/source settings, scoped licence administration, optional imports, coverage preferences, history and diagnostics are now in **Settings / Product Find / Advanced**. YouTube is not part of this search. Its credentials and library remain stored, but its old schedules are disabled in the main runtime. All pack auto-collection is also inactive; collection runs only after an explicit click. No invisible queue is filled. In-flight workers settle before cancellation unlocks another job or saves final job state. Restart restores the saved selection for an explicit retry.

The additive workflow migrations retain `ready-packs-v1.json.before-simple-find.bak` and add `ready-packs-v1.json.before-auto-find.bak` before changing an older workflow. The storage schema remains version 1; workflow version 3 adds preferences, source configuration/health, image-read observations and actionable errors. Empty legacy drafts are archived with their history intact; their plan slots reopen. Partial drafts do not consume coverage. Original projects, credentials, posting records and library entries are retained. To roll back, close the app, preserve the current JSON separately, then restore the matching pre-update backup before running an older build. Never delete the profile or SQLite database.

**Runtime testing remains with the owner.** The historical preview.49 `npm run build:installer` passed, including TypeScript checks, the production UI build, Electron compilation and NSIS packaging. Read-only archive inspection confirmed version `0.13.0-preview.49`, the one-click screen and the access/catalogue/planner modules. Preview.50 build status is recorded below after packaging. No automated feature tests, live retailer searches, browser probes or model calls were run for the priority changes. Nothing was installed or launched. Existing fixtures need corresponding Auto, priority and photo-observation assertions before reuse. No real pack, replacement or export success is claimed.

**Preview.50 packaging:** the owner requested a new installer, so `npm run build:installer` ran and exited successfully, including its required TypeScript checks, Vite production build and Electron compilation. No separate tests or live collection/account calls ran. Read-only `app.asar` inspection confirmed package version, the platform-priority controls, IPC action and backend selection code. Output: `release/0.13.0-preview.50/Frame-Studio-0.13.0-preview.50-x64-Setup.exe` (176,800,176 bytes; SHA-256 `54BAA0D5DCDE0095E12F1BD0EED3DCE17AA6056B310D57CE7E287E613CE4E2D0`). This is a manual-testing preview, not completed real-pack acceptance. No app was installed or launched, and production profile/database files were not edited.

## Existing backend

- Persistent eight-week category coverage, category-specific INR budgets, configurable 4-6-product packs with saved result history.
- Deterministic category/price/freshness guards, garment deduplication, cooldown, replacement, posting/performance records and local scheduling.
- Original listing links, observed product facts, image provenance, evidence and explicit unknown/failure fields.
- CSV/JSON/URL fallback imports, scoped image permission records and permission-gated numbered ZIP export.
- Authenticated Antigravity as primary reasoning, with an explicit code-only fallback. No local LLM is required.

This source revision uses manual searches only. Old persisted schedule settings remain stored but are inactive. Interrupted searches retain candidates and session selection; click Find more to resume. No server, VPS or hidden service is installed.

## Antigravity setup and spending protection

The inspected official CLI is `agy 1.5.3`. The shared account runner reuses the existing executable resolver and legacy shortlist integration. It verifies effective session configuration before every model request:

- `useG1Credits: false` disables additional AI-credit overages.
- `modelProvider: ""` uses account mode; a Google Cloud project configuration is rejected.
- Strict file/command/browser/MCP denials and disabled slash expansion restrict reasoning to supplied text.
- API keys, ADC credential paths and billing/project environment variables are removed from the child process.

Global Antigravity settings are not overwritten. No OAuth tokens/cookies are extracted or copied. No paid fallback, Cloud billing or ADC setup is enabled. Start `agy` interactively if sign-in is required. No Pro/Ultra benefits are assumed from a Google One/AI Plus description.

Use Settings / Product Find / Advanced / Account reasoning to test the account, choose a discovered model, select medium effort (default) or optional high effort, or explicitly select Code only. UI polling never starts model requests. Remaining quota is not invented. Quota/sign-in errors pause automatic reasoning across restart until a manual recheck.

One compact batch per pack can classify supplied evidence, select supplied candidate IDs, cite evidence, explain selection with constrained reasons, suggest themes inside saved coverage, and interpret supplied commission conditions. Prices, rates, calculations, eligibility, six-hour freshness, persistence, scheduling and ZIP mapping remain deterministic. AI does not inspect photos; this interface is text-only. Unknown classifications remain unknown.

Requests have a 24 KB prompt cap, 12 KB schema cap, 64 KB output cap, 90-second CLI timeout and 100-second process guard. Unchanged requests cache for seven days, at most 64 entries. Automatic model retries and silent fallback are disabled.

Official references: [CLI](https://antigravity.google/docs/cli/reference/), [headless mode](https://antigravity.google/docs/cli/headless/), [credit control](https://antigravity.google/docs/cli/credits), [settings schema](https://antigravity.google/schemas/v1/settings.json).

## Product source setup and current limitations

| Source | Implemented | Required access / limitation |
| --- | --- | --- |
| YouTube Data API v3 (legacy) | Existing evidence adapter preserved | Excluded from Product Find and its automatic schedule disabled. Credentials/history retained. |
| Flipkart Affiliate API | Documented keyword search and ID detail refresh | Existing approved tracking ID/token required. No credentials are currently configured; a working new-account signup flow was not verified. |
| Public listing structured data | Exact product JSON-LD where accessible | Retailers can block access or omit fields. Unknown facts are never filled by AI. |
| Libas public Shopify adapter | Search, variant details, stock/sizes and matching-image parsing | Disabled without genuine merchant permission for automated research. Public API accessibility does not override merchant terms. |
| Merchant-authorized WooCommerce Store API | New GET-only keyword search, exact ID details, variant/parent checks and listing-bound photos; wired into the same service, cards and export | Implemented but not runtime-tested. No merchant origin/grant is configured in the existing profile. Uses the documented public, unauthenticated API; it does not require keys, billing, proxies or a subscription. Merchant permission is still required for this commercial research use. |
| Chrome retailer collection (preview.51) | Implemented; unverified | User-paired search/detail DOM readers for supported stores. Myntra has a PDP gallery/code/price reader; others use strict structured data. Amazon/AJIO remain merchant-permission gated. Pairing is not proof of live access. |

[Flipkart access instructions](https://affiliate.flipkart.com/api-docs/af_register.html), [token page for approved accounts](https://affiliate.flipkart.com/api/api-token), [Libas terms](https://www.libas.in/pages/terms-conditions), [Libas contact](https://www.libas.in/pages/contact-us).

Earlier profile inspection found no approved Flipkart pack credentials or merchant research licences. Preview.51 adds a separate optional Chrome collection connection without widening Flow's guards. An Antigravity or Google sign-in does not establish retailer access. New browser paths require owner pairing/manual verification; no usable live automatic marketplace source has yet been established by a completed acceptance run. No purchase or new API account is required for the implemented Chrome route.

### Historical five-marketplace access audit (before preview.51)

#### Earlier commission-priority request (superseded by manual platform priority)

The owner subsequently chose to enter platform priority numbers personally. The original-link and same-theme waterfall requirements below still apply, but automated commission lookup is no longer required and is not implemented. Existing blocked catalogue access remains a separate issue.

The owner will create EarnKaro affiliate links independently. Frame Studio is responsible for original product links and matching photos; automatic link conversion and EarnKaro conversion API credentials are not prerequisites for this workflow.

For each coherent women's-clothing theme, compare current, applicable EarnKaro clothing commission conditions across accessible partner stores. Prefer the highest comparable verified rate, retain however many eligible distinct products it supplies, then fill remaining positions from the next ranked store and then subsequent stores. For example, a five-product collection may contain three eligible products from the first store and two from the second. Store fallback must keep the same clothing theme, hard budget, verification, cooldown and image-rights rules. Cross-store duplicates must not fill missing positions.

Commission observations need source, observation time, applicable category, exclusions/caps, customer/order conditions and expiry when supplied. Refresh through a genuinely supported permitted source before each new collection; retain a bounded timestamped cache, but do not silently reuse expired/stale rates as current. Unknown applicability and advertised "up to" ceilings cannot establish a definite highest-paying store. Do not turn unknown commission into zero, invent an ordering, or change clothes/budget to chase a headline rate. Percentage rates and fixed payouts need an explicit comparable basis; do not silently compare unlike numbers. Changes affect new selections; existing partial results retain qualifying products and numbering.

[EarnKaro's official rate-check guide](https://earnkaro.com/profitshala/profit-related/how-to-check-profit-rates) directs users to Our Partners. This documents where account holders review rates, not a programmatic data interface. The current code implements manual-number priority filling, not automatic commission lookup/ranking. Product access and commercial-photo permissions remain separate blockers. A conversion-only integration would not resolve either blocker. No live account/browser/retailer check was run for this clarification, following the owner's standing manual-testing instruction.

The follow-up request covers Flipkart, Amazon India, Meesho, Myntra and AJIO. These are not five established live connections. Official documentation research found the following concrete access boundaries; no retailer search, browser probe or model request was executed for this audit:

- Flipkart's [registration documentation](https://affiliate.flipkart.com/api-docs/af_register.html) requires a registered affiliate and private tracking ID/token headers. Documentation does not establish that this user can obtain new approval. The existing adapter remains optional and excluded without access.
- Amazon India's [Creators API introduction](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/introduction) documents catalogue search, item details and variations. Its stated prerequisites include Associates enrolment, ten qualifying sales in the past thirty days, API registration and generated credentials. An Amazon shopping login or Antigravity subscription does not meet those prerequisites. No unapproved or paid fallback was enabled.
- [Cuelinks' own API help](https://cuelinks.zohodesk.com/portal/en/kb/articles/what-are-cuelinks-apis) explicitly says its API does not provide merchant product feeds. Campaign discovery/link conversion must not be presented as product discovery.
- [Admitad's product-feed documentation](https://admitad.useresponse.com/knowledge-base/article/product-feed-what-it-is-and-how-to-export-it-for-your-website_4) describes feeds only for programs offering that tool, associated with an ad space. This does not establish access to any particular marketplace, let alone all five.
- The owner confirmed an existing EarnKaro account. [EarnKaro's official FAQ](https://earnkaro.com/faq) describes signed-in deals, including women's clothing, and Make Link conversion. Its [Magic Tool documentation](https://earnkaro.com/profitshala/magic-tool/what-is-magic-tool) documents bulk link conversion and sharing, not an application-facing product-search/detail API. No supported catalogue API/feed or account-specific access was established from these public documents. This is an unverified capability, not proof that EarnKaro offers no private partner integration. Unpublished site endpoints or account cookies are not substituted.
- [AJIO's terms](https://www.ajio.com/help/termsAndCondition) restrict automated navigation/search, scraping and product-listing/price collection. A generic Chrome script is not treated as permission to bypass those restrictions. No authorized automatic route for Meesho or Myntra was established from the user's currently known access either.

EarnKaro API access is not required for manual platform priorities or original product links. Make Link/Magic Tool access alone does not establish automatic product collection or commercial photo reuse rights. EarnKaro's [content terms](https://earnkaro.com/terms-conditions) also require express written approval for otherwise unauthorized reproduction/distribution of platform content; account membership is not recorded as an image-export licence. No new registration, qualifying purchase, paid service or subscription is requested. Until a genuinely available permitted source is established, all-five-platform completion and real-pack acceptance remain blocked. Adding more source labels or another installer would not change this status. The original account-access audit changed documentation only; the subsequent priority implementation is described above.

The new optional WooCommerce route is a complete collection implementation, not a configured search URL: `GET /wp-json/wc/store/v1/products?search=...` discovers IDs; `GET /products/:id` observes details; documented variation queries require a matching parent relation and a variant-selecting permalink. Simple-SKU photos are bound to their returned listing record. An inherited parent gallery is not accepted as proof of a colour variant. INR amounts use the supplied currency minor unit. Unknown stock/sizes stay unknown. Protected products, cross-origin/API-scope redirects, private targets and oversized/non-JSON responses are rejected. Primary image responses are checked as actual decodable images before results qualify; candidates survive photo failures. This inspection does not claim visual reasoning.

If you already have an authorized merchant store, record its HTTPS origin and actual research grant once under **Settings / Product Find Advanced / Store access / Optional existing authorized WooCommerce store**. Saving makes no request and does not mark the route live-verified. The next explicit Find selects it automatically. If no such access exists, there is no one-time switch in the existing Flow or Antigravity accounts that supplies it. This optional route is not mandatory, not an integration for Meesho/Amazon/etc., and not proof that any particular merchant permits collection. Image export rights remain a separate scoped grant.

Source restrictions persist across restart. HTTP 401/403, challenges and unsupported endpoints pause until an explicit Settings recheck; rate limits pause for an hour and other transient errors for fifteen minutes. Individual blocked photos also retain their failure/next-recheck state, preventing repeated identical image requests while other products remain usable. There are no background retries. Cached reads never update the last successful network timestamp. A failed optional source cannot discard another source's verified products. Missing required listing facts or inaccessible photos are treated as a source-data limitation, not repaired by changing the budget or inventing an AI classification.

Official documentation reviewed (no listing/search execution): [WooCommerce Store API](https://developer.woocommerce.com/docs/apis/store-api/), [product search/details/variations](https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/products/), [Chrome activeTab scope](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [Meesho terms](https://www.meesho.com/legal/terms-conditions), [Myntra terms](https://www.myntra.com/termsofuse), [AJIO terms](https://www.ajio.com/help/termsAndCondition), [Libas terms](https://www.libas.in/pages/terms-conditions). These sources document access interfaces/restrictions, not working account access for this user. Research permission is not inferred from publicly reachable endpoints or browser capabilities.

Current implementation checklist:

| Area | Current status |
| --- | --- |
| One-click defaults, Customize, visible original/affiliate links, Flow badge isolation | Implemented; source-reviewed only |
| Continuing coverage, optional specialists, authoritative filters, garment cooldown, partial retry/replacement | Implemented; source-reviewed only |
| Auto source readiness, durable pause/recheck, bounded parallel collection, cancellation drain | Implemented; source-reviewed only |
| Manual platform numbers, priority-first selection, snapshot persistence, partial/replacement priority | Implemented; source-reviewed only; not fixture-tested or live-verified |
| WooCommerce search → detail/variant → image response → saved candidate → existing pack/export service | Implemented; unverified, requires an already-authorized merchant origin/grant |
| Chrome retailer collection and actual source access | Implemented, unverified; owner must pair extension and verify compatible permitted sites. Amazon/AJIO still require existing merchant permission. |
| Antigravity no-overage/tool restrictions | Existing guards retained; no account/model requests in this revision |
| Real 4–6-product collection, replacement, JPEG/ZIP preview | Pending live/manual verification; no pass claimed |

## Scoped image permissions

Record a genuine licence once in Settings / Product Find / Advanced / Photo permission administration. Covered products inherit it; expired, revoked or out-of-scope images remain unknown. Legacy free-text Flipkart permission does not establish blanket rights. Exact provider/account, product hosts, image hosts and optional path prefixes are enforced. Shared Shopify CDN permissions require a merchant-specific path prefix.

Licence JSON fields: `id`, `provider` (`flipkart`, `libas` or the exact configured `catalogue:store-id`), `account`, `reference`, `grantedAt`, `expiresAt`, `uses`, `productHosts`, `imageHosts`, optional `imagePathPrefixes`. Uses are `catalogue-research`, `instagram-commercial`, `image-export`; include only uses actually granted. Dates are ISO timestamps. A null expiry means the actual grant has no fixed expiry. For Flipkart, the account must match the tracking ID associated with the returned image. For Libas, known merchant CDN paths include `/s/files/1/0341/4805/7228/`; this path alone is not permission. A WooCommerce source's research grant never automatically grants commercial image export.

## Imports, export and feedback

Fallback product imports accept public HTTPS URLs, CSV or JSON, at most 200 records / 3 MB. JSON fields include `url`, real `title`, configured `category` ID, `subcategory`, `variant`, `color`, `match`, `price`, `currency`, ISO `observedAt`, `stock`, `sizes`, `garmentId`, and `images`. An image has `url`, `permission` and genuine `permissionNote`. Omit unknown facts. CSV supports scalar fields plus `image_url`; JSON supports arrays/detail-image permissions. Invalid/private-network URLs and unsafe redirects are rejected. URL-only records remain unverified when no authorized detail provider is available. Complete authorized feed facts can be reviewed while fresh; this is not automatic discovery.

Optional commission records supply actual `conditions`, public `source`, `observedAt`, structured `ratePercent` or `fixedInr`. Missing, stale, future-dated or ambiguous rates produce no estimate. AI never supplies rates. Estimated commission is conditional, not approved commission or inferred sales.

ZIP export contains actual JPEG conversions (`01_primary.jpg`, numbered detail images), `links.csv`, `pack.json` and local `preview.html`. Numbering, original/optional affiliate link, variant, observed price and verification timestamp share an explicit mapping. HTML/CSV are escaped. Limits are 15 MB fetched image, 40 million pixels and 90 MB converted pack photos. Missing/mismatched/unauthorised images or failed refreshes block export rather than shifting numbering. Product photos are never synthesized for research.

Existing projects reference one product plus a theme, so no fake multi-product Use this pack action was added. `pack.json` uses `frame-studio-ready-pack/v1` and remains the documented integration seam.

Mark posted accepts an optional Instagram URL/date. Manual pack-level reach, saves, shares, clicks, orders and approved commission retain source, observation time and reporting window. Unknowns stay null. Performance JSON import accepts up to 200 records / 1 MB with `packId`; valid earlier rows persist if a later row fails. No automated Instagram metrics or posting is connected.

## Persistence and historical test status (before latest source edits)

Pack data uses additive `product-discovery/ready-packs-v1.json`, with `.bak`, `.tmp` and atomic rename. Legacy local/hybrid feature settings migrate to account mode; a one-time `library.json.before-account-ai.bak` preserves the original library. Existing SQLite/photo libraries and encrypted keys are retained. Newer/invalid schemas fail without resetting user data.

| Area | Historical status; not re-run for current edits |
| --- | --- |
| Planner, filters, replacement, cooldown, restart, ZIP mapping/JPEG conversion | Fixture-tested |
| AI ID/citation guards, unknown handling, cache, quota pause and migration | Fixture-tested |
| Official Antigravity authentication and structured reasoning | Live-verified on 2026-11-10 using the listed Gemini 3.8 Flash (Medium) model |
| Real saved candidate interpretation | Two real identities evaluated; correctly selected zero because current prices/variants were unknown |
| Real 4-6-product pack, replacement and export | Not passed; retailer access and genuine image rights remain unresolved |

The last retailer probe found 10 videos, 8 URLs and 6 unique Meesho listings. All six listings returned HTTP 403. No category/budget/variant/photo verification ran beyond that barrier. A subsequent normal-browser probe stopped because the browser connector was unavailable and native Chrome could not verify the current URL safely. No barrier was bypassed.

The earlier SQLite failure was reproduced on base commit `481f6f0b29ef74d4fd8b96574ce748765456ba84` only through the stale test's malformed downgrade. Actual base creation, ordinary reopen and genuine schema-1 migration passed. The test was corrected to remove newer tables from its disposable database and assert current schema 18. Production databases were not experimented on or recreated.

## Run and verify

```powershell
npm ci
npm run dev
npm run build
npm start
npm run check:ready-packs
npm run check:products
npm run check:products-base
node scripts/check-ready-packs-ui.mjs
npm run build:installer
```

Live tests are explicit opt-in and consume existing account/API quota: `node scripts/check-ready-packs-ai-live.mjs` tests authenticated reasoning; `--replay` revalidates its saved response without another model request. `node scripts/check-ready-packs-live.mjs` performs bounded source checks. Fixtures are never reported as live products.

Required runtime dependencies, the bundled MI-GAN ONNX model and third-party licence metadata are part of existing image-processing features and must remain installed. They are separate from optional Ollama reasoning models.
