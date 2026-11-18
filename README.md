# MCP Screenshot

**Precise window captures. Small MCP responses. Traceable local evidence.**

MCP Screenshot gives AI clients a focused set of tools for capturing macOS windows and saving evidence. Capture Burp Suite, a browser, or a terminal without moving the mouse, switching tabs, or stealing focus.

Screenshots are saved as lossless PNGs alongside a JSON record. By default, the client receives a compact metadata summary; use `detail: "full"` for the complete record. Images enter the conversation only when requested.

## What it does

- **Window capture:** select an OS window by ID, application name, or title. Ambiguous selections fail instead of guessing.
- **Burp shortcut:** `capture_burp_screenshot` finds Burp Suite windows and accepts an optional exchange ID for recordkeeping.
- **Lossless evidence:** PNG, capture time, dimensions, SHA-256, window identity, case ID, label, notes, and tags.
- **Low context usage:** `include_image: false` by default; retrieve the image later without another capture.
- **Serialized captures:** a bounded queue prevents overlapping captures. Native operations have timeouts and cancelled queued work is skipped.
- **Integrity checks:** `get_evidence` checks the saved PNG against its hash, dimensions, and byte count.
- **Review workflow:** append quality reviews with conflict detection, retaining the original screenshot and capture metadata.
- **Offline packages:** export selected evidence as HTML, Markdown, original PNGs, JSON, and SHA-256 checksums.
- **Local storage:** no cloud account, upload service, Burp extension, or Montoya dependency.

## Requirements

- macOS with an active graphical session.
- Node.js **22 or newer**.
- Xcode Command Line Tools (`xcode-select --install`) to build the small native window-enumeration helper.
- macOS **Screen & System Audio Recording** permission for the application that launches the MCP server.

Accessibility permission is **not required** for the screenshot tools. The diagnostic reports it for clarity, but capture only requires screen-recording access. Permission settings may use a different label on older macOS releases.

## Install from source

```sh
git clone https://github.com/thezakman/mcp-screenshot.git
cd mcp-screenshot
npm ci
npm run build
npm run doctor
```

Build on the Mac that will run the server. The helper is compiled for that Mac's architecture. Nothing is captured during installation or connection.

The server uses **stdio**:

```sh
node /absolute/path/to/mcp-screenshot/dist/index.js
```

Configure that command in your MCP client. Use absolute paths, especially when the client starts from a GUI with a different working directory or `PATH`.

### Codex CLI

After building, run this **from the root of your cloned `mcp-screenshot` repository**:

```sh
codex mcp add screenshot \
  --env MCP_SCREENSHOT_DIR="$HOME/Pictures/mcp-screenshot" \
  -- "$(command -v node)" "$PWD/dist/index.js"
```

The shell expands both executable and server paths before Codex saves the configuration. The evidence directory is created when you save your first screenshot. Change `MCP_SCREENSHOT_DIR` if you want another folder.

Check the saved entry:

```sh
codex mcp get screenshot
codex mcp list
```

Restart Codex, then use `/mcp` to check the active connection. This version exposes **17 tools**. Ask the client to read `get_capture_guide`, then call `get_capture_status` and `list_windows` to identify the window to capture.

The CLI registers the server; you do not need to run `npm start` in a separate terminal. Codex starts the stdio process when it connects. If macOS denies screen capture, grant recording permission to the application launching the MCP and restart it.

For manual configuration, the equivalent entry in `~/.codex/config.toml` is:

```toml
[mcp_servers.screenshot]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/mcp-screenshot/dist/index.js"]

[mcp_servers.screenshot.env]
MCP_SCREENSHOT_DIR = "/absolute/path/to/evidence"
```

Replace the absolute paths for your machine. Use either the CLI command or the TOML entry; both configure the same server name.

