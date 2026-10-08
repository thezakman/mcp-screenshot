import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureService, type Backend } from "../src/capture.js";
import { EvidenceStore } from "../src/evidence.js";
import { PNG, WINDOW } from "./helpers.js";
let root: string, backend: Backend, service: CaptureService;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "capture-test-"));
  backend = {
    windows: vi.fn(async () => [WINDOW]),
    status: vi.fn(async () => ({
      platform: "darwin",
      screenRecording: true,
      accessibility: false,
    })),
    displays: vi.fn(async () => []),
    capture: vi.fn(async () => PNG),
  };
  service = new CaptureService(new EvidenceStore(root), backend, "");
});
afterEach(async () => rm(root, { recursive: true, force: true }));
describe("capture workflow", () => {
  it("captures only the chosen window and defaults to persisted metadata", async () => {
    const result = await service.capture({ window_id: 42 });
    expect(backend.capture).toHaveBeenCalledWith(["-o", "-l", "42"], undefined);
    expect(result.image).toBeUndefined();
    expect(result.metadata.persisted).toBe(true);
    expect(result.metadata.image_included).toBe(false);
  });
  it("rejects a window that changes during capture before saving", async () => {
    vi.mocked(backend.windows)
      .mockResolvedValueOnce([WINDOW])
      .mockResolvedValueOnce([WINDOW])
      .mockResolvedValueOnce([{ ...WINDOW, title: "other evidence" }]);
    await expect(service.capture({ window_id: 42 })).rejects.toThrow(
      "Image discarded",
    );
    expect((await service.store.list()).items).toHaveLength(0);
  });
  it("returns a clear permission error without invoking capture", async () => {
    vi.mocked(backend.status).mockResolvedValue({
      platform: "darwin",
      screenRecording: false,
      accessibility: false,
    });
    await expect(service.capture({ window_id: 42 })).rejects.toThrow(
      "Allow Screen",
    );
    expect(backend.capture).not.toHaveBeenCalled();
  });
  it("blocks disallowed windows even with explicit IDs", async () => {
    service = new CaptureService(new EvidenceStore(root), backend, "burp");
    await expect(service.capture({ window_id: 42 })).rejects.toThrow(
      "excluded",
    );
    expect(backend.capture).not.toHaveBeenCalled();
    await expect(service.capture({ display: 1 })).rejects.toThrow("disabled");
  });
  it("requires an actual output for ephemeral captures", async () => {
    await expect(
      service.capture({ window_id: 42, persist: false }),
    ).rejects.toThrow("include_image");
    const result = await service.capture({
      window_id: 42,
      persist: false,
      include_image: true,
    });
    expect(result.image).toBe(PNG.toString("base64"));
    expect(result.metadata.persisted).toBe(false);
    expect((await service.store.list()).items).toHaveLength(0);
  });
  it("does not capture an ambiguous Burp window", async () => {
    vi.mocked(backend.windows).mockResolvedValue([
      WINDOW,
      { ...WINDOW, id: 43 },
    ]);
    await expect(service.capture({ burp: true })).rejects.toThrow(
      "AMBIGUOUS_WINDOW",
    );
    expect(backend.capture).not.toHaveBeenCalled();
  });
});
it("rejects a reused OS window ID using the selection token without capturing", async () => {
  const { windowToken } = await import("../src/native.js");
  const token = windowToken(WINDOW);
  vi.mocked(backend.windows).mockResolvedValue([
    { ...WINDOW, pid: WINDOW.pid + 1 },
  ]);
  await expect(
    service.capture({ window_id: WINDOW.id, expected_window_token: token }),
  ).rejects.toThrow("changed since list_windows");
  expect(backend.capture).not.toHaveBeenCalled();
});
