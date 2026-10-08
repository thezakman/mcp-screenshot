# Changelog

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
