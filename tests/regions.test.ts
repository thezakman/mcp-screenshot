import { it, expect } from "vitest";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pixelRegion, ProfileStore } from "../src/regions.js";
import { EvidenceStore, pngInfo } from "../src/evidence.js";
import { PNG, WINDOW } from "./helpers.js";
it("rounds outward, preserves edge pixels and rejects overflow", () => {
  expect(
    pixelRegion({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 5, 5),
  ).toEqual({ x: 1, y: 1, width: 3, height: 3 });
  expect(() =>
    pixelRegion({ x: 0.9, y: 0, width: 0.2, height: 1 }, 20, 20),
  ).toThrow();
});
it("persists profiles across instances and refuses overwrite or traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    const store = new ProfileStore(root);
    const profile = {
      name: "burp-response",
      version: 1 as const,
      app: WINDOW.bundleId,
      width: 800,
      height: 600,
      region: { x: 0.5, y: 0, width: 0.5, height: 1 },
    };
    await store.save(profile);
    expect(await new ProfileStore(root).get(profile.name)).toEqual(profile);
    await expect(store.save(profile)).rejects.toThrow();
    await expect(store.get("../escape")).rejects.toThrow();
    expect(await store.list()).toEqual([profile]);
    await store.delete(profile.name);
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reads both app folders and legacy evidence by ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "layout-test-"));
  try {
    const store = new EvidenceStore(root);
    const item = await store.save(PNG, {
      ...pngInfo(PNG),
      captured_at: new Date().toISOString(),
      mode: "window",
      window: WINDOW,
      verification: "window_identity_and_bounds",
      warnings: [],
    });
    expect(item.path).toContain("/burp-suite/");
    expect((await store.get(item.id)).id).toBe(item.id);
    await rename(dirname(item.path), join(root, item.id));
    expect((await store.get(item.id)).id).toBe(item.id);
    expect((await store.list()).items).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
