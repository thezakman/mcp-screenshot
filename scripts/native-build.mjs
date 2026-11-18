import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  statSync,
  mkdtempSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
const hash = (data) => createHash("sha256").update(data).digest("hex");

/** Content-verified cache; failed compiles never replace a working helper. */
export function buildNative({
  sourcePath,
  outputPath,
  identity,
  compile,
  force = false,
}) {
  const stampPath = outputPath + ".build.json";
  const key = hash(
    JSON.stringify({ identity, source: hash(readFileSync(sourcePath)) }),
  );
  if (!force) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
      const info = statSync(outputPath);
      if (
        stamp.key === key &&
        info.isFile() &&
        info.mode & 0o111 &&
        stamp.binary === hash(readFileSync(outputPath))
      )
        return "cached";
    } catch {
      /* A missing or damaged cache must be rebuilt. */
    }
  }
  const staging = mkdtempSync(join(dirname(outputPath), ".native-build-"));
  try {
    const binary = join(staging, "windows");
    compile(binary);
    chmodSync(binary, 0o755);
    const stamp =
      JSON.stringify({ key, binary: hash(readFileSync(binary)) }) + "\n";
    writeFileSync(join(staging, "stamp.json"), stamp);
    renameSync(binary, outputPath);
    renameSync(join(staging, "stamp.json"), stampPath);
    return "built";
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
