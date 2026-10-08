import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore, pngInfo } from "../src/evidence.js";
import { exportEvidence } from "../src/export.js";
import { digest } from "../src/reviews.js";
import { PNG } from "./helpers.js";
let root: string, store: EvidenceStore, id: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "export-test-"));
  store = new EvidenceStore(root);
  id = (
    await store.save(
      PNG,
      {
        ...pngInfo(PNG),
        captured_at: new Date().toISOString(),
        mode: "display",
        display: 1,
        verification: "display_selected",
        warnings: [],
      },
      {
        case_id: "local",
        label: "<script>alert(1)</script>",
        note: "A & B",
        exchange_id: "exchange-local",
      },
    )
  ).id;
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it("exports originals, verified metadata, review history and an offline gallery", async () => {
  await store.review(id, {
    expected_revision: 0,
    status: "accepted",
    reviewer: "local test",
    note: "<img src=x onerror=alert(1)>",
  });
  const result = await exportEvidence(store, [id], "Local QA");
  expect(
    await readFile(join(result.path, "evidence", id, "screenshot.png")),
  ).toEqual(PNG);
  const html = await readFile(result.html_path, "utf8");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain("Original PNG");
  const lines = (await readFile(result.checksums_path, "utf8"))
    .trim()
    .split("\n");
  for (const line of lines) {
    const [hash, path] = line.split("  ");
    expect(digest(await readFile(join(result.path, path)))).toBe(hash);
  }
  expect(digest(await readFile(result.checksums_path))).toBe(
    result.sha256sums_sha256,
  );
  const manifest = JSON.parse(await readFile(result.manifest_path, "utf8"));
  expect(manifest.evidence[0].review.status).toBe("accepted");
  expect(manifest.evidence[0].review_history).toHaveLength(1);
  expect(manifest.evidence[0].path).toBeUndefined();
  expect(
    await readFile(join(result.path, "evidence", id, "reviews", "0001.json")),
  ).toEqual(await readFile(join(root, id, "reviews", "0001.json")));
});
it("does not publish a partial package when a source fails integrity checks", async () => {
  const item = await store.get(id);
  const changed = Buffer.from(PNG);
  changed[40] ^= 1;
  await writeFile(item.path, changed);
  await expect(exportEvidence(store, [id])).rejects.toThrow(
    "no longer matches",
  );
  expect(await readdir(join(root, "exports"))).toEqual([]);
});
it("rejects duplicates and cancellation before creating a package", async () => {
  await expect(exportEvidence(store, [id, id])).rejects.toThrow("distinct");
  const controller = new AbortController();
  controller.abort();
  await expect(
    exportEvidence(store, [id], "Cancelled", controller.signal),
  ).rejects.toThrow("CANCELLED");
});
