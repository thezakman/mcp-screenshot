# Changelog

## 0.8.0

- Accept agent-proposed regions tied to an inspected preview hash, with the original request and explanation in the editable confirmation dialog. Discard stale proposals.
- Advertise the inspect/propose/confirm workflow and per-item visual verification explicitly in MCP instructions and schemas.
- Add opt-in `reject_same_as` to reject identical batch screenshots before persistence.

## 0.7.1

- Generate a timestamp + UUID project name when the project is empty, recording it in evidence metadata.
- Use compact UTC capture folders (YYYY-MM-DD_HH-mm-ss-SSS), preserving full evidence IDs in JSON. Reserve collision suffixes exclusively and publish the manifest last.
- Recognize timestamp-named projects during evidence lookup, review and export.
- Show the automatic naming behavior in the project field placeholder.

## 0.7.0

- Redesign capture controls into a compact sidebar beside a proportional preview, with a resizable window and explicit action hierarchy.
- Preserve normalized selection geometry when resizing the workspace.
- Organize new evidence by project/app/capture-ID using case_id, with sem-projeto as the default.
- Retain read/review/export compatibility with previous directory layouts and add project-storage regression tests.

## 0.6.1

- Keep the capture workspace above other applications by default, with a visible toggle and no hiding on deactivation.
- Move controls above the image, clarify confirmation versus capture, and show live selection dimensions and keyboard hints.

## 0.6.0

- Add target/profile menus, full-image selection, named profile creation and capture-and-save to the native workspace.
- Add settings modal with folder chooser and profile rename/delete, keeping existing evidence intact.
- Persist the evidence destination independently from the profile library; environment configuration takes precedence.
- Add workflow and rename-conflict regression coverage.

## 0.5.1

- Make visual selections movable and resizable with eight handles, keyboard nudging, dimmed surroundings and explicit confirm/cancel/reset buttons.
- Explicitly focus the selection view and support both Return and keypad Enter. Allow five minutes for selection.

## 0.5.0

- Add normalized crops, frozen native region selection, persistent named profiles, and foreground-app capture.
- Organize new evidence by application while retaining legacy lookup, reviews and exports.
- Record crop geometry and source dimensions; reject incompatible profiles without full-window fallback.
- Add profile persistence, geometry and legacy-storage regression coverage.

## 0.4.0 — 2026-10-08

- Add `review_evidence`: append-only screenshot-quality reviews, explicit reviewer attribution, and optimistic revision conflicts.
- Add `export_evidence`: offline HTML gallery, Markdown report, original images/metadata/review events, and verified checksums.
- Filter evidence by review status and retrieve complete review history on demand.
- Keep review notes out of default compact responses while preserving them on disk.
- Expose the running server version in capture diagnostics.
- Expand the MCP catalog from nine to eleven tools; reconnect the client after rebuilding.

## 0.3.0 — 2026-10-08

- Add window-selection tokens to reject stale captures.
- Return compact summaries by default, with full metadata available explicitly.
- Stream integrity checks instead of loading full PNGs for metadata requests.
- Validate evidence manifests and PNG chunk integrity before saving.
- Keep version 1 evidence manifests readable.

## 0.2.0 — 2026-10-08

- Distinguish Burp Suite windows from Burp Browser.
- Publish optional exported copies atomically without overwriting existing files.
- Ignore unrelated directories when paginating evidence.
- Filter evidence by case, exchange ID, or text in labels, notes, and tags.
- Add real stdio smoke tests and a Linux/macOS CI template for Node 22 and 24. Activation requires a GitHub credential with workflow permissions.
- Document setup, MCP tools, evidence integrity, storage, permissions, and automation boundaries.
- Validate a real Burp window capture and evidence retrieval on macOS.

## 0.1.0 — 2026-10-08

- Initial standalone implementation with nine MCP tools.
- Native macOS window/display discovery and window-isolated PNG capture.
- Bounded serial capture queue, native timeouts, and window identity checks.
- Metadata-only responses by default, optional inline images, and explicit size limits.
- Local PNG/JSON evidence pairs with case metadata and SHA-256 verification.
- Evidence listing and retrieval without another screenshot.
