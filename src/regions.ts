import { z } from "zod";
import { ScreenshotError } from "./errors.js";
const MAX_PROFILE_BYTES = 64 * 1024;
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
  app: z.string().min(1).max(4096),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
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
    name = profileName.parse(name);
    let data: Buffer;
    try {
      data = await readBounded(
        join(await this.directory(), name + ".json"),
        MAX_PROFILE_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ScreenshotError(
          "PROFILE_NOT_FOUND",
          `Profile ${name} was not found. List profiles or create a new fixed region.`,
        );
      throw error;
    }
    try {
      const profile = profileSchema.parse(JSON.parse(data.toString("utf8")));
      if (profile.name !== name)
        throw new Error("Profile name does not match its filename.");
      return profile;
    } catch {
      throw new ScreenshotError(
        "INVALID_PROFILE",
        `Profile ${name} is malformed or its name differs from its filename. Repair it or explicitly delete and recreate it.`,
      );
    }
  }
  async save(value: z.infer<typeof profileSchema>) {
    const p = profileSchema.parse(value);
    const data = JSON.stringify(p, null, 2) + "\n";
    if (Buffer.byteLength(data, "utf8") > MAX_PROFILE_BYTES)
      throw new ScreenshotError(
        "PROFILE_TOO_LARGE",
        "Profile exceeds 64 KiB. Shorten its application identifier.",
      );
    const dir = await this.directory(true);
    const staging = await mkdtemp(join(dir, ".pending-"));
    try {
      const file = join(staging, "profile.json");
      await writeFile(file, data, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await link(file, join(dir, p.name + ".json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ScreenshotError(
            "PROFILE_EXISTS",
            `Profile ${p.name} already exists. Choose a new name; existing geometry is never overwritten.`,
          );
        throw error;
      }
      return p;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async list() {
    return (await this.scan()).profiles;
  }
  async scan() {
    let names: string[];
    try {
      names = await readdir(await this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { profiles: [], warnings: [] };
      throw error;
    }
    const profiles: z.infer<typeof profileSchema>[] = [];
    const warnings: string[] = [];
    for (const file of names
      .filter((n) => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(n))
      .sort()) {
      try {
        const profile = await this.get(file.slice(0, -5));
        profiles.push(profile);
      } catch {
        warnings.push(
          `Perfil inválido ignorado: ${file}. Corrija ou remova esse arquivo para recuperá-lo.`,
        );
      }
    }
    return { profiles, warnings };
  }
  async rename(oldName: string, newName: string) {
    if (oldName === newName) return this.get(oldName);
    const current = await this.get(oldName);
    const saved = await this.save({ ...current, name: newName });
    try {
      await this.delete(oldName);
    } catch {
      throw new ScreenshotError(
        "PROFILE_RENAME_PARTIAL",
        `Profile ${newName} was created, but ${oldName} could not be removed. List profiles and verify both before deleting the old name; do not blindly retry the rename.`,
      );
    }
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
  // Preserve the original PNG bytes when the rounded crop is the whole image.
  if (
    r.x === 0 &&
    r.y === 0 &&
    r.width === info.width &&
    r.height === info.height
  )
    return data;
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
