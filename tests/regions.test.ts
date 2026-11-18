import { it, expect, vi } from "vitest";
import { mkdtemp, rm, rename, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pixelRegion, ProfileStore, profileSchema } from "../src/regions.js";
import {
  EvidenceStore,
  pngInfo,
  projectFolder,
  captureFolder,
} from "../src/evidence.js";
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
    expect(
      item.path.endsWith(
        join(
          item.context.case_id!,
          "burp-suite",
          captureFolder(item.captured_at),
          "screenshot.png",
        ),
      ),
    ).toBe(true);
    // Previous app-first format.
    await mkdir(join(root, "burp-suite"));
    await rename(dirname(item.path), join(root, "burp-suite", item.id));
    expect((await store.get(item.id)).id).toBe(item.id);
    // ID-first format.
    await mkdir(join(root, item.id));
    await rename(
      join(root, "burp-suite", item.id),
      join(root, item.id, "burp-suite"),
    );
    expect((await store.get(item.id)).id).toBe(item.id);
    // Original flat format.
    await rename(
      join(root, item.id, "burp-suite"),
      join(root, "legacy-staging"),
    );
    await rm(join(root, item.id), { recursive: true });
    await rename(join(root, "legacy-staging"), join(root, item.id));
    expect((await store.get(item.id)).id).toBe(item.id);
    expect((await store.list()).items).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses project/app/capture folders and keeps project names path-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "projects-test-"));
  try {
    const store = new EvidenceStore(root);
    const meta = {
      ...pngInfo(PNG),
      captured_at: new Date().toISOString(),
      mode: "window" as const,
      window: WINDOW,
      verification: "window_identity_and_bounds" as const,
      warnings: [],
    };
    const first = await store.save(PNG, meta, { case_id: "cliente-a" });
    const second = await store.save(
      PNG,
      { ...meta, window: { ...WINDOW, app: "Google Chrome" } },
      { case_id: "cliente-a" },
    );
    expect(
      first.path.endsWith(
        join(
          "cliente-a",
          "burp-suite",
          captureFolder(first.captured_at),
          "screenshot.png",
        ),
      ),
    ).toBe(true);
    expect(
      second.path.endsWith(
        join(
          "cliente-a",
          "chrome",
          captureFolder(second.captured_at),
          "screenshot.png",
        ),
      ),
    ).toBe(true);
    expect((await store.list({ case_id: "cliente-a" })).items).toHaveLength(2);
    expect((await store.get(second.id)).context.case_id).toBe("cliente-a");
    expect(projectFolder("../escape")).toMatch(/^escape-[a-f0-9]{10}$/);
    expect(projectFolder(undefined)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}$/,
    );
    expect(projectFolder(" ")).not.toBe(projectFolder(""));
    expect(projectFolder("sem-projeto")).not.toBe("sem-projeto");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("isolates malformed and misnamed profiles while reporting actionable warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-corrupt-"));
  try {
    const store = new ProfileStore(root);
    const profile = {
      name: "healthy",
      version: 1 as const,
      app: "app",
      width: 800,
      height: 600,
      region: { x: 0, y: 0, width: 1, height: 1 },
    };
    await store.save(profile);
    await writeFile(join(root, "profiles", "broken.json"), "{invalid");
    await writeFile(
      join(root, "profiles", "misnamed.json"),
      JSON.stringify(profile),
    );
    const result = await store.scan();
    expect(result.profiles).toEqual([profile]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("broken.json");
    expect(await store.list()).toEqual([profile]);
    await expect(store.get("misnamed")).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
    await expect(store.get("broken")).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
    await expect(store.get("missing")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects unbounded application identifiers and non-finite reference dimensions", () => {
  const profile = {
    name: "fixed",
    version: 1,
    app: "app",
    width: 800,
    height: 600,
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
  expect(
    profileSchema.safeParse({ ...profile, app: "界".repeat(65536) }).success,
  ).toBe(false);
  expect(profileSchema.safeParse({ ...profile, width: Infinity }).success).toBe(
    false,
  );
  expect(
    profileSchema.safeParse({ ...profile, height: Infinity }).success,
  ).toBe(false);
});
it("reports immutable-name conflicts and partial renames without losing either profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-rename-"));
  const store = new ProfileStore(root);
  const profile = {
    name: "original",
    version: 1 as const,
    app: "app",
    width: 800,
    height: 600,
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
  try {
    await store.save(profile);
    await expect(store.save(profile)).rejects.toMatchObject({
      code: "PROFILE_EXISTS",
    });
    const deletion = vi
      .spyOn(store, "delete")
      .mockRejectedValueOnce(new Error("Read only"));
    await expect(store.rename("original", "renamed")).rejects.toMatchObject({
      code: "PROFILE_RENAME_PARTIAL",
    });
    deletion.mockRestore();
    expect((await store.get("original")).region).toEqual(profile.region);
    expect((await store.get("renamed")).region).toEqual(profile.region);
    expect(await store.list()).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
