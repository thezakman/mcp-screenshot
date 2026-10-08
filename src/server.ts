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
        "Use list_windows then capture_window with window_id and expected_window_token. Captures save PNG + JSON locally; include_image is opt-in. Confirm content is visible: captures do not select tabs or verify exchange IDs. Reuse list_evidence/get_evidence before recapturing. Append screenshot reviews with review_evidence; export selected IDs with export_evidence for offline review. Review status is not vulnerability validation. Nothing is captured on connection.",
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
  return server;
}
