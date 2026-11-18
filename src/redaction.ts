import { z } from "zod";
import { pixelRegion, regionSchema, type Region } from "./regions.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { native } from "./native.js";

export const maskSchema = z
  .object({
    region: regionSchema,
    style: z.enum(["black", "blur", "pixelate"]),
    coverage: z
      .enum(["full", "center80", "center", "center25"])
      .default("full"),
  })
  .strict();
export const masksSchema = z.array(maskSchema).max(64);
export type Mask = z.infer<typeof maskSchema>;
export function appliedMasks(
  masks: Mask[],
  crop: Region,
  width: number,
  height: number,
) {
  const frame = pixelRegion(crop, width, height);
  return masks.flatMap((mask) => {
    const box = { ...mask.region };
    const inset = { full: 0, center80: 0.1, center: 0.25, center25: 0.375 }[
      mask.coverage
    ];
    box.x += box.width * inset;
    box.width *= 1 - 2 * inset;
    const area = pixelRegion(box, width, height);
    const x = Math.max(area.x, frame.x),
      y = Math.max(area.y, frame.y);
    const right = Math.min(area.x + area.width, frame.x + frame.width);
    const bottom = Math.min(area.y + area.height, frame.y + frame.height);
    if (right <= x || bottom <= y) return [];
    return [
      {
        ...mask,
        region: {
          x: (x - frame.x) / frame.width,
          y: (y - frame.y) / frame.height,
          width: (right - x) / frame.width,
          height: (bottom - y) / frame.height,
        },
      },
    ];
  });
}
export async function renderMasks(
  source: Buffer,
  masks: Mask[],
  signal?: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), "screenshot-redact-"));
  try {
    const input = join(dir, "input.png"),
      output = join(dir, "output.png");
    await writeFile(input, source, { mode: 0o600 });
    await native(
      "redact",
      [input, output, JSON.stringify(masks)],
      60000,
      signal,
    );
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
