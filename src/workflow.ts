/** Shared onboarding contract exposed through initialize and a read-only tool. */
export const captureGuide = {
  version: 1,
  capabilities: {
    server:
      "Captures visible macOS windows, opens an interactive crop dialog, stores evidence and fixed geometric profiles. No internal vision model, tab navigation, scrolling or target requests.",
    client:
      "The AI client interprets the user's request and must actually view the image to propose a crop. Use another app connector/UI tool for navigation. Without vision or navigation, ask the user to select content or use the manual dialog; never invent coordinates or claim unseen content is verified.",
  },
  workflow: [
    "Read get_capture_status.preferences before image analysis. Pass locale (pt-BR or en) from the conversation. With explicit redaction or suggest_sensitive enabled, inspect the same preview for sensitive fields, and pass redact=true for an explicit request. Supply mask_suggestion={source_sha256,masks:[{region,style:'black',coverage:'full'}]} to select_capture_region. Boxes use normalized full-image coordinates. Only send geometry, never secret values in reasons, captions or metadata. Omit mask_suggestion if no reliable boxes; leave review to the user. No server-side OCR. Black/full is the default for secrets; blur/pixelate and partial coverage are cosmetic alternatives. Coverage defaults to full (100%); center80, center and center25 cover the middle 80%, 50% and 25% of the width. A new named profile remembers keep_original. Loading it restores the checkbox; an older profile defaults to off. A user can override it for one capture. An extra original is only written when masks are applied. Default exports use the primary PNG; include_original=true requires an explicit request. Read metadata.image rather than constructing a filename. sensitive=null means unclassified, false requires user review, true describes the source crop.",
    "Call get_capture_status for permissions/version. Select the requested tab/item with its app connector/UI; no need to resend requests. List_windows returns OS windows, not Burp tabs. Use list_windows(detail=full), choose the intended window_id and copy its selection_token to expected_window_token. Resolve ambiguity instead of choosing the first window.",
    "Call capture_window with window_id, expected_window_token, persist=false, include_image=true. Omit region and profile for this uncropped preview. Inspect the actual returned image, including the requested tab/item/content, not just accessibility text or successful selection metadata.",
    "Compute a NEW crop from the useful visible content for each request/payload/response/item. Given preview width W, height H and pixel bounds left,top,width,height, use x=left/W, y=top/H, width=width/W, height=height/H. Origin is top-left. Use IMAGE pixels, not macOS logical points or the resized chat rendering. All values must fit within 0..1. Include the entire requested visible content with reasonable margins. Hidden/scrolling content is not captured.",
    "Keep the SAME MCP server connection/process open. Call select_capture_region with the same window_id/token, request and suggestion={region,source_sha256,reason}; copy source_sha256 from the inspected uncropped preview. The server caches up to four previews for five minutes and validates window identity/bounds. Do not start a new stdio process between these calls. Omit name for dynamic crops. If uncertain, omit suggestion and open manual selection.",
    "Tell the user the selector is awaiting their adjustment/confirmation. Allow at least 330000 ms tool timeout for each 300-second interactive step; settings can open additional steps. Do not automatically press Enter, create a fixed profile, or bypass requested confirmation. The preview stays frozen during settings changes and retries. Saved selection metadata records the source preview hash and confirmation time; captured_at remains the original preview capture time. To inspect updated content, use Atualizar prévia, which clears the previous geometry and fixed-profile name for a new review. Capturar e salvar saves the approved crop from that exact frozen image, preserving its original capture time; Salvar apenas a seleção returns geometry without saving a screenshot. Wait for the tool result. Opening the window is not proof of a saved capture.",
    "If the result has metadata.persisted=true, use metadata.id/path; do not capture again. Retrieve get_evidence(id,include_image=true) to inspect the saved image and compare to the requested content. If only region was returned, report selection confirmed, not screenshot saved; capture it only when the user wants saving. Re-list windows for a fresh token before a later capture. Cancel/timeout is not success.",
    "For batches, keep one case_id for the project. Give each item a readable label and pass source_item_id when the connector supplies an ID. Use a qualified ID if IDs are local to a collection. These are caller-supplied references. Then select and visually verify every item independently. Recompute dynamic crops per item. Pass prior saved IDs in reject_same_as (up to 20) to capture_window or select_capture_region. Inspect all output images; different hashes do not prove different/correct content. If duplicate detection fails or content is wrong, stop, reselect and verify. Mark incorrect saved artifacts via review_evidence as rejected/needs_recapture, preserve originals, and report incomplete items honestly.",
  ],
  image_description:
    "After visually inspecting the actual intended crop, optionally supply description={text,language,source}. Describe visible content and relevant visual context, not why the screenshot was requested or what the agent did. Use the conversation language (e.g. pt-BR for Portuguese, en for English) unless the user requests another language. Do not merely repeat the application name, infer hidden content, or claim automatic OCR. Use source=ai for an AI-authored description. No server-side vision or translation is performed. The selector lets the user edit or clear the description; refreshing the preview or changing target clears stale descriptions. Review the text against the final crop before saving. Description is in metadata.json under context.description and bound to that record's PNG hash; source is caller-supplied attribution, not independent verification.",
  evidence_context:
    "select_capture_region accepts optional label, note, tags and exchange_id, retained when saving the confirmed image. exchange_id is caller-supplied and never proves that the visible content belongs to that exchange. These metadata fields do not create a caption.txt file.",
  fixed_profile_batches:
    "For a batch explicitly requesting a saved fixed profile, select and visually verify each tab, then use capture_window with profile and a shared case_id. This direct path does not open the selector per tab. Direct capture has no redaction stage and rejects unsupported arguments. If redaction or interactive review is requested, use select_capture_region. A fixed crop does not store masks.",
  fixed_profiles:
    "Profiles store fixed coordinates and the original-retention preference. Mask locations are reviewed per image. Leave name and profile unset for content-fitted requests. Create/reuse profiles only on explicit user request for a fixed region. Matching app/window size does not establish matching internal layout. Never automatically save a fitted Repeater crop as burp-repeater.",
  storage:
    "Captures default to the configured base/project/app/UTC-timestamp directory with metadata.json and the primary PNG named in its image field. Empty project generates timestamp+UUID; use one explicit case_id across a batch. Return actual paths from tool results. Caller-supplied exchange IDs and review status are not independently verified application identity or vulnerability validation.",
  recovery: {
    ambiguous_evidence:
      "AMBIGUOUS_EVIDENCE means multiple folders claim the same evidence ID. Do not choose, overwrite or delete a copy automatically. Report the ambiguity and let the user reconcile the duplicates before reading, reviewing or exporting that ID. list_evidence returns ambiguous_ids, discovery_warnings and discovery_complete; incomplete discovery must not be reported as a complete inventory.",
    selection_busy:
      "SELECTION_BUSY: finish or cancel the active selector before opening another. Only one complete selector session may run per server process, including preview generation and persistence. Do not retry concurrently or start another server to bypass it.",
    selection_cancelled:
      "Cancellation is not a saved capture. Previously confirmed destination changes and profile-management actions remain applied. Do not assume a timed-out save failed: reconcile the tool result or evidence before retrying.",
    invalid_profile:
      "PROFILE_NOT_FOUND: list profiles and choose an existing name or explicitly create one. INVALID_PROFILE: repair or explicitly delete/recreate the named file; never fall back to full-window capture. PROFILE_EXISTS: choose another name; geometry is immutable. PROFILE_RENAME_PARTIAL: the new name was created but removal of the old name failed; list and verify both before explicitly deleting the old name. Do not blindly retry rename or delete valid evidence.",
    stale_window:
      "Refresh list_windows and inspect a new preview before proposing again.",
    stale_preview:
      "An expired/missing preview with changed pixels opens manual selection. Retry preview and selector in the same connection; do not bypass by guessing a new hash.",
    duplicate_capture:
      "DUPLICATE_CAPTURE means no new file was saved. Select/verify the next item and retry; do not remove the guard just to make the batch succeed.",
    image_too_large:
      "If an inline preview exceeds the image limit, explain the limitation and use manual select_capture_region, whose local preview supports up to 64 MiB without persisting evidence. Do not propose an unseen crop.",
    missing_tools:
      "Reconnect the MCP client after upgrading to refresh tools and instructions. Do not assume a running connection loaded a rebuilt server.",
  },
  example: {
    note: "Illustrative bounds only, not coordinates to reuse on a real screen. For a 2000x1000 preview and rectangle (100,200,800,400):",
    preview: {
      tool: "capture_window",
      arguments: {
        window_id: 42,
        expected_window_token: "<selection_token from list_windows>",
        persist: false,
        include_image: true,
      },
    },
    selector: {
      tool: "select_capture_region",
      arguments: {
        window_id: 42,
        expected_window_token: "<same window token>",
        request: "Focus on the visible logo",
        suggestion: {
          region: { x: 0.05, y: 0.2, width: 0.4, height: 0.4 },
          source_sha256: "<sha256 from inspected preview>",
          reason: "Visible logo with a small margin",
        },
      },
    },
  },
};
export const captureInstructions = [
  "Call get_capture_guide for the complete capture workflow and examples; no screenshots are taken by that tool.",
  ...captureGuide.workflow,
  captureGuide.fixed_profiles,
  captureGuide.evidence_context,
  captureGuide.image_description,
  captureGuide.storage,
  "Never claim a batch complete from tool success or accessibility text alone. Nothing is captured on connection.",
].join("\n\n");
