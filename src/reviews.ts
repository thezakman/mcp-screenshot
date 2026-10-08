import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertDirectory, readBounded } from "./storage.js";
import { evidenceId } from "./manifest.js";
import { ScreenshotError } from "./errors.js";
export const reviewStatus = z.enum([
  "unreviewed",
  "accepted",
  "needs_recapture",
  "rejected",
]);
export const reviewInput = z.object({
  expected_revision: z.number().int().min(0).max(999),
  status: reviewStatus,
  reviewer: z.string().trim().min(1).max(120),
  note: z.string().trim().min(1).max(4000),
});
const eventSchema = z.object({
  schema_version: z.literal(1),
  evidence_id: evidenceId,
  image_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().min(1).max(1000),
  status: reviewStatus,
  reviewer: z.string().trim().min(1).max(120),
  note: z.string().trim().min(1).max(4000),
  reviewed_at: z.string().datetime(),
  previous_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  attribution: z.literal("caller_supplied"),
});
export type ReviewEvent = z.infer<typeof eventSchema> & {
  event_sha256: string;
  file: string;
};
export type ReviewState = {
  revision: number;
  status: z.infer<typeof reviewStatus>;
  latest?: ReviewEvent;
};
export const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export async function readReviews(
  directory: string,
  id: string,
  imageHash: string,
): Promise<{ review: ReviewState; history: ReviewEvent[] }> {
  const folder = join(directory, "reviews");
  try {
    await assertDirectory(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { review: { revision: 0, status: "unreviewed" }, history: [] };
    throw error;
  }
  const entries = (await readdir(folder))
    .filter((n) => !n.startsWith(".pending-"))
    .sort();
  if (entries.length > 1000 || entries.some((n) => !/^\d{4}\.json$/.test(n)))
    throw new ScreenshotError(
      "INVALID_REVIEW_HISTORY",
      "Review history has invalid entries.",
    );
  const history: ReviewEvent[] = [];
  let previous: string | null = null;
  for (const [index, name] of entries.entries()) {
    const data = await readBounded(join(folder, name), 32 * 1024);
    try {
      const event = eventSchema.parse(JSON.parse(data.toString("utf8")));
      if (
        event.evidence_id !== id ||
        event.image_sha256 !== imageHash ||
        event.revision !== index + 1 ||
        name !== String(event.revision).padStart(4, "0") + ".json" ||
        event.previous_sha256 !== previous
      )
        throw new Error("Invalid chain");
      previous = digest(data);
      history.push({ ...event, event_sha256: previous, file: name });
    } catch {
      throw new ScreenshotError(
        "INVALID_REVIEW_HISTORY",
        "Review events are malformed or their revision/hash chain no longer agrees.",
      );
    }
  }
  const latest = history.at(-1);
  return {
    review: latest
      ? { revision: latest.revision, status: latest.status, latest }
      : { revision: 0, status: "unreviewed" },
    history,
  };
}
export async function appendReview(
  directory: string,
  id: string,
  imageHash: string,
  input: z.infer<typeof reviewInput>,
) {
  input = reviewInput.parse(input);
  const current = await readReviews(directory, id, imageHash);
  if (current.review.revision !== input.expected_revision)
    throw new ScreenshotError(
      "REVIEW_CONFLICT",
      "Review changed. Retrieve get_evidence and use its current review revision.",
      true,
    );
  if (current.review.revision >= 1000)
    throw new ScreenshotError(
      "REVIEW_LIMIT",
      "Evidence reached the limit of 1000 review events.",
    );
  const folder = join(directory, "reviews");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await assertDirectory(folder);
  const event = eventSchema.parse({
    schema_version: 1,
    evidence_id: id,
    image_sha256: imageHash,
    revision: current.review.revision + 1,
    status: input.status,
    reviewer: input.reviewer,
    note: input.note,
    reviewed_at: new Date().toISOString(),
    previous_sha256: current.review.latest?.event_sha256 ?? null,
    attribution: "caller_supplied",
  });
  const data = JSON.stringify(event, null, 2) + "\n";
  const name = String(event.revision).padStart(4, "0") + ".json";
  const temp = await mkdtemp(join(folder, ".pending-"));
  try {
    const staged = join(temp, "event.json");
    await writeFile(staged, data, { flag: "wx", mode: 0o600 });
    try {
      await link(staged, join(folder, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ScreenshotError(
          "REVIEW_CONFLICT",
          "Another writer saved this review revision. Retrieve get_evidence before retrying.",
          true,
        );
      throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return {
    revision: event.revision,
    status: event.status,
    latest: { ...event, event_sha256: digest(data), file: name },
  };
}
