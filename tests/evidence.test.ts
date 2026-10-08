import { crc32 } from "../src/png.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EvidenceStore,
  pngInfo,
  type CaptureMetadata,
} from "../src/evidence.js";
import { PNG } from "./helpers.js";
let root: string, store: EvidenceStore;
const meta = (at = "2026-10-08T12:00:00.000Z"): CaptureMetadata => ({
  ...pngInfo(PNG),
  captured_at: at,
  mode: "display",
  display: 1,
  verification: "display_selected",
  warnings: [],
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "evidence-test-"));
  store = new EvidenceStore(root);
});
afterEach(async () => rm(root, { recursive: true, force: true }));
describe("evidence persistence", () => {
  it("saves a PNG/sidecar pair with a verifiable hash and explicit association", async () => {
    const saved = await store.save(PNG, meta(), {
      case_id: "local",
      exchange_id: "exchange-1",
    });
    const got = await store.get(saved.id, true);
    expect(got.data).toEqual(PNG);
    expect(got.integrity).toBe("verified");
    expect(got.association).toBe("caller_supplied_unverified");
    expect(
      JSON.parse(await readFile(saved.manifest_path, "utf8")).context.case_id,
    ).toBe("local");
    expect((await readdir(root)).some((n) => n.startsWith(".pending"))).toBe(
      false,
    );
  });
  it("detects a changed image instead of returning invalid evidence", async () => {
    const saved = await store.save(PNG, meta());
    const changed = Buffer.from(PNG);
    changed[40] ^= 1;
    await writeFile(saved.path, changed);
    await expect(store.get(saved.id)).rejects.toThrow("no longer matches");
  });
  it("paginates without repeating prior evidence and filters by case", async () => {
    const a = await store.save(PNG, meta(), { case_id: "a" });
    const b = await store.save(PNG, meta("2026-10-08T12:00:01.000Z"), {
      case_id: "b",
    });
    const first = await store.list({ limit: 1 });
    expect(first.items[0].id).toBe(a.id);
    expect(
      (await store.list({ after: first.next_cursor!, limit: 1 })).items[0].id,
    ).toBe(b.id);
    expect((await store.list({ case_id: "a" })).items).toHaveLength(1);
  });
  it("rejects path traversal and symbolic links", async () => {
    await expect(store.get("../private")).rejects.toThrow("evidence ID");
    const saved = await store.save(PNG, meta());
    await rm(saved.path);
    await symlink("/etc/hosts", saved.path);
    await expect(store.get(saved.id)).rejects.toThrow();
  });
  it("never overwrites a requested export path", async () => {
    const path = join(root, "export.png");
    await store.exportCopy(PNG, path);
    await expect(store.exportCopy(PNG, path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(PNG);
    await expect(store.exportCopy(PNG, "/tmp/outside.png")).rejects.toThrow(
      "outside",
    );
  });
  it("rejects partial output", () => {
    expect(() => pngInfo(PNG.subarray(0, 30))).toThrow("complete PNG");
  });
});
it("finds evidence by exchange ID and descriptive context", async () => {
  const saved = await store.save(PNG, meta(), {
    exchange_id: "exchange-1",
    label: "Baseline",
    tags: ["review"],
  });
  await store.save(PNG, meta("2026-10-08T12:00:02.000Z"), {
    exchange_id: "exchange-2",
    label: "Other",
  });
  expect(
    (
      await store.list({ exchange_id: "exchange-1", query: "BASELINE" })
    ).items.map((i) => i.id),
  ).toEqual([saved.id]);
  expect(
    (await store.list({ query: "REVIEW" })).items.map((i) => i.id),
  ).toEqual([saved.id]);
});
it("ignores unrelated directories without returning an invalid cursor", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "unrelated"));
  const saved = await store.save(PNG, meta());
  const page = await store.list({ limit: 1 });
  expect(page.items.map((i) => i.id)).toEqual([saved.id]);
  expect(page.next_cursor).toBeNull();
});
it("rejects exports through a symlink leading outside the evidence root", async () => {
  await symlink(tmpdir(), join(root, "outside"));
  await expect(
    store.exportCopy(PNG, join(root, "outside", "escape.png")),
  ).rejects.toThrow("outside");
});
it("does not create an evidence directory while listing an empty store", async () => {
  const { access } = await import("node:fs/promises");
  const missing = join(root, "missing");
  expect((await new EvidenceStore(missing).list()).items).toEqual([]);
  await expect(access(missing)).rejects.toThrow();
});
it("rejects inconsistent manifests before returning metadata", async () => {
  const saved = await store.save(PNG, meta());
  const manifest = JSON.parse(await readFile(saved.manifest_path, "utf8"));
  manifest.context = { tags: "not-an-array" };
  await writeFile(saved.manifest_path, JSON.stringify(manifest));
  await expect(store.get(saved.id)).rejects.toThrow("malformed");
  const listing = await store.list();
  expect(listing.items).toEqual([]);
  expect(listing.skipped).toEqual([saved.id]);
});
it("hashes multi-chunk evidence without returning the image by default", async () => {
  const large = Buffer.concat([
    PNG.subarray(0, PNG.length - 12),
    ancillaryChunk(),
    PNG.subarray(PNG.length - 12),
  ]);
  const saved = await store.save(large, { ...meta(), ...pngInfo(large) });
  const read = await store.get(saved.id);
  expect(read.data).toBeUndefined();
  expect(read.integrity).toBe("verified");
  expect(read.bytes).toBe(large.length);
  expect((await store.get(saved.id, true)).data).toEqual(large);
});

function ancillaryChunk() {
  const payload = Buffer.alloc(150000, 32),
    type = Buffer.from("tEXt");
  const data = Buffer.concat([type, payload]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(payload.length, 0);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
