import { z } from "zod";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  readdir,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { native } from "./native.js";
import { pngInfo } from "./png.js";
import { assertDirectory, readBounded } from "./storage.js";
export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (r) => r.x + r.width <= 1.0000001 && r.y + r.height <= 1.0000001,
    "Region exceeds image",
  );
export type Region = z.infer<typeof regionSchema>;
export const profileName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const profileSchema = z.object({
  name: profileName,
  version: z.literal(1),
  app: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  region: regionSchema,
});
export class ProfileStore {
  constructor(readonly root: string) {}
  async directory(create = false) {
    const dir = join(this.root, "profiles");
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    await assertDirectory(dir);
    return dir;
  }
  async get(name: string) {
    return profileSchema.parse(
      JSON.parse(
        (
          await readBounded(
            join(await this.directory(), profileName.parse(name) + ".json"),
            65536,
          )
        ).toString(),
      ),
    );
  }
  async save(value: z.infer<typeof profileSchema>) {
    const p = profileSchema.parse(value);
    const dir = await this.directory(true);
    const staging = await mkdtemp(join(dir, ".pending-"));
    try {
      const file = join(staging, "profile.json");
      await writeFile(file, JSON.stringify(p, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await link(file, join(dir, p.name + ".json"));
      return p;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async list() {
    let names: string[];
    try {
      names = await readdir(await this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((n) => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(n))
        .map((n) => this.get(n.slice(0, -5))),
    );
  }
  async rename(oldName: string, newName: string) {
    if (oldName === newName) return this.get(oldName);
    const current = await this.get(oldName);
    const saved = await this.save({ ...current, name: newName });
    await this.delete(oldName);
    return saved;
  }
  async delete(name: string) {
    await rm(join(await this.directory(), profileName.parse(name) + ".json"));
  }
}
export function pixelRegion(region: Region, width: number, height: number) {
  const r = regionSchema.parse(region);
  const x = Math.floor(r.x * width),
    y = Math.floor(r.y * height);
  return {
    x,
    y,
    width: Math.min(width, Math.ceil((r.x + r.width) * width)) - x,
    height: Math.min(height, Math.ceil((r.y + r.height) * height)) - y,
  };
}
export async function cropImage(data: Buffer, region: Region) {
  const info = pngInfo(data),
    r = pixelRegion(region, info.width, info.height);
  const dir = await mkdtemp(join(tmpdir(), "screenshot-crop-"));
  try {
    const input = join(dir, "input.png"),
      output = join(dir, "output.png");
    await writeFile(input, data, { mode: 0o600 });
    await native("crop", [
      input,
      output,
      String(r.x),
      String(r.y),
      String(r.width),
      String(r.height),
    ]);
    return await readFile(output);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
let selecting = false;
export async function selectRegion(
  data: Buffer,
  signal?: AbortSignal,
  context?: Record<string, unknown>,
): Promise<any> {
  if (selecting)
    throw new Error("SELECTION_BUSY: finish the current selection.");
  selecting = true;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "screenshot-select-"));
    const input = join(dir, "preview.png");
    await writeFile(input, data, { mode: 0o600 });
    const config = join(dir, "context.json");
    await writeFile(config, JSON.stringify(context ?? {}), { mode: 0o600 });
    const result = await native<any>("select", [input, config], 300000, signal);
    if (result && typeof result === "object" && "cancelled" in result)
      throw new Error("SELECTION_CANCELLED: no profile or evidence saved.");
    if (context) return result;
    return regionSchema.parse(result);
  } finally {
    selecting = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
