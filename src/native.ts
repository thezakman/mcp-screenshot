import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const exec = promisify(execFile);
export interface WindowInfo {
  id: number; pid: number; app: string; bundleId: string; title: string;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface DisplayInfo {
  display: number; id: number; main: boolean; width: number; height: number;
  bounds: WindowInfo["bounds"];
}
export interface CaptureStatus { platform: string; screenRecording: boolean; accessibility: boolean }
export async function native<T>(command: string): Promise<T> {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM: mcp-screenshot requires macOS.");
  const path = fileURLToPath(new URL("./native/windows", import.meta.url));
  if (!existsSync(path)) throw new Error("HELPER_MISSING: run npm run build on this Mac (Xcode Command Line Tools required).");
  const { stdout } = await exec(path, [command], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}
export const listWindows = () => native<WindowInfo[]>("windows");
export const probeDisplays = () => native<DisplayInfo[]>("displays");
export const captureStatus = () => native<CaptureStatus>("status");
export function selectWindow(windows: WindowInfo[], selector: { window_id?: number; app_name?: string; title?: string; burp?: boolean }): WindowInfo {
  const matches = windows.filter(w =>
    (selector.window_id === undefined || w.id === selector.window_id) &&
    (!selector.app_name || w.app.toLowerCase() === selector.app_name.toLowerCase() || w.bundleId.toLowerCase() === selector.app_name.toLowerCase()) &&
    (!selector.title || w.title.toLowerCase().includes(selector.title.toLowerCase())) &&
    (!selector.burp || /burp|portswigger/i.test(w.app + " " + w.bundleId) || /^Burp Suite\b/i.test(w.title)));
  if (matches.length === 0) throw new Error("WINDOW_NOT_FOUND: select a visible, non-minimized window with list_windows.");
  if (matches.length > 1) throw new Error(`AMBIGUOUS_WINDOW: choose window_id using list_windows (${matches.map(w => w.id).join(", ")}).`);
  return matches[0];
}
export function sameWindow(a: WindowInfo, b: WindowInfo): boolean {
  return a.id === b.id && a.pid === b.pid && a.app === b.app && a.bundleId === b.bundleId && a.title === b.title &&
    JSON.stringify(a.bounds) === JSON.stringify(b.bounds);
}
