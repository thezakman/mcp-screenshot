# MCP Screenshot

**Precise window captures. Small MCP responses. Traceable local evidence.**

MCP Screenshot gives AI clients a focused set of tools for capturing macOS windows and saving evidence. Capture Burp Suite, a browser, or a terminal without moving the mouse, switching tabs, or stealing focus.

Screenshots are saved as lossless PNGs alongside a JSON record. By default, the client receives only metadata; images enter the conversation only when requested.

## What it does

- **Window capture:** select an OS window by ID, application name, or title. Ambiguous selections fail instead of guessing.
- **Burp shortcut:** `capture_burp_screenshot` finds Burp Suite windows and accepts an optional exchange ID for recordkeeping.
- **Lossless evidence:** PNG, capture time, dimensions, SHA-256, window identity, case ID, label, notes, and tags.
- **Low context usage:** `include_image: false` by default; retrieve the image later without another capture.
- **Serialized captures:** a bounded queue prevents overlapping captures. Native operations have timeouts and cancelled queued work is skipped.
- **Integrity checks:** `get_evidence` checks the saved PNG against its hash, dimensions, and byte count.
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

| Tool                      | Purpose                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `get_capture_status`      | Check permissions, evidence directory, and queue size.                              |
| `list_windows`            | Discover visible, non-minimized OS windows with IDs, app names, titles, and bounds. |
| `list_displays`           | List active monitors for explicit whole-display capture.                            |
| `capture_window`          | Capture one window by ID or a unique app/title selection.                           |
| `screenshot_app`          | Capture a window belonging to an exact app name or bundle ID.                       |
| `capture_burp_screenshot` | Capture a Burp Suite window, with optional case/exchange metadata.                  |
| `take_screenshot`         | Capture an entire monitor, including other visible applications.                    |
| `list_evidence`           | Browse saved evidence summaries with filtering and pagination.                      |
| `get_evidence`            | Verify and retrieve an existing evidence record, optionally including its image.    |

Capture tools are annotated as non-destructive writes because they save files. They are not marked read-only merely because they do not interact with the target application.

## A typical evidence workflow

1. Display the content you want to document. Use the relevant application or its own MCP to select a tab or exchange.
2. Call `list_windows` to identify the exact window.
3. Call `capture_window` or `capture_burp_screenshot` with a case ID and label.
4. Keep the returned evidence ID and file path in your notes.
5. Use `get_evidence` when you need the image or want to verify its integrity.

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

## Evidence format

By default, captures are stored in `~/Pictures/mcp-screenshot`:

```text
<evidence directory>/
  <UTC timestamp>_<UUID>/
    screenshot.png
    evidence.json
```

Each record includes:

- Capture time in UTC, dimensions in pixels, byte count, and SHA-256.
- Capture mode and selected window metadata or display number.
- Optional `case_id`, `label`, `note`, `exchange_id`, and `tags`.
- What was checked and any warnings.

PNG and JSON are published together using a directory rename. New files use owner-only permissions; existing parent-folder permissions are not changed. Evidence is not automatically deleted or overwritten.

An `exchange_id` is **caller-supplied** and stored as `caller_supplied_unverified`. This is a reference for your records, not proof that the visible screen matches that exchange. Keep the original request/response separately.

`list_evidence` returns small summaries in ascending capture-time order. Filter by `case_id`, `exchange_id`, or a case-insensitive `query` in labels, notes, and tags. Pass `next_cursor` as `after` for the next page and keep the same filter. This is live keyset pagination, not an immutable snapshot; records inserted behind the cursor will not appear in subsequent pages. A page scans at most 500 directories and can return an empty page with a continuation cursor.

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

Tests cover window selection, changed-window rejection, permission errors, queue serialization/cancellation, evidence integrity, pagination, no-overwrite exports, and the actual MCP protocol using an in-memory client.

To explicitly capture a Burp window through the real stdio server:

```sh
MCP_SCREENSHOT_DIR=/tmp/mcp-screenshot-smoke node scripts/smoke.mjs --capture-burp --window-id=12345
```

The smoke test saves a local PNG, retrieves it through MCP, and checks integrity. Its images are not repository fixtures. The [GitHub Actions template](docs/github-actions.yml) compiles the native helper on macOS and checks Node 22/24 on Linux/macOS. To enable it, place it at `.github/workflows/ci.yml` using a credential with workflow permissions. The template is not active yet. CI does not validate screen capture in a logged-in desktop session.

See [CHANGELOG.md](CHANGELOG.md) for versioned changes and [LICENSE](LICENSE) for licensing.