Reference: [OpenAI documentation — MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### MCP client configuration

For clients using a JSON `mcpServers` configuration:

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-screenshot/dist/index.js"],
      "env": {
        "MCP_SCREENSHOT_DIR": "/absolute/path/to/evidence"
      }
    }
  }
}
```

Find your Node executable with `command -v node`. Restart or reconnect your MCP client after updating the configuration or rebuilding the server.

## Tools

| Tool                       | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `get_capture_guide`        | Read the complete AI-client workflow, examples and recovery guidance without capturing.    |
| `select_capture_region`    | Open user confirmation for a suggested or manual crop; optionally save evidence.           |
| `capture_frontmost_window` | Capture the frontmost app when it has a unique visible window.                             |
| `list_capture_profiles`    | List fixed geometric profiles; these do not adapt to content.                              |
| `save_capture_profile`     | Create an explicitly requested fixed geometric profile.                                    |
| `delete_capture_profile`   | Remove a named profile without deleting evidence.                                          |
| `get_capture_status`       | Check permissions, evidence directory, and queue size.                                     |
| `list_windows`             | Discover visible, non-minimized OS windows with IDs, app names, titles, and bounds.        |
| `list_displays`            | List active monitors for explicit whole-display capture.                                   |
| `capture_window`           | Capture one window by ID or a unique app/title selection.                                  |
| `screenshot_app`           | Capture a window belonging to an exact app name or bundle ID.                              |
| `capture_burp_screenshot`  | Capture a Burp Suite window, with optional case/exchange metadata.                         |
| `take_screenshot`          | Capture an entire monitor, including other visible applications.                           |
| `list_evidence`            | Browse saved evidence summaries with filtering and pagination.                             |
| `get_evidence`             | Verify and retrieve a saved record, optionally including its image and review history.     |
| `review_evidence`          | Append a screenshot-quality review, keeping originals unchanged.                           |
| `export_evidence`          | Export selected evidence to an offline HTML/Markdown package with originals and checksums. |

Capture tools are annotated as non-destructive writes because they save files. They are not marked read-only merely because they do not interact with the target application.

## A typical evidence workflow

1. Display the content you want to document. Use the relevant application or its own MCP to select a tab or exchange.
2. Call `list_windows` to identify the exact window.
3. Call `capture_window` or `capture_burp_screenshot` with a case ID and label.
4. Keep the returned evidence ID and file path in your notes.
5. Use `get_evidence` when you need the image or want to verify its integrity.
6. Record a quality review with `review_evidence`, then export selected IDs with `export_evidence`.

Example tool arguments:

```json
{
  "window_id": 12345,
  "case_id": "CASE-024",
  "label": "Response displayed in Repeater",
  "exchange_id": "exchange-024",
  "tags": ["response", "baseline"],
  "include_image": false
}
```

`12345` is an example, not a stable ID. Obtain the current ID from `list_windows`.

The same capture can be retrieved without touching the application again:

```json
{
  "id": "<id returned by capture>",
  "include_image": true
}
```

### Automation

An MCP client can call these tools at selected workflow milestones, then attach the returned evidence IDs to its report. This server does not run a background recorder or start capturing when it connects. It does not send network requests or rerun a test to obtain a screenshot.

The capture checks that the selected window's identity, title, and bounds settle before capture and remain unchanged afterward. It **does not prove that page content has finished loading** or that a particular Burp exchange is on screen. Select and confirm the content before capture.

## Precise selection and economical responses

`list_windows` returns a `selection_token` describing the current window identity, title, and bounds. Pass it back as `expected_window_token` when capturing. If the window changes between selection and capture, the server returns `STALE_WINDOW` instead of silently accepting the new state. This token checks window metadata; it does not authenticate the application or verify the visible page content.

Capture tools and `get_evidence` default to `detail: "summary"`. Use `detail: "full"` when you need the complete context, notes, window geometry, and manifest path. Both modes preserve the full record on disk. `list_windows` also accepts `detail: "full"` for geometry.

PNG chunks and CRCs are checked before saving. Metadata retrieval validates the manifest and streams the image hash using a bounded buffer; it does not load the full image unless requested and within the inline limit. PNG chunk checks do not replace a full image decoder or visual review.

## Review and export without recapturing

Retrieve a saved screenshot with `get_evidence`. Its default summary includes the review status and current revision. Use `detail: "full"` for the latest review note, or `include_review_history: true` for all review events. Notes and review history stay out of default summaries to keep MCP context small.

After inspecting the screenshot, call `review_evidence`:

```json
{
  "id": "<evidence ID>",
  "expected_revision": 0,
  "status": "accepted",
  "reviewer": "<actual reviewer or agent name>",
  "note": "The relevant screen content is visible and readable."
}
```

Use the revision returned by `get_evidence`, not a hard-coded zero after the first review. Concurrent writers cannot overwrite the same revision: `REVIEW_CONFLICT` means retrieve the latest state before deciding whether to append another review.

| Status            | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `unreviewed`      | No assessment yet, or explicitly returned to the review queue.                             |
| `accepted`        | The reviewer considers the screenshot suitable for its stated purpose.                     |
| `needs_recapture` | A new capture is needed, for example because the relevant content is absent or unreadable. |
| `rejected`        | The screenshot should not be used as evidence for its stated purpose.                      |

A review records a **caller-supplied identity**, not authenticated human approval. These statuses concern screenshot quality, not whether a vulnerability is confirmed. Keep automated and human review attribution accurate. Originals remain unchanged; a recapture creates a new evidence ID.

Filter `list_evidence` using `review_status`, together with `case_id`, `exchange_id`, or `query`, to build a review queue. Listing reports review state but does not hash every PNG; use `get_evidence` for integrity verification.

Call `export_evidence` with selected IDs:

```json
{
  "ids": ["<first evidence ID>", "<second evidence ID>"],
  "title": "CASE-024 — evidence review"
}
```

The result returns local paths only. Open `html_path` in a browser for an offline gallery, or use `markdown_path` in your report workflow. No capture or upload occurs.

```text
<evidence directory>/exports/review-<UTC>-<UUID>/
  index.html       # Offline gallery, no scripts or external assets
  report.md        # Portable report with relative image links
  manifest.json    # Export metadata and per-item review snapshots
  SHA256SUMS       # Checksums for the report and copied evidence files
  evidence/<ID>/
    screenshot.png # Exact original bytes
    metadata.json  # Exact original capture record
    reviews/       # Exact review events, when present
