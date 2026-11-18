import { execFileSync, spawnSync } from "node:child_process";
import { ProfileStore } from "../src/regions.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  service = new CaptureService(new EvidenceStore(root), backend, "", root);
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

it("captures directly with a saved profile after a one-point resize", async () => {
  await new ProfileStore(root).save({
    name: "repeater",
    version: 1,
    app: WINDOW.bundleId,
    width: WINDOW.bounds.width,
    height: WINDOW.bounds.height + 1,
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  const result = await service.capture({
    window_id: WINDOW.id,
    profile: "repeater",
  });
  expect(result.metadata.persisted).toBe(true);
  expect(backend.capture).toHaveBeenCalledTimes(1);
});
it("rejects mismatched profile dimensions before capturing or saving", async () => {
  await new ProfileStore(root).save({
    name: "response",
    version: 1,
    app: WINDOW.bundleId,
    width: 900,
    height: 600,
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  await expect(
    service.capture({ window_id: 42, profile: "response" }),
  ).rejects.toThrow("PROFILE_MISMATCH");
  expect(backend.capture).not.toHaveBeenCalled();
  expect((await service.store.list()).items).toHaveLength(0);
});

it("honors cancellation during duplicate verification before saving", async () => {
  const first = await service.capture({ window_id: WINDOW.id });
  if (!("id" in first.metadata)) throw new Error("Expected saved evidence");
  const prior = await service.store.get(first.metadata.id);
  const controller = new AbortController();
  vi.spyOn(service.store, "get").mockImplementationOnce(async () => {
    controller.abort();
    return { ...prior, sha256: "0".repeat(64) };
  });
  const save = vi.spyOn(service.store, "save");
  await expect(
    service.capture(
      { window_id: WINDOW.id, reject_same_as: [prior.id] },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(save).not.toHaveBeenCalled();
});
it("rejects identical captures before creating evidence for the next item", async () => {
  const first = await service.capture({ window_id: 42 });
  await expect(
    service.capture({
      window_id: 42,
      reject_same_as: [(first.metadata as { id: string }).id],
      label: "item 2",
    }),
  ).rejects.toThrow("Nothing saved");
  expect((await service.store.list()).items).toHaveLength(1);
});

it("retains the inspected preview but rejects changed window bounds and expired previews", async () => {
  const first = await service.capture({
    window_id: 42,
    persist: false,
    include_image: true,
  });
  expect(
    (await service.suggestedPreview(first.metadata.sha256, { window_id: 42 }))
      ?.image,
  ).toBe(first.image);
  vi.mocked(backend.windows).mockResolvedValue([
    { ...WINDOW, bounds: { ...WINDOW.bounds, width: 900 } },
  ]);
  expect(
    await service.suggestedPreview(first.metadata.sha256, { window_id: 42 }),
  ).toBeUndefined();
  vi.mocked(backend.windows).mockResolvedValue([WINDOW]);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
  try {
    expect(
      await service.suggestedPreview(first.metadata.sha256, { window_id: 42 }),
    ).toBeUndefined();
  } finally {
    now.mockRestore();
  }
});

it("keeps profiles in their configured directory after changing evidence destination", async () => {
  await new ProfileStore(root).save({
    name: "fixed",
    version: 1,
    app: WINDOW.bundleId,
    width: WINDOW.bounds.width,
    height: WINDOW.bounds.height,
    region: { x: 0, y: 0, width: 1, height: 1 },
  });
  service.store.root = join(root, "new-destination");
  const result = await service.capture({
    window_id: WINDOW.id,
    profile: "fixed",
  });
  expect(result.metadata.persisted).toBe(true);
  expect((await service.store.list()).items).toHaveLength(1);
});
it("allows large local previews without persistence while enforcing MCP inline limits", async () => {
  const { crc32 } = await import("../src/png.js");
  const payload = Buffer.alloc(5 * 1024 * 1024 + 1);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write("tEXt", 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([PNG.subarray(0, 33), chunk, PNG.subarray(33)]);
  vi.mocked(backend.capture).mockResolvedValue(large);
  await expect(
    service.capture({
      window_id: WINDOW.id,
      persist: false,
      include_image: true,
    }),
  ).rejects.toThrow("5 MiB");
  const preview = await service.localPreview({ window_id: WINDOW.id });
  expect(preview.image).toBe(large.toString("base64"));
  expect(preview.metadata.persisted).toBe(false);
  expect((await service.store.list()).items).toHaveLength(0);
});

it("saves inspected pixels even if the live window subsequently changes", async () => {
  const preview = await service.localPreview({ window_id: WINDOW.id });
  vi.mocked(backend.capture).mockRejectedValue(
    new Error("Live source unavailable"),
  );
  vi.mocked(backend.windows).mockResolvedValue([]);
  const saved = await service.savePreview(
    { metadata: preview.metadata, image: preview.image! },
    { x: 0, y: 0, width: 1, height: 1 },
    {},
  );
  expect(saved.metadata.sha256).toBe(preview.metadata.sha256);
  expect(saved.metadata.captured_at).toBe(preview.metadata.captured_at);
  expect(saved.metadata.selection).toMatchObject({
    method: "user_confirmed_frozen_preview",
    source_sha256: preview.metadata.sha256,
  });
  const reloaded = await service.store.get(saved.metadata.id);
  expect(reloaded.selection).toEqual(saved.metadata.selection);
  expect(Number.isNaN(Date.parse(reloaded.selection!.confirmed_at))).toBe(
    false,
  );
  expect(backend.capture).toHaveBeenCalledTimes(1);
  await expect(
    service.savePreview(
      { metadata: preview.metadata, image: preview.image! },
      { x: 0, y: 0, width: 1, height: 1 },
      {},
      [saved.metadata.id],
    ),
  ).rejects.toThrow("Nothing saved");
  expect((await service.store.list()).items).toHaveLength(1);
});
it("rejects altered preview provenance before saving", async () => {
  const preview = await service.localPreview({ window_id: WINDOW.id });
  await expect(
    service.savePreview(
      {
        metadata: { ...preview.metadata, sha256: "0".repeat(64) },
        image: preview.image!,
      },
      { x: 0, y: 0, width: 1, height: 1 },
      {},
    ),
  ).rejects.toThrow("integrity");
  expect((await service.store.list()).items).toHaveLength(0);
});

it("rejects a misnamed profile before accessing the screenshot backend", async () => {
  const profiles = new ProfileStore(root);
  const profile = {
    name: "original",
    version: 1 as const,
    app: WINDOW.bundleId,
    width: WINDOW.bounds.width,
    height: WINDOW.bounds.height,
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
  await profiles.save(profile);
  await writeFile(
    join(root, "profiles", "alias.json"),
    JSON.stringify(profile),
  );
  await expect(
    service.capture({ window_id: WINDOW.id, profile: "alias" }),
  ).rejects.toMatchObject({ code: "INVALID_PROFILE" });
  expect(backend.capture).not.toHaveBeenCalled();
  expect((await service.store.list()).items).toHaveLength(0);
});

it("preserves the caller's description language and makes its content searchable", async () => {
  for (const description of [
    {
      text: "Texto em português sobre fundo verde-escuro.",
      language: "pt-BR",
      source: "ai" as const,
    },
    {
      text: "Monospaced text on a dark background.",
      language: "en",
      source: "user" as const,
    },
  ]) {
    const result = await service.capture({ window_id: WINDOW.id, description });
    const saved = await service.store.get(
      (result.metadata as { id: string }).id,
    );
    expect(saved.context.description).toEqual(description);
    expect(
      (await service.store.list({ query: description.text })).items.map(
        (item) => item.id,
      ),
    ).toContain(saved.id);
  }
});

it("preserves the connector item ID across capture, retrieval and filtered listing", async () => {
  const first = await service.capture({
    window_id: WINDOW.id,
    case_id: "batch",
    source_item_id: "repeater:20",
  });
  await service.capture({
    window_id: WINDOW.id,
    case_id: "batch",
    source_item_id: "repeater:21",
  });
  const id = (first.metadata as { id: string }).id;
  expect((await service.store.get(id)).context.source_item_id).toBe(
    "repeater:20",
  );
  expect(
    (
      await service.store.list({
        case_id: "batch",
        source_item_id: "repeater:20",
      })
    ).items,
  ).toEqual([expect.objectContaining({ id, source_item_id: "repeater:20" })]);
});

it.skipIf(spawnSync("exiftool", ["-ver"]).status !== 0)(
  "embeds the approved description in the primary PNG and preserves duplicate detection",
  async () => {
    const description = {
      text: "Painéis de requisição e resposta – sessão de revisão.",
      language: "pt-BR",
      source: "user" as const,
    };
    const options = { window_id: WINDOW.id, description, include_image: true };
    const plain = await service.capture(options);
    expect(Buffer.from(plain.image!, "base64")).toEqual(PNG);
    const tagged = await service.capture({
      ...options,
      embed_description: true,
    });
    const stored = await service.store.get(
      (tagged.metadata as { id: string }).id,
      true,
    );
    expect(Buffer.from(tagged.image!, "base64")).toEqual(stored.data);
    expect(stored.integrity).toBe("verified");
    expect(
      execFileSync("exiftool", ["-s3", "-EXIF:UserComment", stored.path], {
        encoding: "utf8",
      }).trimEnd(),
    ).toBe(description.text);
    await expect(
      service.capture({ ...options, reject_same_as: [stored.id] }),
    ).rejects.toThrow("matches previous evidence");
  },
);
