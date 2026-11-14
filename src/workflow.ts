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
    "Call get_capture_status for permissions/version. Select the requested tab/item with its app connector/UI; no need to resend requests. List_windows returns OS windows, not Burp tabs. Use list_windows(detail=full), choose the intended window_id and copy its selection_token to expected_window_token. Resolve ambiguity instead of choosing the first window.",
    "Call capture_window with window_id, expected_window_token, persist=false, include_image=true. Omit region and profile for this uncropped preview. Inspect the actual returned image, including the requested tab/item/content, not just accessibility text or successful selection metadata.",
    "Compute a NEW crop from the useful visible content for each request/payload/response/item. Given preview width W, height H and pixel bounds left,top,width,height, use x=left/W, y=top/H, width=width/W, height=height/H. Origin is top-left. Use IMAGE pixels, not macOS logical points or the resized chat rendering. All values must fit within 0..1. Include the entire requested visible content with reasonable margins. Hidden/scrolling content is not captured.",
    "Keep the SAME MCP server connection/process open. Call select_capture_region with the same window_id/token, request and suggestion={region,source_sha256,reason}; copy source_sha256 from the inspected uncropped preview. The server caches up to four previews for five minutes and validates window identity/bounds. Do not start a new stdio process between these calls. Omit name for dynamic crops. If uncertain, omit suggestion and open manual selection.",
    "Tell the user the selector is awaiting their adjustment/confirmation. Allow at least 330000 ms tool timeout for each 300-second interactive step; settings can open additional steps. Do not automatically press Enter, create a fixed profile, or bypass requested confirmation. The preview is frozen. Capturar e salvar takes a fresh screenshot with the approved geometry; Salvar apenas a seleção returns geometry without saving a screenshot. Wait for the tool result. Opening the window is not proof of a saved capture.",
    "If the result has metadata.persisted=true, use metadata.id/path; do not capture again. Retrieve get_evidence(id,include_image=true) to inspect the saved image and compare to the requested content. If only region was returned, report selection confirmed, not screenshot saved; capture it only when the user wants saving. Re-list windows for a fresh token before a later capture. Cancel/timeout is not success.",
    "For batches, keep one case_id for the project; select and visually verify every item independently. Recompute dynamic crops per item. Pass prior saved IDs in reject_same_as (up to 20) to capture_window or select_capture_region. Inspect all output images; different hashes do not prove different/correct content. If duplicate detection fails or content is wrong, stop, reselect and verify. Mark incorrect saved artifacts via review_evidence as rejected/needs_recapture, preserve originals, and report incomplete items honestly.",
  ],
  fixed_profiles:
    "Profiles store fixed coordinates only, not semantic rules. Leave name and profile unset for content-fitted requests. Create/reuse profiles only on explicit user request for a fixed region. Matching app/window size does not establish matching internal layout. Never automatically save a fitted Repeater crop as burp-repeater.",
  storage:
    "Captures default to the configured base/project/app/UTC-timestamp directory with screenshot.png and evidence.json. Empty project generates timestamp+UUID; use one explicit case_id across a batch. Return actual paths from tool results. Caller-supplied exchange IDs and review status are not independently verified application identity or vulnerability validation.",
  recovery: {
    stale_window:
      "Refresh list_windows and inspect a new preview before proposing again.",
    stale_preview:
      "An expired/missing preview with changed pixels opens manual selection. Retry preview and selector in the same connection; do not bypass by guessing a new hash.",
    duplicate_capture:
      "DUPLICATE_CAPTURE means no new file was saved. Select/verify the next item and retry; do not remove the guard just to make the batch succeed.",
    image_too_large:
      "If an inline preview exceeds the image limit, explain the limitation and use manual select_capture_region. Do not propose an unseen crop.",
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
  captureGuide.storage,
  "Never claim a batch complete from tool success or accessibility text alone. Nothing is captured on connection.",
].join("\n\n");
