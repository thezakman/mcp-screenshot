import { it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  cp,
} from "node:fs/promises";
import { join, dirname } from "node:path";
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
  ).toEqual(
    await readFile(
      join(dirname((await store.get(id)).path), "reviews", "0001.json"),
    ),
  );
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

it("rejects ambiguous source IDs without publishing a partial export", async () => {
  const saved = await store.get(id);
  await cp(
    dirname(saved.path),
    join(root, "duplicate", "desktop", "2026-10-08_12-00-00-000"),
    { recursive: true },
  );
  await expect(exportEvidence(store, [id])).rejects.toMatchObject({
    code: "AMBIGUOUS_EVIDENCE",
  });
  expect(await readdir(join(root, "exports"))).toEqual([]);
});
it("includes confirmed-preview provenance in both human-readable reports", async () => {
  const selection = {
    method: "user_confirmed_frozen_preview" as const,
    source_sha256: pngInfo(PNG).sha256,
    confirmed_at: "2026-11-18T03:00:00.000Z",
  };
  const saved = await store.save(PNG, {
    ...pngInfo(PNG),
    captured_at: "2026-11-18T02:59:00.000Z",
    mode: "display",
    display: 1,
    verification: "display_selected",
    warnings: [],
    crop: {
      region: { x: 0, y: 0, width: 1, height: 1 },
      source_width: 1,
      source_height: 1,
    },
    selection,
  });
  const report = await exportEvidence(store, [saved.id]);
  for (const path of [report.html_path, report.markdown_path]) {
    const text = await readFile(path, "utf8");
    expect(text).toContain(selection.confirmed_at);
    expect(text).toContain("Source preview SHA-256");
    expect(text).toContain(selection.source_sha256);
    expect(text).toContain(saved.captured_at);
  }
});

it("exports visual descriptions without interpreting supplied text as HTML", async () => {
  const description = {
    text: "Texto visível <script>não executar</script>",
    language: "pt-BR",
    source: "ai" as const,
  };
  const saved = await store.save(
    PNG,
    {
      ...pngInfo(PNG),
      captured_at: new Date().toISOString(),
      mode: "display",
      display: 1,
      verification: "display_selected",
      warnings: [],
    },
    { description },
  );
  const result = await exportEvidence(store, [saved.id]);
  const html = await readFile(result.html_path, "utf8");
  expect(html).toContain('lang="pt-BR"');
  expect(html).toContain("&lt;script&gt;não executar&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(await readFile(result.markdown_path, "utf8")).toContain(
    "Image description (pt-BR)",
  );
  const exported = JSON.parse(
    await readFile(
      join(result.path, "evidence", saved.id, "metadata.json"),
      "utf8",
    ),
  );
  expect(exported.context.description).toEqual(description);
});
