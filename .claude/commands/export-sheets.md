---
description: Export the tracker to CSV and push it to Google Sheets (via Drive connector if available)
---

# /export-sheets

## 1. Export

```bash
node bin/gaj.js export --format csv
```

Note the output path (default `data/exports/tracker-<date>.csv`). Read the file.

## 2. Upload (if a Google Drive connector is available)

Look for a Google Drive tool that creates files (e.g. a `create_file` tool from
a Google Drive MCP server; use ToolSearch if tools are deferred).

- If found: call it with `title: "get-a-job tracker"`,
  `contentMimeType: "text/csv"`, `textContent: <CSV text>`, and conversion
  left enabled, so Drive converts it to a native Google Sheet.
- Re-runs: search Drive for an existing file titled `get-a-job tracker` owned by
  the user. If found, ask: replace it (trash the old one after the new one is
  created) or keep both with a dated title.
- Show the returned link.
- **Never share the sheet or change its permissions** unless the user asks
  explicitly.

## 3. Fallback (no connector)

Give these instructions:
1. Open https://sheets.new.
2. File → Import → Upload → choose `<csv path>` → "Replace current sheet" →
   Import data.
3. Or, in the tracker (`/track`), click **Copy for Google Sheets** and paste
   into cell A1.

Mention `node bin/gaj.js export --format xlsx` for an Excel file.
