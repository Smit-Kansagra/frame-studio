# Ready Post Packs - 0.13.0-preview.47

This Windows preview includes all current Ready Post Packs and authenticated Antigravity changes. It is provided for owner testing. Existing projects, photos, settings, credentials and user libraries use the same profile; building does not install the update.

## Install and preserve data

Close Frame Studio. Back up the complete `%APPDATA%\Frame Studio` directory and the workspace shown in Settings. Keep the backup until testing finishes. Run the new installer yourself:

`release/0.13.0-preview.47/Frame-Studio-0.13.0-preview.47-x64-Setup.exe`

The existing application ID and profile path are unchanged. Do not use third-party uninstall/data cleaners. Windows-encrypted credentials remain tied to the original Windows user/key context.

## What is included

- Persistent eight-week category coverage, category-specific INR budgets, configurable 4-6-product packs and a three-pack queue.
- Deterministic category/price/freshness guards, garment deduplication, cooldown, replacement, posting/performance records and local scheduling.
- Original listing links, observed product facts, image provenance, evidence and explicit unknown/failure fields.
- CSV/JSON/URL fallback imports, scoped image permission records and permission-gated numbered ZIP export.
- Authenticated Antigravity as primary reasoning, with an explicit code-only fallback. No local LLM is required.

Collection runs only while the app is open. A 30-second timer checks persisted due jobs; successful collection schedules six hours later. A full queue stops collection. Interrupted jobs resume without duplicating committed pack slots. Failures back off and pause after three attempts. No server, VPS or hidden service is installed.

## Antigravity setup and spending protection

The inspected official CLI is `agy 1.5.3`. The shared account runner reuses the existing executable resolver and legacy shortlist integration. It verifies effective session configuration before every model request:

- `useG1Credits: false` disables additional AI-credit overages.
- `modelProvider: ""` uses account mode; a Google Cloud project configuration is rejected.
- Strict file/command/browser/MCP denials and disabled slash expansion restrict reasoning to supplied text.
- API keys, ADC credential paths and billing/project environment variables are removed from the child process.

Global Antigravity settings are not overwritten. No OAuth tokens/cookies are extracted or copied. No paid fallback, Cloud billing or ADC setup is enabled. Start `agy` interactively if sign-in is required. No Pro/Ultra benefits are assumed from a Google One/AI Plus description.

Use Sources/setup to test the account, choose a discovered model, select medium effort (default) or optional high effort, or explicitly select Code only. UI polling never starts model requests. Remaining quota is not invented. Quota/sign-in errors pause automatic reasoning across restart until a manual recheck.

One compact batch per pack can classify supplied evidence, select supplied candidate IDs, cite evidence, explain selection with constrained reasons, suggest themes inside saved coverage, and interpret supplied commission conditions. Prices, rates, calculations, eligibility, six-hour freshness, persistence, scheduling and ZIP mapping remain deterministic. AI does not inspect photos; this interface is text-only. Unknown classifications remain unknown.

Requests have a 24 KB prompt cap, 12 KB schema cap, 64 KB output cap, 90-second CLI timeout and 100-second process guard. Unchanged requests cache for seven days, at most 64 entries. Automatic model retries and silent fallback are disabled.

