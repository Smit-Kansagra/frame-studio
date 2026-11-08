# Product Find: manual Instagram workflow

Product Find now uses YouTube Data API evidence instead of the Antigravity browser agent. Create named Instagram page profiles, set each niche and selected marketplaces, then save settings. Each page keeps its own persistent product library and ready/downloaded/posted status. Instagram posting and EarnKaro conversion are manual.

## Setup

Enable YouTube Data API v3 in your Google Cloud project and enter its API key in Data source and AI setup. Optional watchlist accepts up to ten actual UC channel IDs. Without it, discovery searches by niche. API quotas apply separately from Gemini.

Code-only mode needs no LLM. Local mode calls installed Ollama at http://127.0.0.1:11434/api/chat; install Ollama and an appropriate model yourself and enter its exact name. Gemini API calls are removed. Antigravity uses the signed-in CLI account, low effort and one compact classification call with file, command, browser and MCP permissions denied. Account quota and plan access apply. No browser research or second verification pass. Classification results cache for seven days. Hybrid mode uses local Ollama first and only calls Antigravity if local classification fails. Default model is qwen3:4b-instruct. No inference testing was performed. Input size and call count are bounded; total model tokens are not a hard cap.

Keys are encrypted with Electron safeStorage on Windows, stored outside source in the application userData/product-discovery folder, and never returned to the renderer. Blank key fields preserve existing credentials. The library and page settings survive restart.

## Selection

Search retrieves recent YouTube videos, then reads full descriptions and actual statistics. Only direct URLs matching selected marketplace detail-page patterns qualify. Short links and comment URLs are skipped. Candidates rank by distinct creator mentions and views divided by age; this is an average, not measured view growth. AI may select candidate indices, but cannot supply new links. A retailer must expose an original Open Graph or Twitter photo. Blocked pages are skipped; no synthetic photo replaces them. Stock and exact identity against video footage are not verified. This collector does not claim verified virality.

Products are deduplicated by page and canonical retailer URL. Photo metadata can be reused across pages for 24 hours. Previously saved products remain visible with discovery dates. Use Copy original link for manual EarnKaro conversion. Download photo writes a JPEG through a save dialog. Mark posted records your manual Instagram upload.

Optional six-hour collection runs sequentially for enabled pages while the application remains open. It resumes when an overdue schedule is loaded after restart. Disable each page checkbox and save to stop recurrence. Cancellation aborts network and model calls. Account/API quota errors are surfaced without paid fallback or repeated immediate retries.

No automated tests or live discovery runs were performed for this update, per owner instruction.

## Discovery collection fix (.46)

Natural-language commands are normalized into YouTube search keywords. Search uses relevance among videos inside the selected date window, up to 50 videos per channel/search. Common short links are resolved with a 30-link budget; each redirect is checked against public-network restrictions. Only selected-marketplace detail URLs enter results. JavaScript-only link hubs remain unsupported. Empty output reports the failing stage instead of an unexplained successful zero. Last-run counts and normalized query are stored in last-run.json, without API keys. No live search or automated test was run for this fix.
