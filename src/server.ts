import { runSelector, selectionSuggestionSchema } from "./selector.js";
import { profilesRoot } from "./settings.js";
import {
  ProfileStore,
  profileSchema,
  profileName,
  regionSchema,
  selectRegion,
} from "./regions.js";
import { native } from "./native.js";
import { reviewInput, reviewStatus } from "./reviews.js";
import { exportEvidence } from "./export.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CaptureService, MAX_IMAGE_BYTES } from "./capture.js";
import { presentEvidence, presentReview } from "./responses.js";
import { windowToken } from "./native.js";
import { failure } from "./errors.js";
const detailField = z.enum(["summary", "full"]).default("summary");
const evidenceFields = {
  reject_same_as: z
    .array(z.string().max(160))
    .max(20)
    .optional()
    .describe(
      "For distinct-item batches, pass previous evidence IDs. Identical PNGs are rejected before saving; this does not verify item identity.",
    ),
  region: regionSchema
    .optional()
    .describe(
      "Normalized image region, top-left origin. Explicit crop; never falls back to full image.",
    ),
  profile: profileName
    .optional()
    .describe(
      "Saved region profile; requires matching app and window dimensions.",
    ),
  detail: detailField,
  persist: z
    .boolean()
    .default(true)
    .describe("Save lossless PNG and JSON evidence sidecar."),
  include_image: z
    .boolean()
    .default(false)
    .describe(
      "Include image in MCP context (up to 5 MiB). Default returns metadata only.",
    ),
  case_id: z.string().trim().min(1).max(120).optional(),
  label: z.string().max(200).optional(),
  note: z.string().max(4000).optional(),
  exchange_id: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Caller-supplied Burp exchange ID; association is recorded, not independently verified.",
    ),
  tags: z.array(z.string().max(80)).max(16).optional(),
  save_path: z
    .string()
    .max(2048)
    .optional()
    .describe(
      "Optional extra PNG copy: absolute path within MCP_SCREENSHOT_DIR; existing files never overwritten.",
    ),
};
const windowFields = {
  expected_window_token: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      "Token from list_windows; reject stale window identity before capturing.",
    ),
  window_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("OS window ID from list_windows; not a Burp Repeater tab ID."),
  app_name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Exact application name or bundle ID from list_windows."),
  title: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Window title substring; ambiguous matches are rejected."),
};
const readAnnotations = { readOnlyHint: true, openWorldHint: false };
const captureAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
async function guarded(
  job: () => Promise<{
    content: (
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    )[];
  }>,
) {
  try {
    return await job();
  } catch (error) {
    return { isError: true, ...textResult({ error: failure(error) }) };
  }
}
export function createServer(service = new CaptureService(), version = "dev") {
  const server = new McpServer(
    { name: "mcp-screenshot", version },
    {
      instructions:
        "For natural-language region requests, inspect a fresh uncropped preview with capture_window(persist=false, include_image=true), infer the requested visible region, then call select_capture_region with request and suggestion (normalized top-left region, source_sha256 from that preview, reason). The native dialog always lets the user confirm or adjust before saving. If unsure, omit suggestion and let the user draw; never invent coordinates. Reuse only a profile appropriate to the current internal layout (Burp Organizer is different from Proxy); app and window size alone do not establish compatibility. For multiple items, select each item using its application tools/UI and verify the actual rendered request/response before capture. Pass previous evidence IDs in reject_same_as, inspect each saved image, and never claim a batch complete from tool success or accessibility text alone. A different hash does not prove correct identity. Use list_windows then capture_window with window_id and expected_window_token. Captures save PNG + JSON locally; include_image is opt-in. Confirm content is visible: captures do not select tabs or verify exchange IDs. Reuse list_evidence/get_evidence before recapturing. Append screenshot reviews with review_evidence; export selected IDs with export_evidence for offline review. Review status is not vulnerability validation. Nothing is captured on connection.",
    },
  );
  server.registerTool(
    "get_capture_status",
    {
      description:
        "Check local capture permissions, evidence folder and queue status.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      guarded(async () => textResult({ version, ...(await service.status()) })),
  );
  server.registerTool(
    "list_windows",
    {
      description:
        "List visible, non-minimized OS windows with IDs, app names, titles and bounds. Burp Repeater tabs are not OS windows.",
      inputSchema: {
        app_name: z.string().max(200).optional(),
        title: z.string().max(500).optional(),
        detail: detailField,
      },
      annotations: readAnnotations,
    },
    (args) =>
      guarded(async () =>
        textResult({
          windows: (await service.windows(args)).map((w) => ({
            ...(args.detail === "full"
              ? w
              : {
                  id: w.id,
                  pid: w.pid,
                  app: w.app,
                  title: w.title,
                  bundleId: w.bundleId,
                }),
            selection_token: windowToken(w),
          })),
        }),
      ),
  );
  server.registerTool(
    "list_displays",
    {
      description:
        "List active monitors for explicit whole-display screenshots.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      guarded(async () => textResult({ displays: await service.displays() })),
  );
  const captureResult = async (
    options: Parameters<CaptureService["capture"]>[0] & {
      detail?: "summary" | "full";
    },
    signal: AbortSignal,
  ) => {
    const { metadata, image } = await service.capture(options, signal);
    return {
      content: [
        ...textResult(presentEvidence(metadata, options.detail)).content,
        ...(image
          ? [{ type: "image" as const, data: image, mimeType: "image/png" }]
          : []),
      ],
    };
  };
  server.registerTool(
    "capture_window",
    {
      description:
        "Capture one OS window without changing focus. Rejects ambiguous selection and window changes; saves PNG and evidence metadata.",
      inputSchema: { ...windowFields, ...evidenceFields },
      annotations: captureAnnotations,
    },
    (args, extra) => guarded(() => captureResult(args, extra.signal)),
  );
  server.registerTool(
    "screenshot_app",
    {
      description:
        "Capture a window of an application by exact app name or bundle ID; specify window_id/title if it has multiple windows. Does not switch focus.",
      inputSchema: {
        ...windowFields,
        app_name: z.string().min(1).max(200),
        ...evidenceFields,
      },
      annotations: captureAnnotations,
    },
    (args, extra) => guarded(() => captureResult(args, extra.signal)),
  );
  server.registerTool(
    "capture_burp_screenshot",
    {
      description:
        "Capture the visible Burp Suite window. Select window_id if multiple Burp windows exist. Does not select Repeater tabs or resend traffic.",
      inputSchema: {
        window_id: windowFields.window_id,
        expected_window_token: windowFields.expected_window_token,
        title: windowFields.title,
        ...evidenceFields,
      },
      annotations: captureAnnotations,
    },
    (args, extra) =>
      guarded(() => captureResult({ ...args, burp: true }, extra.signal)),
  );
  server.registerTool(
    "take_screenshot",
    {
      description:
        "Capture an entire monitor. Includes other visible apps; disabled when BLOCKED_APPS is configured.",
      inputSchema: {
        display: z.number().int().min(1).default(1),
        ...evidenceFields,
      },
      annotations: captureAnnotations,
    },
    (args, extra) => guarded(() => captureResult(args, extra.signal)),
  );
  server.registerTool(
    "list_evidence",
    {
      description:
        "List locally saved evidence summaries in capture-time order. Continue with next_cursor as after; no screenshots are taken.",
      inputSchema: {
        review_status: reviewStatus.optional(),
        case_id: z.string().max(120).optional(),
        exchange_id: z.string().max(200).optional(),
        query: z.string().min(1).max(200).optional(),
        after: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readAnnotations,
    },
    (args) => guarded(async () => textResult(await service.store.list(args))),
  );
  server.registerTool(
    "get_evidence",
    {
      description:
        "Retrieve an evidence record by ID and verify its PNG hash. Optionally return the image, up to 5 MiB, without recapturing.",
      inputSchema: {
        id: z.string().max(100),
        include_review_history: z.boolean().default(false),
        detail: detailField,
        include_image: z.boolean().default(false),
      },
      annotations: readAnnotations,
    },
    (args) =>
      guarded(async () => {
        const { data, ...item } = await service.store.get(
          args.id,
          args.include_image,
          MAX_IMAGE_BYTES,
          args.include_review_history,
        );
        const inline = data && data.length <= MAX_IMAGE_BYTES;
        if (data && !inline)
          item.warnings.push(
            "Inline image omitted: exceeds 5 MiB; full PNG remains available at path.",
          );
        return {
          content: [
            ...textResult({
              ...presentEvidence(
                { ...item, image_included: !!inline },
                args.detail,
              ),
              ...(args.include_review_history
                ? { review_history: item.review_history }
                : {}),
            }).content,
            ...(inline
              ? [
                  {
                    type: "image" as const,
                    data: data.toString("base64"),
                    mimeType: "image/png",
                  },
                ]
              : []),
          ],
        };
      }),
  );
  server.registerTool(
    "review_evidence",
    {
      description:
        "Append a review of screenshot quality without changing the original PNG or capture metadata. Reviewer identity is caller-supplied. Use the revision from get_evidence to avoid overwriting another review.",
      inputSchema: { id: z.string().max(100), ...reviewInput.shape },
      annotations: captureAnnotations,
    },
    (args) =>
      guarded(async () => {
        const result = await service.store.review(args.id, args);
        return textResult({
          id: result.id,
          review: presentReview(result.review),
        });
      }),
  );
  server.registerTool(
    "export_evidence",
    {
      description:
        "Build an offline HTML/Markdown review package from 1–50 existing evidence IDs. Verify originals and copy them losslessly; never recapture or upload. Returns local paths only.",
      inputSchema: {
        ids: z.array(z.string().max(100)).min(1).max(50),
        title: z.string().trim().min(1).max(200).default("Evidence review"),
      },
      annotations: captureAnnotations,
    },
    (args, extra) =>
      guarded(async () =>
        textResult(
          await exportEvidence(
            service.store,
            args.ids,
            args.title,
            extra.signal,
          ),
        ),
      ),
  );
  const profiles = new ProfileStore(profilesRoot());
  server.registerTool(
    "save_capture_profile",
    {
      description:
        "Create an immutable named geometric profile from explicit normalized coordinates and reference window dimensions. Existing names are never overwritten.",
      inputSchema: profileSchema.shape,
      annotations: captureAnnotations,
    },
    (args) => guarded(async () => textResult(await profiles.save(args))),
  );
  server.registerTool(
    "list_capture_profiles",
    {
      description:
        "List saved geometric region profiles. Layout changes require recalibration.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () => guarded(async () => textResult({ profiles: await profiles.list() })),
  );
  server.registerTool(
    "delete_capture_profile",
    {
      description:
        "Delete a named region profile; saved evidence remains unchanged.",
      inputSchema: { name: profileName },
      annotations: { ...captureAnnotations, destructiveHint: true },
    },
    (args) =>
      guarded(async () => {
        await profiles.delete(args.name);
        return textResult({ deleted: args.name });
      }),
  );
  server.registerTool(
    "select_capture_region",
    {
      description:
        "Required confirmation step for suggested natural-language crops. First inspect capture_window(persist=false, include_image=true) without crop/profile. Send request and suggestion using that preview hash and normalized top-left coordinates; stale suggestions are discarded. The server does not infer semantics itself. Open the capture workspace with a window/display preview, saved profiles, target selection, full-image selection and settings. Confirm returns a region and optionally creates a profile; Capture and save persists evidence. Each interactive step expires after 300 seconds.",
      inputSchema: {
        ...windowFields,
        request: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "User's intended content, displayed in the confirmation dialog.",
          ),
        suggestion: selectionSuggestionSchema.optional(),
        case_id: z.string().trim().max(120).optional(),
        display: z.number().int().positive().optional(),
        name: profileName.optional(),
      },
      annotations: captureAnnotations,
    },
    (args, extra) =>
      guarded(async () => {
        if (
          args.display &&
          (args.window_id || args.app_name || args.title || args.name)
        )
          throw new Error("Choose a window profile or a display selection.");
        return textResult(await runSelector(service, args, extra.signal));
      }),
  );
  server.registerTool(
    "capture_frontmost_window",
    {
      description:
        "Capture the frontmost application's unique visible window. Multiple windows require explicit selection.",
      inputSchema: evidenceFields,
      annotations: captureAnnotations,
    },
    (args, extra) =>
      guarded(async () => {
        const { pid } = await native<{ pid: number }>("frontmost");
        const windows = (await service.windows()).filter((w) => w.pid === pid);
        if (windows.length !== 1)
          throw new Error(
            "AMBIGUOUS_WINDOW: select an explicit window with list_windows.",
          );
        return captureResult(
          {
            ...args,
            window_id: windows[0].id,
            expected_window_token: windowToken(windows[0]),
          },
          extra.signal,
        );
      }),
  );
  return server;
}