```

Exports verify source PNGs and review chains, then publish the completed directory atomically. A failed export leaves no partial published package. Each package supports **1–50 distinct IDs**, up to **256 MiB**. Move the entire package together to retain relative image links. Review snapshots are taken per item as it is read, not as a single transactional snapshot across all evidence.

From the exported directory, verify the package on macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

The tool also returns the SHA-256 of `SHA256SUMS`; retain it separately when you need an external reference. Hashes detect changes relative to the supplied records; they are **not digital signatures**. Review events form a hash chain with up to 1,000 revisions per evidence item. Rewriting the complete chain or removing its tail cannot be detected without an independently retained reference. Packages contain the original images and notes; nothing is silently redacted.

## Evidence format

By default, captures are stored in `~/Pictures/mcp-screenshot`:

```text
<evidence directory>/
  <project name or generated UTC timestamp_UUID>/
    <application>/
      <YYYY-MM-DD_HH-mm-ss-SSS>/
        screenshot.png
        metadata.json
        reviews/      # Added only when reviewed
          0001.json
```

Each record includes:

- Capture time in UTC, dimensions in pixels, byte count, and SHA-256.
- Capture mode and selected window metadata or display number.
- Optional `case_id`, `label`, `note`, `exchange_id`, and `tags`.
- What was checked and any warnings.

PNG and JSON are published together using a directory rename. New files use owner-only permissions; existing parent-folder permissions are not changed. Evidence is not automatically deleted or overwritten.

An `exchange_id` is **caller-supplied** and stored as `caller_supplied_unverified`. This is a reference for your records, not proof that the visible screen matches that exchange. Keep the original request/response separately.

`list_evidence` returns small summaries in ascending capture-time order. Filter by `case_id`, `exchange_id`, `review_status`, or a case-insensitive `query` in labels, notes, and tags. Pass `next_cursor` as `after` for the next page and keep the same filter. This is live keyset pagination, not an immutable snapshot; records inserted behind the cursor will not appear in subsequent pages. A page scans at most 500 directories and can return an empty page with a continuation cursor.

`get_evidence` verifies the image against the manifest. The hash detects changes to the PNG relative to that manifest; it is not a digital signature or tamper-proof audit log.

### Capture options

| Option                  | Default | Meaning                                                                                                                                         |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `persist`               | `true`  | Save a PNG and evidence record.                                                                                                                 |
| `include_image`         | `false` | Return the PNG to the MCP client as an image.                                                                                                   |
| `save_path`             | unset   | Export an additional PNG copy to an absolute path inside the configured evidence directory. The parent must exist; existing files are rejected. |
| `case_id`               | unset   | Associate the evidence with a case.                                                                                                             |
| `label`, `note`, `tags` | unset   | Add searchable case context and descriptive metadata.                                                                                           |
| `exchange_id`           | unset   | Record an external exchange reference.                                                                                                          |

For an ephemeral capture, set `persist: false` and `include_image: true`. Ephemeral captures cannot use `save_path`.

Images up to **5 MiB** may be returned inline. Larger persisted screenshots remain complete on disk and produce an explicit omission warning. Ephemeral captures above the inline limit fail with guidance to enable persistence. Captures above **64 MiB** or **150 megapixels** are rejected. Images are not silently resized, cropped, redacted, or truncated.

### Environment

| Variable             | Default                     | Purpose                                                                                       |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `MCP_SCREENSHOT_DIR` | `~/Pictures/mcp-screenshot` | Absolute path for evidence storage.                                                           |
| `BLOCKED_APPS`       | empty                       | Comma-separated case-insensitive substrings matched against application names and bundle IDs. |

When `BLOCKED_APPS` is set, whole-display capture is disabled because it could include an excluded app. Window capture still works for allowed apps. This filter is not a sandbox: an allowed app can itself display other applications' contents, and already-saved evidence remains retrievable.

## Limits and troubleshooting

- **`SCREEN_RECORDING_REQUIRED`:** grant the launcher's recording permission in System Settings, then restart that launcher. A sandbox can also prevent capture even if normal execution is permitted.
- **`HELPER_MISSING`:** run `npm run build` on macOS and check that Command Line Tools are installed.
- **`AMBIGUOUS_WINDOW`:** select a `window_id`; do not rely on an app name when multiple project windows exist.
- **`WINDOW_NOT_FOUND`:** refresh the list. Closed, minimized, or off-space windows may not be available.
- **`STALE_WINDOW`:** list windows again and confirm the intended window before using its new selection token.
- **`REVIEW_CONFLICT`:** retrieve the current review revision before retrying.
- **`INVALID_REVIEW_HISTORY`:** preserve the review files for inspection; their structure or chain no longer agrees.
- **`WINDOW_CHANGED` / `WINDOW_UNSTABLE`:** wait for resizing/navigation to finish, then retry.
- **`QUEUE_FULL` / `QUEUE_TIMEOUT`:** wait for the active capture to finish. The queue allows eight total active/waiting captures and expires waiting jobs after 30 seconds. Active jobs keep their slot until their native operation actually finishes or times out.
- **`INTEGRITY_MISMATCH`:** the PNG and its evidence manifest no longer agree. Preserve the files for inspection.
- Protected, DRM, or otherwise non-capturable content may be absent or blank even with recording permission.

Burp Repeater tabs are **not OS windows**. This project does not enumerate/select Repeater tabs, read their request/response history, manipulate the clipboard, type, or click. Use the Burp MCP for application data and tab operations it supports.

## Development and validation

```sh
npm run typecheck
npm test
npm run build
node scripts/smoke.mjs
```

Tests cover window selection, changed-window rejection, permissions, queue serialization/cancellation, evidence integrity, pagination, compact responses, concurrent review conflicts, review chain corruption, offline export checksums/escaping, and the actual MCP protocol using an in-memory client. Run `node scripts/protocol-smoke.mjs` after building to verify the real stdio tool catalog.

To explicitly capture a Burp window through the real stdio server:

```sh
MCP_SCREENSHOT_DIR=/tmp/mcp-screenshot-smoke node scripts/smoke.mjs --capture-burp --window-id=12345
```

The smoke test saves a local PNG, retrieves it through MCP, and checks integrity. Its images are not repository fixtures. The [GitHub Actions template](docs/github-actions.yml) compiles the native helper on macOS and checks Node 22/24 on Linux/macOS. To enable it, place it at `.github/workflows/ci.yml` using a credential with workflow permissions. The template is not active yet. CI does not validate screen capture in a logged-in desktop session.

See [CHANGELOG.md](CHANGELOG.md) for versioned changes and [LICENSE](LICENSE) for licensing.

## Regions and reusable profiles (0.5)

Use `select_capture_region` with a `window_id` and optional `name`, for example
`burp-response`. A frozen preview opens locally: drag a rectangle.
Use Salvar apenas a seleção to confirm the region/profile, Capturar e salvar (Return) to save the approved crop of that exact preview, or Escape/Cancelar to cancel. Move the selection by dragging inside it; resize using its edges or eight handles. Arrow keys move it precisely (Shift: larger steps), and Limpar região clears it. Selection expires after 300 seconds;
clients with shorter call timeouts may need a longer timeout. Only one selector
session can run at a time per server process, including preview generation, settings and saving. Concurrent attempts return `SELECTION_BUSY` before creating another preview. Client cancellation is checked before applying a returned dialog action. No evidence is saved during selection. Local selector previews support up to 64 MiB; MCP inline images remain limited to 5 MiB. The capture queue is released before interactive selection.

Then call `capture_window` with the current `window_id` and
`profile: "burp-response"`. Profiles survive restarts. They require the same app
identity and window dimensions, but allow the window to move. They are geometric
markers: changing a panel divider, scrolling, zooming or switching tabs may change
what appears inside the region without triggering a mismatch. Recalibrate after
layout changes. No full-window fallback occurs when a profile fails.

For automation, `save_capture_profile` accepts `name`, `version: 1`, `app`
(bundle ID, or exact app name when unavailable), reference `width`/`height` in
window points, and `region: {x, y, width, height}` in normalized coordinates
between zero and one, with top-left origin. `list_capture_profiles` lists valid profiles and reports warnings for invalid files without blocking selection;
`delete_capture_profile` removes one. Names are immutable: use a new name or
explicitly delete and recreate. Each capture records the region actually used. Profile names must match their JSON filenames; malformed files cannot be used directly even if their filename is known. Application identifiers are bounded and reference dimensions must be finite. `PROFILE_EXISTS` never overwrites existing geometry. `PROFILE_RENAME_PARTIAL` means the new name was saved but removal of the old name failed: list and verify both, then explicitly delete the old name if desired. Do not blindly retry the rename.

All capture tools accept a direct `region` instead of a profile. A display preview
is available through `select_capture_region` with `display`; display selections
are one-monitor regions, cannot become window profiles, and use the `desktop`
folder. This version does not install global keyboard shortcuts or select across
multiple monitors in one gesture.

`capture_frontmost_window` resolves the foreground app before capturing. If it
has multiple visible windows, select one explicitly rather than guessing.

New evidence lives at `<root>/<project>/<app>/<UTC-timestamp>/screenshot.png` with its JSON
sidecar. Common folder names include `burp-suite`, `chrome`, `iterm2`, and
`desktop`; other names are sanitized. Legacy root-level evidence remains readable,
reviewable and exportable without migration. Profiles stay in the configured profile directory when the evidence destination changes.
The full source screenshot is temporary; only the requested crop is persisted.

The interactive selector also accepts optional `label`, `note`, `tags` and `exchange_id` and preserves them in saved evidence. Exchange IDs remain caller-supplied associations, not independently verified links. These fields are JSON metadata, not a text-caption sidecar.

## Capture workspace (0.6)

`select_capture_region` now opens a capture workspace. Start with a `window_id`
or `display`; the target menu can then switch between available windows and
monitors. **Imagem inteira** selects the entire current image. To capture a whole
screen, first choose its monitor in the target menu.

The profile menu shows profiles compatible with the current app and window size.
Load one to restore its rectangle. Enter a new name in the adjacent field to
create another profile. Existing names cannot silently overwrite geometry: use a
new name for adjustments. **Salvar apenas a seleção** returns the region and saves a named
profile; **Capturar e salvar** saves PNG/JSON evidence from the exact frozen preview, retaining its original capture time. Settings changes and retries keep that image; **Atualizar prévia** stays bound to the inspected window identity and obtains a new image and clears the previous selection and fixed-profile name for a new review. A new profile is created only after evidence saving succeeds. If profile creation then fails, the result returns the saved evidence and a warning, avoiding an accidental duplicate capture. **Limpar região** clears the region without deleting profiles.

**Pasta e gerenciamento de perfis…** opens a modal with the current evidence/profile paths, a native
folder chooser, and profile rename/delete actions. Deletion requires an explicit
confirmation in the modal and preserves existing evidence. Profile management and
folder changes apply immediately; cancelling the later selection does not undo
those already confirmed operations. Errors return to the workspace with a message.

Default evidence destination: `~/Pictures/mcp-screenshot`. The folder chooser saves
its preference in `~/Pictures/mcp-screenshot/settings.json`. Profiles remain in
`~/Pictures/mcp-screenshot/profiles`, independently of the selected evidence
folder. Existing screenshots are not moved when the destination changes; switch
back to their previous destination to browse/export them. `MCP_SCREENSHOT_DIR`
has priority and locks the destination chooser; when set, profiles also remain
under that configured root. Other already-running server processes must reconnect
to adopt a changed destination. Each interactive step allows five minutes.

The workspace groups its controls in a sidebar beside the image and shows selection dimensions in pixels. **Manter no topo** is enabled by default so changing application focus does not cover the selector; turn it off to allow other windows above it. It does not force keyboard focus back to itself.

## Project organization and sidebar (0.7)

New screenshots use `<destination>/<project>/<app>/<capture-id>/screenshot.png`
with `metadata.json` beside the PNG. The evidence ID retains the timestamp + UUID format inside `metadata.json`. Capture folder names use `YYYY-MM-DD_HH-mm-ss-SSS` in UTC; simultaneous captures receive `-2`, `-3`, etc., without overwriting existing folders. Set **Projeto** in the sidebar or `case_id` in capture tool arguments.
Without a project, a timestamp + UUID project name is generated and recorded as the evidence case ID. Simple lowercase project IDs such
as `cliente-a` remain readable; names needing normalization receive a short hash
suffix to distinguish them. The original case ID stays in the evidence metadata.

Lookup, review and export still support original flat evidence, app-first folders,
and ID-first folders. Existing files are not moved.

The resizable workspace uses a compact sidebar and a proportional preview. The
selection stays anchored to the image when resizing the workspace. **Capturar e
salvar** is the primary action (Return); **Salvar apenas a seleção** confirms the
region/profile without creating a screenshot. The sidebar scrolls on small screens.

Compact folder names are presentation only: use the returned evidence ID for MCP retrieval, reviews and exports. A missing manifest marks an incomplete capture and is not listed as evidence. Existing folders are not renamed.

## Suggested regions from natural-language requests

The MCP client interprets the request and inspects the image; the server does not contain a vision model or silently guess coordinates. The server advertises this workflow in its MCP instructions and tool descriptions:

1. Select the correct app tab/item using its connector or UI. Use `list_windows` for a fresh window token.
2. Inspect an uncropped `capture_window` preview with `persist: false, include_image: true` (omit `profile` and `region`).
3. Call `select_capture_region` with the user's `request` and a `suggestion` containing `region`, `source_sha256` from that preview, and a short `reason`. Coordinates are normalized 0–1 with a top-left origin. The dialog displays the request, explanation and editable selection. A stale preview hash discards the suggestion and asks for manual selection.
4. The user confirms or adjusts the proposal. Cancel saves nothing. Without a reliable suggestion, open the same dialog without `suggestion` for manual selection. A named profile is optional; never reuse a Proxy layout for Organizer merely because both are Burp windows.

For distinct-item batches, select and visually verify **each** item. Pass previous saved evidence IDs in `reject_same_as` (up to 20); a byte-identical PNG fails with `DUPLICATE_CAPTURE` before saving. Inspect the resulting images as well: different hashes do not prove different/correct items, and accessibility text alone may not match rendered content. For longer batches compare against all earlier hashes on the client. This guard is opt-in because legitimate repeated captures can be useful.

Reconnect the MCP client after upgrading to refresh tool schemas and server instructions.

Suggested selections reuse the exact inspected preview in the same connected MCP session (maximum four uncropped ephemeral images, five-minute expiry). Keep that session open between preview and selector calls. Window identity and bounds must still match. The preview stays frozen; Capturar e salvar saves that exact image with the approved crop and its original capture timestamp.

### Dynamic crops versus fixed profiles

A content-fitted suggestion is for **one capture**. For every new payload, response or item, inspect a fresh preview and recompute the useful visible area; leave `name` and `profile` unset. Confirmation does not create a profile unless the user names one. Profiles store fixed coordinates, not semantic rules, and do not grow with the response. Save/reuse one only when the user explicitly wants a fixed region. Text outside the visible viewport is not included in a screenshot.

## Starting a new AI session

Call `get_capture_guide` first: this read-only tool returns the self-contained workflow, coordinate formula, tool-call examples, client/server responsibilities and recovery steps. The same core instructions are advertised during MCP initialization. No conversation history is required. A vision-capable client is needed for automatic suggestions; otherwise use manual selection. Navigation needs a separate application connector or UI tool.

Keep the connection alive between preview and selector. Configure an interactive tool timeout of at least 330 seconds per step. After confirmation, inspect the tool result and retrieve the saved image rather than taking another screenshot. A selector opened successfully is not yet a saved image.

Evidence manifests are limited to 64 KiB of UTF-8 JSON at write time as well as read time. Oversized metadata is rejected without publishing evidence. Crop dimensions must agree with the recorded source region.

### Native build cache

`npm run build` always rebuilds the JavaScript bundle. On macOS it reuses the native helper only when the Swift source, compiler/SDK identity, relevant environment, architecture and executable hash match. Missing or damaged cache files trigger compilation. A failed compilation preserves the previous helper. To force a clean native compilation, run `MCP_SCREENSHOT_REBUILD_NATIVE=1 npm run build`.

### Interactive capture provenance

New confirmed captures include `selection.method`, `selection.source_sha256` (the uncropped preview hash) and `selection.confirmed_at` in their JSON metadata. `captured_at` remains the time the preview was captured; `sha256` describes the saved crop. These fields document the confirmation workflow, not independently verified Burp content or a vulnerability. The full preview is not persisted. Older evidence without these optional fields remains readable.

### Discovery diagnostics

`list_evidence` reports `discovery_warnings`, `ambiguous_ids` and `discovery_complete`. Damaged timestamp-folder manifests no longer prevent healthy evidence from being listed. Missing commit markers remain ignored as incomplete saves. Duplicate IDs are skipped in listings and rejected by reading, review and export with `AMBIGUOUS_EVIDENCE`; no copy is selected or deleted automatically. Reconcile duplicates explicitly before retrying. Pagination still uses `next_cursor`; `discovery_complete` describes discovery/validation diagnostics, not whether every page has been returned.

HTML and Markdown exports now show both the original capture time and optional confirmation time, together with the source-preview hash. Older captures without confirmation metadata remain supported.

### Optional visual description

Capture tools and the selector accept `description: {text, language, source}`. This describes the visible image content, not the reason it was captured. The AI client must inspect the intended crop and use the conversation language, unless another language is requested. For example:

```json
{
  "description": {
    "text": "Texto em português, em uma única linha sobre fundo verde-escuro, pedindo um novo teste de screenshot no iTerm2.",
    "language": "pt-BR",
    "source": "ai"
  }
}
```

The optional field is stored at `context.description` inside `metadata.json`, alongside the saved PNG's hash. Existing files are not renamed and no existing evidence is rewritten. The selector lets users edit or clear the text and choose its language; edits are attributed to `user`. Refreshing the preview or changing the target clears the description to prevent reuse with different content. Check the text against the final crop. The server does not run a vision model, OCR or translation; it preserves supplied descriptions. Descriptions are searchable and included in summary metadata and HTML/Markdown exports. Source attribution is caller-supplied. No `caption.txt` is created.