Official references: [CLI](https://antigravity.google/docs/cli/reference/), [headless mode](https://antigravity.google/docs/cli/headless/), [credit control](https://antigravity.google/docs/cli/credits), [settings schema](https://antigravity.google/schemas/v1/settings.json).

## Product source setup and current limitations

| Source | Implemented | Required access / limitation |
| --- | --- | --- |
| YouTube Data API v3 | Recent video search and bounded description/short-link resolution | Save a key through the preserved legacy source setup. Video views are not product-specific demand. |
| Flipkart Affiliate API | Documented keyword search and ID detail refresh | Existing approved tracking ID/token required. No credentials are currently configured; a working new-account signup flow was not verified. |
| Public listing structured data | Exact product JSON-LD where accessible | Retailers can block access or omit fields. Unknown facts are never filled by AI. |
| Libas public Shopify adapter | Search, variant details, stock/sizes and matching-image parsing | Disabled without genuine merchant permission for automated research. Public API accessibility does not override merchant terms. |
| Amazon India, Myntra, Meesho dedicated catalogues | Not connected | URL/feed fallbacks do not establish a live catalogue integration. |

[Flipkart access instructions](https://affiliate.flipkart.com/api-docs/af_register.html), [token page for approved accounts](https://affiliate.flipkart.com/api/api-token), [Libas terms](https://www.libas.in/pages/terms-conditions), [Libas contact](https://www.libas.in/pages/contact-us).

If using Libas, obtain written permission covering low-rate automated catalogue research and commercial Instagram photo export. Ask for covered storefront/image paths, permitted uses, grant reference and expiry. No message has been sent on your behalf. No purchase or account registration is automatic.

## Scoped image permissions

Record a genuine licence once in source setup. Covered products inherit it; expired, revoked or out-of-scope images remain unknown. Legacy free-text Flipkart permission does not establish blanket rights. Exact provider/account, product hosts, image hosts and optional path prefixes are enforced. Shared Shopify CDN permissions require a merchant-specific path prefix.

Licence JSON fields: `id`, `provider` (`flipkart` or `libas`), `account`, `reference`, `grantedAt`, `expiresAt`, `uses`, `productHosts`, `imageHosts`, optional `imagePathPrefixes`. Uses are `catalogue-research`, `instagram-commercial`, `image-export`; include only uses actually granted. Dates are ISO timestamps. A null expiry means the actual grant has no fixed expiry. For Flipkart, the account must match the tracking ID associated with the returned image. For Libas, known merchant CDN paths include `/s/files/1/0341/4805/7228/`; this path alone is not permission.

## Imports, export and feedback

Fallback product imports accept public HTTPS URLs, CSV or JSON, at most 200 records / 3 MB. JSON fields include `url`, real `title`, configured `category` ID, `subcategory`, `variant`, `color`, `match`, `price`, `currency`, ISO `observedAt`, `stock`, `sizes`, `garmentId`, and `images`. An image has `url`, `permission` and genuine `permissionNote`. Omit unknown facts. CSV supports scalar fields plus `image_url`; JSON supports arrays/detail-image permissions. Invalid/private-network URLs and unsafe redirects are rejected.

Optional commission records supply actual `conditions`, public `source`, `observedAt`, structured `ratePercent` or `fixedInr`. Missing, stale, future-dated or ambiguous rates produce no estimate. AI never supplies rates. Estimated commission is conditional, not approved commission or inferred sales.

ZIP export contains actual JPEG conversions (`01_primary.jpg`, numbered detail images), `links.csv`, `pack.json` and local `preview.html`. Numbering, original/optional affiliate link, variant, observed price and verification timestamp share an explicit mapping. HTML/CSV are escaped. Limits are 15 MB fetched image, 40 million pixels and 90 MB converted pack photos. Missing/mismatched/unauthorised images or failed refreshes block export rather than shifting numbering. Product photos are never synthesized for research.

Existing projects reference one product plus a theme, so no fake multi-product Use this pack action was added. `pack.json` uses `frame-studio-ready-pack/v1` and remains the documented integration seam.

Mark posted accepts an optional Instagram URL/date. Manual pack-level reach, saves, shares, clicks, orders and approved commission retain source, observation time and reporting window. Unknowns stay null. Performance JSON import accepts up to 200 records / 1 MB with `packId`; valid earlier rows persist if a later row fails. No automated Instagram metrics or posting is connected.

## Persistence and test status

Pack data uses additive `product-discovery/ready-packs-v1.json`, with `.bak`, `.tmp` and atomic rename. Legacy local/hybrid feature settings migrate to account mode; a one-time `library.json.before-account-ai.bak` preserves the original library. Existing SQLite/photo libraries and encrypted keys are retained. Newer/invalid schemas fail without resetting user data.

| Area | Status |
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
