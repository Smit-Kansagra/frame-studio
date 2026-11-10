# Product Finder

Product Finder 0.1.1 is the separate purple clothing/search extension for Frame Studio Product Find. Flow Bridge handles Google Flow independently. The existing collector and `products-2` local protocol are retained; this is not a new retailer access method.

1. In Frame Studio, open Settings / Product Find / Advanced / Chrome product collection and click **Open Product Finder folder**.
2. First setup only: open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose that folder. The app prepares the permanent `%APPDATA%\Frame Studio\browser-extensions\product-finder` folder from its own bundled assets at startup. An isolated app-check profile uses its own folder. The installer bundle is the update source, not the folder to load in Chrome.
3. Keep a normal Chrome window open. Click **Create Product Find code** in the app.
4. Open **Product Finder**, select shopping sites, paste the code, and click **Allow sites and connect Product Find**. Chrome requests only the selected retailer origins.
5. Return to the app and click **Find my next post**. Pair again after restarting Chrome or Frame Studio. Pairing codes remain single use and expire after five minutes.

When upgrading from the combined companion, reload its original folder to update it to Flow Bridge, then load this separate Product Finder folder once. No app data, saved products, projects, credentials, posting history or Google sign-in is removed. Shopping permissions must be approved for Product Finder because it has a separate extension identity. No extension is installed or removed automatically.

If Product Finder was previously loaded from a versioned `release` directory or an installer resource folder, switch to the permanent folder once. Future software updates refresh files at that same permanent path. Finish/cancel collection, then use **Refresh extension** in the Product Finder popup or **Reload** in `chrome://extensions`. The popup blocks refresh while a collection worker is active. Loading again is not needed. Refresh/restarting the app still requires a fresh local pairing code; no permanent authentication token or shopping account access is saved. Staged asset updates preserve unchanged files, commit the manifest last and attempt rollback if writing fails. Local file errors block pairing until the app can prepare its extension files.

The collector reads bounded public search/detail pages using the existing isolated DOM reader. It does not access cookies, passwords, account storage, private retailer APIs, EarnKaro or paid services. Login, CAPTCHA and access restrictions stop collection. Amazon/AJIO automatic collection still needs a genuine existing scoped merchant research grant. Chrome permission does not grant commercial image export rights. Source access and real-pack export remain unverified; changing the extension name/icon does not resolve retailer failures.

Editable artwork is `icon.svg`; `node scripts/build-extension-icons.mjs` from the repository root renders PNG icons at 16, 32, 48 and 128 pixels. The same icons appear in the toolbar, extension manager and popup favicon/header. No runtime/browser/model tests were run for this revision, per owner instruction.
