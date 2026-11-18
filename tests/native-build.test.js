import { it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNative } from "../scripts/native-build.mjs";

it("reuses only matching source, compiler identity and intact executable contents", () => {
  const root = mkdtempSync(join(tmpdir(), "native-cache-"));
  try {
    const sourcePath = join(root, "source.swift"),
      outputPath = join(root, "windows");
    writeFileSync(sourcePath, "source-a");
    let calls = 0;
    const options = {
      sourcePath,
      outputPath,
      identity: { compiler: "a" },
      compile(path) {
        calls++;
        writeFileSync(path, "binary-" + calls);
      },
    };
    expect(buildNative(options)).toBe("built");
    expect(buildNative(options)).toBe("cached");
    writeFileSync(sourcePath, "source-b");
    expect(buildNative(options)).toBe("built");
    options.identity.compiler = "b";
    expect(buildNative(options)).toBe("built");
    writeFileSync(outputPath, "corrupt");
    expect(buildNative(options)).toBe("built");
    expect(buildNative({ ...options, force: true })).toBe("built");
    expect(calls).toBe(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("keeps the previous helper and stamp intact when compilation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "native-cache-failure-"));
  try {
    const sourcePath = join(root, "source.swift"),
      outputPath = join(root, "windows");
    writeFileSync(sourcePath, "source");
    const options = {
      sourcePath,
      outputPath,
      identity: {},
      compile(path) {
        writeFileSync(path, "working");
      },
    };
    buildNative(options);
    const stamp = readFileSync(outputPath + ".build.json", "utf8");
    expect(() =>
      buildNative({
        ...options,
        force: true,
        compile(path) {
          writeFileSync(path, "partial");
          throw new Error("compiler failed");
        },
      }),
    ).toThrow("compiler failed");
    expect(readFileSync(outputPath, "utf8")).toBe("working");
    expect(readFileSync(outputPath + ".build.json", "utf8")).toBe(stamp);
    expect(
      readdirSync(root).some((name) => name.startsWith(".native-build-")),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
