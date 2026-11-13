import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG, WINDOW } from "./helpers.js";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings.js")>()),
  profilesRoot: () => state.root,
}));
vi.mock("../src/regions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/regions.js")>()),
  selectRegion: vi.fn(),
}));
import { selectRegion, ProfileStore } from "../src/regions.js";
import { runSelector } from "../src/selector.js";
import { CaptureService } from "../src/capture.js";
import { EvidenceStore } from "../src/evidence.js";
let service: CaptureService;
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "selector-test-"));
  service = new CaptureService(
    new EvidenceStore(state.root),
    {
      windows: async () => [WINDOW],
      status: async () => ({
        platform: "darwin",
        screenRecording: true,
        accessibility: false,
      }),
      displays: async () => [],
      capture: async () => PNG,
    },
    "",
    state.root,
  );
  vi.mocked(selectRegion).mockReset();
});
afterEach(async () => rm(state.root, { recursive: true, force: true }));
it("creates a profile through the dialog without persisting a screenshot", async () => {
  vi.mocked(selectRegion).mockResolvedValue({
    action: "confirm",
    name: "test-region",
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect((await new ProfileStore(state.root).get("test-region")).app).toBe(
    WINDOW.bundleId,
  );
  expect((await service.store.list()).items).toEqual([]);
});
it("keeps existing profiles intact and reopens with a useful error on name collision", async () => {
  const profiles = new ProfileStore(state.root);
  await profiles.save({
    name: "test-region",
    version: 1,
    app: WINDOW.bundleId,
    width: 800,
    height: 600,
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({
      action: "confirm",
      name: "test-region",
      region: { x: 0, y: 0, width: 0.5, height: 1 },
    })
    .mockResolvedValueOnce({
      action: "confirm",
      name: "new-region",
      region: { x: 0, y: 0, width: 0.5, height: 1 },
    });
  await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[1][2]?.error).toContain(
    "Name already exists",
  );
  expect((await profiles.get("test-region")).region.width).toBe(1);
  expect((await profiles.get("new-region")).region.width).toBe(0.5);
});
it("rename refuses collisions and preserves the source", async () => {
  const profiles = new ProfileStore(state.root);
  const p = {
    name: "original",
    version: 1 as const,
    app: "app",
    width: 800,
    height: 600,
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
  await profiles.save(p);
  await profiles.save({ ...p, name: "occupied" });
  await expect(profiles.rename("original", "occupied")).rejects.toThrow();
  expect((await profiles.get("original")).name).toBe("original");
  await profiles.rename("original", "renamed");
  expect((await profiles.get("renamed")).name).toBe("renamed");
  await expect(profiles.get("original")).rejects.toThrow();
});
