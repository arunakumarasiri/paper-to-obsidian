# Paper to Obsidian v0.2

This bundle contains two pieces:

- `chrome-extension/` — extracts scholarly metadata, finds the PDF, downloads it in the browser, and sends both to Obsidian.
- `obsidian-plugin/paper-receiver/` — a desktop-only Obsidian plugin that receives the paper on `127.0.0.1`, creates the Markdown note, and writes the PDF into your vault.

## What v0.2 does

On a research-paper landing page:

1. Click the browser extension.
2. It extracts:
   - title
   - authors
   - DOI
   - journal
   - publication date
   - source URL
   - PDF URL, when exposed by the publisher
3. Crossref fills missing bibliographic fields when a DOI is available.
4. Click **Save note + PDF**.
5. The extension downloads the PDF using your browser session when possible.
6. The local Obsidian receiver creates:
   - `Papers/<article title>.md`
   - `Attachments/Papers/<article title>.pdf`

Folders are configurable in the Obsidian plugin settings.

## 1. Install the Obsidian plugin

Close/reload Obsidian after copying the plugin.

Copy this folder:

`obsidian-plugin/paper-receiver/`

into:

`<your vault>/.obsidian/plugins/paper-receiver/`

You should end up with:

```
<your vault>/
└── .obsidian/
    └── plugins/
        └── paper-receiver/
            ├── manifest.json
            ├── main.js
            └── styles.css
```

Then:

1. Open Obsidian.
2. Go to **Settings → Community plugins**.
3. Enable **Paper to Obsidian Receiver**.
4. Open its settings.
5. Click **Copy token**.

The plugin should show that the receiver is running on:

`http://127.0.0.1:27124`

## 2. Install the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chrome-extension/` folder from this bundle.
5. Pin the extension if desired.

Open the extension and paste the token copied from Obsidian.

Click **Test**. You should see:

`Obsidian receiver is running.`

## 3. Save a paper

1. Open a journal article / DOI landing page.
2. Click **Paper to Obsidian**.
3. Review the metadata.
4. If a PDF URL was found, click **Save note + PDF**.
5. Chrome may ask for permission to access the publisher domain. This is required so the extension can fetch that PDF.
6. The paper note and PDF should appear in your configured Obsidian folders.

## Security model

The receiver:

- binds only to `127.0.0.1`, not your LAN;
- requires a random secret bearer token;
- accepts only the small API implemented by this plugin;
- does not expose your vault contents.

The token is generated locally in Obsidian. The extension stores the pasted token in Chrome extension storage.

## Current limitations

This is still an MVP.

The PDF download should work well when the landing page exposes a direct PDF URL that the browser can access. Some publisher sites:

- hide the PDF behind JavaScript;
- use temporary signed URLs;
- return an HTML login page from the apparent PDF URL;
- require institutional authentication in ways that an extension `fetch()` may not reproduce.

When that happens, the extension will refuse to save the returned HTML as a PDF and show an error.

The next useful step would be publisher-specific handlers for the sites you use most often.

## Duplicate papers

If a file with the same paper title already exists, v0.2 does not overwrite it. It creates:

- `Paper title (2).md`
- `Paper title (2).pdf`

and increments further as needed.

## Default note

The generated note looks like:

```markdown
---
title: "Paper title"
authors:
  - "First Author"
  - "Second Author"
doi: "10.xxxx/..."
journal: "Journal name"
published: "2026-01-01"
url: "https://..."
pdf: "[[Attachments/Papers/Paper title.pdf]]"
---

# Paper title

## Notes
```
