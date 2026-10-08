import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore, pngInfo } from "../src/evidence.js";
import { PNG } from "./helpers.js";
let root: string, store: EvidenceStore, id: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "review-test-"));
  store = new EvidenceStore(root);
  id = (
    await store.save(PNG, {
      ...pngInfo(PNG),
      captured_at: new Date().toISOString(),
      mode: "display",
      display: 1,
      verification: "display_selected",
      warnings: [],
    })
  ).id;
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const review = {
  expected_revision: 0,
  status: "accepted" as const,
  reviewer: "local reviewer",
  note: "Readable screenshot.",
};
it("appends revisions without changing original metadata or image", async () => {
  const before = await store.get(id);
  const original = await readFile(before.manifest_path);
  expect(before.review.revision).toBe(0);
  await store.review(id, review);
  await store.review(id, {
    ...review,
    expected_revision: 1,
    status: "needs_recapture",
    note: "Need the other tab.",
  });
  const current = await store.get(id, true, 64 * 1024 * 1024, true);
  expect(current.data).toEqual(PNG);
  expect(await readFile(current.manifest_path)).toEqual(original);
  expect(current.review.status).toBe("needs_recapture");
  expect(current.review_history).toHaveLength(2);
  expect(current.review_history![1].previous_sha256).toBe(
    current.review_history![0].event_sha256,
  );
  expect(
    (await store.list({ review_status: "needs_recapture" })).items.map(
      (i) => i.id,
    ),
  ).toEqual([id]);
});
it("does not overwrite a concurrently written revision", async () => {
  const outcomes = await Promise.allSettled([
    store.review(id, review),
    store.review(id, { ...review, note: "Another review." }),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  expect((await store.get(id)).review.revision).toBe(1);
  await expect(store.review(id, review)).rejects.toThrow("Review changed");
});
it("detects a broken review hash chain", async () => {
  await store.review(id, review);
  await store.review(id, { ...review, expected_revision: 1 });
  const path = join(root, id, "reviews", "0001.json");
  const event = JSON.parse(await readFile(path, "utf8"));
  event.note = "Changed externally";
  await writeFile(path, JSON.stringify(event));
  await expect(store.get(id)).rejects.toThrow("hash chain");
});
it("rejects review directories that are symlinks", async () => {
  await symlink(tmpdir(), join(root, id, "reviews"));
  await expect(store.review(id, review)).rejects.toThrow(
    "regular evidence directory",
  );
});
it("does not review a changed original image", async () => {
  const item = await store.get(id);
  const changed = Buffer.from(PNG);
  changed[40] ^= 1;
  await writeFile(item.path, changed);
  await expect(store.review(id, review)).rejects.toThrow("no longer matches");
});
