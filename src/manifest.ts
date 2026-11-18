import { masksSchema } from "./redaction.js";
import { regionSchema, pixelRegion } from "./regions.js";
import { z } from "zod";
import { ScreenshotError } from "./errors.js";
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const evidenceId = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/);
export const descriptionSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
    .max(35),
  source: z.enum(["ai", "user"]),
});
export const contextSchema = z.object({
  description: descriptionSchema.optional(),
  case_id: z.string().max(120).optional(),
  label: z.string().max(200).optional(),
  note: z.string().max(4000).optional(),
  source_item_id: z.string().trim().min(1).max(200).optional(),
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
    selection: z
      .object({
        method: z.literal("user_confirmed_frozen_preview"),
        source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed_at: z.string().datetime(),
      })
      .optional(),
    crop: z
      .object({
        region: regionSchema,
        source_width: z.number().int().positive(),
        source_height: z.number().int().positive(),
        profile: z.string().optional(),
      })
      .optional(),
    pre_exif_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
    image: z.enum(["screenshot.png", "screenshot_redacted.png"]),
    sensitive: z.boolean().nullable().default(null),
    redactions: masksSchema.optional(),
    original: z
      .object({
        image: z.literal("screenshot_original.png"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
    warnings: z.array(z.string().max(8192)).max(32),
  })
  .superRefine((value, ctx) => {
    const masked = !!value.redactions?.length;
    if (
      masked !== (value.image === "screenshot_redacted.png") ||
      (masked && value.sensitive !== true) ||
      (value.original && !masked)
    )
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent redaction metadata",
      });
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
    if (
      (value.mode === "window" && value.display !== undefined) ||
      (value.mode === "display" && value.window !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Capture cannot identify both a window and a display.",
      });
    if (value.selection && !value.crop)
      ctx.addIssue({
        code: "custom",
        message: "Confirmed selection requires crop provenance.",
      });
    if (value.crop) {
      const { region, source_width, source_height } = value.crop;
      const expected = pixelRegion(region, source_width, source_height);
      if (
        source_width * source_height > 150_000_000 ||
        expected.width !== value.width ||
        expected.height !== value.height
      )
        ctx.addIssue({
          code: "custom",
          message: "Crop dimensions do not match the source region.",
        });
    }
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
