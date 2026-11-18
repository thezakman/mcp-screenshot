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
it.each([true, false])(
  "restores the saved keep_original preference (%s)",
  async (keep) => {
    const region = { x: 0, y: 0, width: 1, height: 1 };
    vi.mocked(selectRegion)
      .mockResolvedValueOnce({
        action: "confirm",
        region,
        name: "privacy",
        keep_original: keep,
      })
      .mockResolvedValueOnce({ action: "capture", region, name: "privacy" });
    await runSelector(
      service,
      { window_id: WINDOW.id },
      new AbortController().signal,
    );
    expect(
      (await new ProfileStore(state.root).get("privacy")).keep_original,
    ).toBe(keep);
    const result = await runSelector(
      service,
      { window_id: WINDOW.id, name: "privacy" },
      new AbortController().signal,
    );
    expect(vi.mocked(selectRegion).mock.calls[1][2]?.keep_original).toBe(keep);
    if (!("metadata" in result)) throw new Error("Missing saved evidence");
    expect(result.metadata.original).toBeUndefined();
  },
);
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
it("offers and reuses a fixed region after a one-point window resize", async () => {
  const store = new ProfileStore(state.root);
  const saved = await store.save({
    name: "burp-payload",
    version: 1,
    app: WINDOW.bundleId,
    width: WINDOW.bounds.width,
    height: WINDOW.bounds.height + 1,
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  await store.save({ ...saved, name: "larger", height: saved.height + 1 });
  vi.mocked(selectRegion).mockResolvedValueOnce({
    action: "confirm",
    name: saved.name,
    region: saved.region,
  });
  await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.profiles).toEqual([saved]);
  expect(await store.get(saved.name)).toEqual(saved);
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

it("prefills a verified suggestion and only saves the user's adjusted region", async () => {
  const preview = await service.capture({
    window_id: WINDOW.id,
    persist: false,
    include_image: true,
  });
  const proposed = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const adjusted = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion).mockResolvedValue({
    action: "confirm",
    region: adjusted,
  });
  const result = await runSelector(
    service,
    {
      window_id: WINDOW.id,
      request: "request e response",
      suggestion: {
        region: proposed,
        source_sha256: preview.metadata.sha256,
        reason: "Painéis do Organizer",
      },
    },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.initial_region).toEqual(
    proposed,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.request).toBe(
    "request e response",
  );
  expect(result.region).toEqual(adjusted);
  expect((await service.store.list()).items).toHaveLength(0);
});
it("discards stale suggestions rather than applying coordinates from another image", async () => {
  vi.mocked(selectRegion).mockResolvedValue({
    action: "confirm",
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  await runSelector(
    service,
    {
      window_id: WINDOW.id,
      suggestion: {
        region: { x: 0, y: 0, width: 0.5, height: 0.5 },
        source_sha256: "0".repeat(64),
        reason: "old image",
      },
    },
    new AbortController().signal,
  );
  const context = vi.mocked(selectRegion).mock.calls[0][2];
  expect(context?.initial_region).toBeUndefined();
  expect(context?.suggestion_reason).toBeUndefined();
  expect(context?.error).toContain("imagem mudou");
});

it("clears a suggestion when the user changes the target", async () => {
  const preview = await service.capture({
    window_id: WINDOW.id,
    persist: false,
    include_image: true,
  });
  const region = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({
      action: "target",
      target: "window:" + WINDOW.id,
      region,
    })
    .mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    {
      window_id: WINDOW.id,
      suggestion: {
        region,
        source_sha256: preview.metadata.sha256,
        reason: "first target",
      },
    },
    new AbortController().signal,
  );
  expect(
    vi.mocked(selectRegion).mock.calls[1][2]?.initial_region,
  ).toBeUndefined();
  expect(
    vi.mocked(selectRegion).mock.calls[1][2]?.suggestion_reason,
  ).toBeUndefined();
});

it("does not reuse or create a geometric profile for a dynamic content suggestion", async () => {
  const profiles = new ProfileStore(state.root);
  const fixed = { x: 0, y: 0, width: 1, height: 1 };
  await profiles.save({
    name: "burp-repeater",
    version: 1,
    app: WINDOW.bundleId,
    width: WINDOW.bounds.width,
    height: WINDOW.bounds.height,
    region: fixed,
  });
  const preview = await service.capture({
    window_id: WINDOW.id,
    persist: false,
    include_image: true,
  });
  const dynamic = { x: 0, y: 0, width: 0.5, height: 0.5 };
  vi.mocked(selectRegion).mockResolvedValue({
    action: "confirm",
    region: dynamic,
  });
  const result = await runSelector(
    service,
    {
      window_id: WINDOW.id,
      request: "request e response atuais",
      suggestion: {
        region: dynamic,
        source_sha256: preview.metadata.sha256,
        reason: "conteudo atual",
      },
    },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.name).toBe("");
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.initial_region).toEqual(
    dynamic,
  );
  expect(result.profile).toBeUndefined();
  expect(await profiles.list()).toHaveLength(1);
  expect((await profiles.get("burp-repeater")).region).toEqual(fixed);
});

it("applies the batch duplicate guard only when saving, and surfaces failures for correction", async () => {
  const calls = vi
    .spyOn(service, "savePreview")
    .mockRejectedValue(
      new Error("DUPLICATE_CAPTURE: Nothing saved. Select the next item."),
    );
  const region = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({ action: "capture", region })
    .mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    { window_id: WINDOW.id, reject_same_as: ["previous-id"] },
    new AbortController().signal,
  );
  expect(calls.mock.calls[0][3]).toEqual(["previous-id"]);
  expect(vi.mocked(selectRegion).mock.calls[1][2]?.error).toContain(
    "DUPLICATE_CAPTURE",
  );
  expect((await service.store.list()).items).toHaveLength(0);
});

it("saves the frozen preview without recapturing and keeps its original timestamp", async () => {
  const capture = vi.spyOn(service, "localPreview");
  const save = vi.spyOn(service, "savePreview");
  vi.mocked(selectRegion).mockResolvedValue({
    action: "capture",
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  const result = await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect(capture).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0].image).toBe(PNG.toString("base64"));
  expect("metadata" in result && result.metadata.captured_at).toBe(
    save.mock.calls[0][0].metadata.captured_at,
  );
  expect((await service.store.list()).items).toHaveLength(1);
});
it("does not leave a new profile behind when evidence save fails", async () => {
  vi.spyOn(service, "savePreview").mockRejectedValue(new Error("Disk full"));
  const preview = vi.spyOn(service, "localPreview");
  const region = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({ action: "capture", name: "new-profile", region })
    .mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect(await new ProfileStore(state.root).list()).toEqual([]);
  expect(preview).toHaveBeenCalledTimes(1);
  expect(vi.mocked(selectRegion).mock.calls[1][2]?.error).toContain(
    "Disk full",
  );
});
it("returns saved evidence and a warning if the optional profile cannot be created", async () => {
  const failure = vi
    .spyOn(ProfileStore.prototype, "save")
    .mockRejectedValue(new Error("Read-only profiles"));
  try {
    vi.mocked(selectRegion).mockResolvedValue({
      action: "capture",
      name: "new-profile",
      region: { x: 0, y: 0, width: 1, height: 1 },
    });
    const result = await runSelector(
      service,
      { window_id: WINDOW.id },
      new AbortController().signal,
    );
    expect(
      "metadata" in result && result.metadata.warnings.join(" "),
    ).toContain("profile was not created");
    expect((await service.store.list()).items).toHaveLength(1);
    expect(selectRegion).toHaveBeenCalledTimes(1);
  } finally {
    failure.mockRestore();
  }
});

it("refreshes explicitly, clearing stale geometry while retaining the project", async () => {
  const capture = vi.spyOn(service, "localPreview");
  const region = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({
      action: "refresh",
      region,
      draft_name: "old-layout",
      case_id: "project-a",
    })
    .mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  expect(capture).toHaveBeenCalledTimes(2);
  const context = vi.mocked(selectRegion).mock.calls[1][2];
  expect(context?.initial_region).toBeUndefined();
  expect(context?.name).toBe("");
  expect(context?.case_id).toBe("project-a");
  expect((await service.store.list()).items).toHaveLength(0);
});
it("persists caller context through interactive confirmation", async () => {
  vi.mocked(selectRegion).mockResolvedValue({
    action: "capture",
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  const result = await runSelector(
    service,
    {
      window_id: WINDOW.id,
      case_id: "case-a",
      label: "Response",
      note: "Visible response only",
      exchange_id: "exchange-42",
      tags: ["repeater"],
    },
    new AbortController().signal,
  );
  if (!("metadata" in result)) throw new Error("Missing saved evidence");
  const saved = await service.store.get(result.metadata.id);
  expect(saved.context).toEqual({
    case_id: "case-a",
    label: "Response",
    note: "Visible response only",
    exchange_id: "exchange-42",
    tags: ["repeater"],
  });
  expect(saved.association).toBe("caller_supplied_unverified");
});

it("rejects a concurrent session before capturing another preview and releases the session lock", async () => {
  let release!: (value: unknown) => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  vi.mocked(selectRegion).mockImplementationOnce(() => {
    opened();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const previews = vi.spyOn(service, "localPreview");
  const first = runSelector(
    service,
    { window_id: WINDOW.id },
    new AbortController().signal,
  );
  await ready;
  await expect(
    runSelector(
      service,
      { window_id: WINDOW.id },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "SELECTION_BUSY", retryable: true });
  expect(previews).toHaveBeenCalledTimes(1);
  const action = {
    action: "confirm",
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
  release(action);
  await first;
  vi.mocked(selectRegion).mockResolvedValueOnce(action);
  await expect(
    runSelector(
      service,
      { window_id: WINDOW.id },
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("region");
});
it("does not save a profile if cancellation arrives with the dialog response", async () => {
  const controller = new AbortController();
  vi.mocked(selectRegion).mockImplementationOnce(async () => {
    controller.abort(new Error("Cancelled by client"));
    return {
      action: "confirm",
      name: "must-not-save",
      region: { x: 0, y: 0, width: 1, height: 1 },
    };
  });
  await expect(
    runSelector(service, { window_id: WINDOW.id }, controller.signal),
  ).rejects.toThrow("Cancelled by client");
  expect(await new ProfileStore(state.root).list()).toEqual([]);
  expect((await service.store.list()).items).toEqual([]);
  vi.mocked(selectRegion).mockResolvedValueOnce({
    action: "confirm",
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  await expect(
    runSelector(
      service,
      { window_id: WINDOW.id },
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("region");
});
it("pins an app-selected preview to the inspected OS window when refreshing", async () => {
  const { windowToken } = await import("../src/native.js");
  const previews = vi.spyOn(service, "localPreview");
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({ action: "refresh" })
    .mockResolvedValueOnce({
      action: "confirm",
      region: { x: 0, y: 0, width: 1, height: 1 },
    });
  await runSelector(
    service,
    { app_name: WINDOW.app },
    new AbortController().signal,
  );
  expect(previews.mock.calls[1][0]).toMatchObject({
    window_id: WINDOW.id,
    expected_window_token: windowToken(WINDOW),
  });
  expect(previews.mock.calls[1][0].app_name).toBeUndefined();
});

it("stores an editable visual description and attributes user edits", async () => {
  const description = {
    text: "Texto monoespaçado sobre fundo escuro.",
    language: "pt-BR",
    source: "ai" as const,
  };
  vi.mocked(selectRegion).mockResolvedValue({
    action: "capture",
    region: { x: 0, y: 0, width: 1, height: 1 },
    description_text:
      "Uma linha de texto em português sobre fundo verde-escuro.",
    description_language: "pt-BR",
  });
  const result = await runSelector(
    service,
    { window_id: WINDOW.id, description },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]?.description).toEqual(
    description,
  );
  if (!("metadata" in result)) throw new Error("Missing saved evidence");
  expect(
    (await service.store.get(result.metadata.id)).context.description,
  ).toEqual({
    text: "Uma linha de texto em português sobre fundo verde-escuro.",
    language: "pt-BR",
    source: "user",
  });
});
it("refreshes even when the discarded description has an invalid language", async () => {
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({
      action: "refresh",
      description_text: "Old response",
      description_language: "invalid language!",
    })
    .mockResolvedValueOnce({
      action: "capture",
      region: { x: 0, y: 0, width: 1, height: 1 },
    });
  const result = await runSelector(
    service,
    {
      window_id: WINDOW.id,
      description: { text: "Old response", language: "en", source: "ai" },
    },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[1][2]?.description).toBeUndefined();
  if (!("metadata" in result)) throw new Error("Missing saved evidence");
  expect(result.metadata.context.description).toBeUndefined();
});

it("expires mask suggestions, sensitivity and original retention on refresh", async () => {
  const region = { x: 0, y: 0, width: 1, height: 1 };
  const masks = [
    { style: "black" as const, coverage: "full" as const, region },
  ];
  vi.mocked(selectRegion)
    .mockResolvedValueOnce({
      action: "refresh",
      region,
      masks,
      sensitive: true,
      keep_original: true,
    })
    .mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    {
      window_id: WINDOW.id,
      redact: true,
      locale: "en",
      mask_suggestion: {
        masks,
        source_sha256: (await import("../src/png.js")).pngInfo(PNG).sha256,
      },
    },
    new AbortController().signal,
  );
  const [first, second] = vi.mocked(selectRegion).mock.calls;
  expect(first[2]).toMatchObject({ masks, locale: "en" });
  expect(second[2]).toMatchObject({
    masks: [],
    sensitive: null,
    keep_original: false,
    redact: true,
  });
});

it("explains discarded stale masks even when no crop was suggested", async () => {
  const region = { x: 0, y: 0, width: 1, height: 1 };
  vi.mocked(selectRegion).mockResolvedValueOnce({ action: "confirm", region });
  await runSelector(
    service,
    {
      window_id: WINDOW.id,
      mask_suggestion: {
        masks: [{ style: "black", coverage: "full", region }],
        source_sha256: "0".repeat(64),
      },
    },
    new AbortController().signal,
  );
  expect(vi.mocked(selectRegion).mock.calls[0][2]).toMatchObject({
    masks: [],
    redact: true,
    error: expect.stringContaining("older preview"),
  });
});
