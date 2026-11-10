# Product Find — Auto workflow (0.13.0-preview.49)

This source revision adds the one-click Auto workflow and a documented merchant-catalogue collection route to the existing Ready Packs runtime. It is packaged as preview.49 for owner testing. Product collection and export have not been runtime-tested. Existing projects, photos, settings, credentials and libraries retain their profile and locations.

## Install and preserve data

Before any future update, close Frame Studio and back up the complete `%APPDATA%\Frame Studio` directory and the workspace shown in Settings. Keep the backup until testing finishes. The preview.49 installer includes these Auto changes and remains a manual installation:

`release/0.13.0-preview.49/Frame-Studio-0.13.0-preview.49-x64-Setup.exe`

The existing application ID and profile path are unchanged. Do not use third-party uninstall/data cleaners. Windows-encrypted credentials remain tied to the original Windows user/key context.

## Current source workflow (manual verification pending)

Open Product Find and click **Find my next post**. New defaults are women's fashion in India, INR 200–1,000, five products, Auto category and Auto stores. Existing saved budget/count are preserved during migration. The editable summary and collapsed **Customize** control save optional category/store overrides and 4/5/6-product choices. The saved budget is always a hard limit; a manual category never changes automatically. Flow's connection badge is hidden on Product Find because Flow does not collect products.

Auto chooses enabled clothing families/subcategories using coverage, recent collections, genuinely verified saved inventory and cooldown. Supported repeated performance observations can inform the existing seventh-slot repeat logic; otherwise choices are labelled editorial exploration. Specialist categories are excluded from Auto by default and can be enabled individually in Settings. Leggings and dupattas extend the existing taxonomy. Coverage appends future pending slots beyond eight weeks, preserving previous slots and history. Only explicit season preferences justify seasonal exclusions; the app does not assume all India has the same climate.

Auto stores includes only configured adapters with search, details and images, excluding unavailable credentials/permissions and paused access. Configuration alone is labelled unverified. A successful catalogue request records its actual time separately from per-product verification. Missing access stops before retailer requests or model calls with **Product source setup required**. It does not change categories to hide a source failure.

Collection runs at most two equivalent queries within one theme, across up to three independent sources concurrently, serializing requests to the same host. The entire job has a 180-second deadline. Only a genuine zero-match inventory result from a readable source permits one alternative Auto theme; manual categories, partial retries, source restrictions and model failures never trigger that fallback. A partial collection is retained rather than discarded to chase another category. At most one reasoning batch is attempted per new collection job. Empty results consume no coverage and create no pack.

**Find more matching products** appears only for partial results and keeps their theme, budget, stores and qualifying product order. **Replace** uses a verified saved alternative or searches the same theme once. **Done** archives without claiming a post was published. **Done / Next collection** explicitly starts the next collection. No queue management is required.

Cards show the export number, original listing photo, observed title/INR price, platform, variant, observation time and full selectable original URL. Open/copy actions use that original URL. Genuine account-generated affiliate URLs appear separately. Otherwise cards say "Original link — convert in EarnKaro"; no tracking is added. Copy all produces numbered title/platform/original-URL entries in photo order.

Photo permission is separate from review eligibility. Products need observed fresh facts and a matching photo, but unknown image reuse rights do not block review or copying. Download is enabled only when all numbered products remain verified and all exported photos have recorded rights. Existing safe JPEG conversion, limits and ZIP mapping remain in place.

Account/source settings, scoped licence administration, optional imports, coverage preferences, history and diagnostics are now in **Settings / Product Find / Advanced**. YouTube is not part of this search. Its credentials and library remain stored, but its old schedules are disabled in the main runtime. All pack auto-collection is also inactive; collection runs only after an explicit click. No invisible queue is filled. In-flight workers settle before cancellation unlocks another job or saves final job state. Restart restores the saved selection for an explicit retry.

The additive workflow migrations retain `ready-packs-v1.json.before-simple-find.bak` and add `ready-packs-v1.json.before-auto-find.bak` before changing an older workflow. The storage schema remains version 1; workflow version 3 adds preferences, source configuration/health, image-read observations and actionable errors. Empty legacy drafts are archived with their history intact; their plan slots reopen. Partial drafts do not consume coverage. Original projects, credentials, posting records and library entries are retained. To roll back, close the app, preserve the current JSON separately, then restore the matching pre-update backup before running an older build. Never delete the profile or SQLite database.

**Runtime testing remains with the owner.** `npm run build:installer` passed, including TypeScript checks, the production UI build, Electron compilation and NSIS packaging. Read-only archive inspection confirmed version `0.13.0-preview.49`, the one-click screen and the new access/catalogue/planner modules. No automated feature tests, live retailer searches, browser probes or model calls were run. Nothing was installed or launched. Existing fixtures need corresponding Auto and photo-observation assertions before reuse. No real pack, replacement or export success is claimed.

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
| Amazon India, Myntra, Meesho, AJIO dedicated catalogues | Automatic adapters unavailable | Store choices enforce filtering only; they do not establish access. Authorized feed records are optional fallbacks. AJIO detail URLs are now validated/canonicalized for those records. No guessed search endpoints were added. |

[Flipkart access instructions](https://affiliate.flipkart.com/api-docs/af_register.html), [token page for approved accounts](https://affiliate.flipkart.com/api/api-token), [Libas terms](https://www.libas.in/pages/terms-conditions), [Libas contact](https://www.libas.in/pages/contact-us).

No approved Flipkart pack credentials or merchant research licences were present in the read-only profile metadata inspected for this revision. The repository's existing Chrome companion explicitly supports only Flow origins, and its guards/manifest permissions were not widened. An Antigravity or Google sign-in does not establish retailer access. No usable zero-cost automatic marketplace source is currently established with this profile. Do not purchase access or assume that free account approval is available; the app stops rather than pretending otherwise.

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
| WooCommerce search → detail/variant → image response → saved candidate → existing pack/export service | Implemented; unverified, requires an already-authorized merchant origin/grant |
| Existing user's usable automatic retailer access | Blocked: no configured permitted collection route established |
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
