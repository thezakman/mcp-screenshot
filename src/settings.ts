import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
export const SETTINGS_HOME = join(homedir(), "Pictures", "mcp-screenshot");
export const SETTINGS_PATH = join(SETTINGS_HOME, "settings.json");
export function configuredRoot() {
  if (process.env.MCP_SCREENSHOT_DIR) return process.env.MCP_SCREENSHOT_DIR;
  try {
    const value = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    if (
      typeof value.evidence_directory === "string" &&
      isAbsolute(value.evidence_directory)
    )
      return value.evidence_directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("INVALID_SETTINGS: repair " + SETTINGS_PATH);
  }
  return SETTINGS_HOME;
}
export async function saveDestination(destination: string) {
  if (process.env.MCP_SCREENSHOT_DIR)
    throw new Error(
      "Destination is controlled by MCP_SCREENSHOT_DIR. Change the MCP configuration to override it.",
    );
  if (!isAbsolute(destination))
    throw new Error("Choose an absolute directory.");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(destination));
  const probe = await mkdtemp(join(root, ".write-check-"));
  await rm(probe, { recursive: true });
  await mkdir(SETTINGS_HOME, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(SETTINGS_HOME, ".settings-"));
  try {
    await writeFile(
      join(staging, "settings.json"),
      JSON.stringify({ version: 1, evidence_directory: root }) + "\n",
      { mode: 0o600 },
    );
    await rename(join(staging, "settings.json"), SETTINGS_PATH);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return root;
}

export function profilesRoot() {
  return process.env.MCP_SCREENSHOT_DIR ?? SETTINGS_HOME;
}
