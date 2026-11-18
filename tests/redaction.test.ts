import { expect, it } from "vitest";
import { appliedMasks, maskSchema, type Mask } from "../src/redaction.js";
import { EvidenceStore, pngInfo } from "../src/evidence.js";
import { exportEvidence } from "../src/export.js";
import { PNG } from "./helpers.js";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const full = { x: 0, y: 0, width: 1, height: 1 };
const mask: Mask = { style: "black", coverage: "center", region: full };
it("applies middle coverage before clipping and reports actual crop pixels", () => {
  expect(
    appliedMasks([mask], { x: 0.5, y: 0, width: 0.5, height: 1 }, 100, 50),
  ).toEqual([{ ...mask, region: { ...full, width: 0.5 } }]);
  expect(
    appliedMasks([mask], { x: 0, y: 0, width: 0.1, height: 1 }, 100, 50),
  ).toEqual([]);
});
it.each([
  ["full", 0, 1],
  ["center80", 0.1, 0.8],
  ["center", 0.25, 0.5],
  ["center25", 0.375, 0.25],
] as const)(
  "centers %s horizontally and preserves height",
  (coverage, x, width) => {
    expect(
      appliedMasks([{ ...mask, coverage }], full, 200, 100)[0].region,
    ).toEqual({
      x,
      y: 0,
      width,
      height: 1,
    });
  },
);
it("defaults omitted mask coverage to the entire value", () => {
  expect(maskSchema.parse({ style: "blur", region: full }).coverage).toBe(
    "full",
  );
});
it("uses the primary image by default and exports a verified original only on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "redaction-test-"));
  try {
    const store = new EvidenceStore(root);
    const meta = {
      ...pngInfo(PNG),
      mode: "display" as const,
      display: 1,
      captured_at: new Date().toISOString(),
      verification: "display_selected" as const,
      warnings: [],
    };
    const old = await store.save(PNG, meta);
    const manifest = JSON.parse(await readFile(old.manifest_path, "utf8"));
    delete manifest.sensitive;
    await writeFile(old.manifest_path, JSON.stringify(manifest));
    expect((await store.get(old.id)).sensitive).toBeNull();
    expect(
      (await store.save(PNG, { ...meta, sensitive: false })).sensitive,
    ).toBe(false);
    const item = await store.save(
      PNG,
      { ...meta, redactions: [mask], sensitive: true },
      {},
      PNG,
    );
    expect((await store.get(item.id, true)).path).toBe(item.path);
    for (const include of [false, true]) {
      const bundle = await exportEvidence(
        store,
        [item.id],
        "Test",
        undefined,
        include,
      );
      const dir = join(bundle.path, "evidence", item.id);
      const files = await readdir(dir);
      expect(files.includes("screenshot_original.png")).toBe(include);
      const manifest = JSON.parse(
        await readFile(join(dir, "metadata.json"), "utf8"),
      );
      expect(Boolean(manifest.original)).toBe(include);
      expect(manifest.image).toBe("screenshot_redacted.png");
      expect(await readFile(bundle.html_path, "utf8")).toContain(item.image);
    }
    await writeFile(
      join(item.path, "..", "screenshot_original.png"),
      Buffer.from("changed"),
    );
    await expect(
      exportEvidence(store, [item.id], "Test", undefined, true),
    ).rejects.toThrow("checksum");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
