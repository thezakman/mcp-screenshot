import { z } from "zod";
import { ScreenshotError } from "./errors.js";
export const evidenceId = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/);
export const contextSchema = z.object({
  case_id: z.string().max(120).optional(),
  label: z.string().max(200).optional(),
  note: z.string().max(4000).optional(),
  exchange_id: z.string().max(200).optional(),
  tags: z.array(z.string().max(80)).max(16).optional(),
});
export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});
export const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: evidenceId,
    context: contextSchema,
    captured_at: z.string().datetime(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(["window", "display"]),
    verification: z.enum(["window_identity_and_bounds", "display_selected"]),
    window: z
      .object({
        id: z.number().int().positive(),
        pid: z.number().int().positive(),
        app: z.string().max(4096),
        bundleId: z.string().max(4096),
        title: z.string().max(16384),
        bounds: boundsSchema,
      })
      .optional(),
    display: z.number().int().positive().optional(),
    association: z.enum(["caller_supplied_unverified", "none"]),
    image: z.literal("screenshot.png"),
    warnings: z.array(z.string().max(8192)).max(32),
  })
  .superRefine((value, ctx) => {
    if (
      (value.mode === "window" &&
        (!value.window ||
          value.verification !== "window_identity_and_bounds")) ||
      (value.mode === "display" &&
        (!value.display || value.verification !== "display_selected"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Capture identity is inconsistent.",
      });
    if (value.width * value.height > 150_000_000)
      ctx.addIssue({ code: "custom", message: "Image is too large." });
    if (
      value.association !==
      (value.context.exchange_id ? "caller_supplied_unverified" : "none")
    )
      ctx.addIssue({
        code: "custom",
        message: "Exchange association is inconsistent.",
      });
  });
export function parseManifest(data: Buffer, expectedId: string) {
  try {
    const item = manifestSchema.parse(JSON.parse(data.toString("utf8")));
    if (item.id !== expectedId) throw new Error("ID mismatch");
    return item;
  } catch {
    throw new ScreenshotError(
      "INVALID_MANIFEST",
      "Evidence manifest is malformed or inconsistent.",
    );
  }
}
