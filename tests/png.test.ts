import { it, expect } from "vitest";
import { PNG } from "./helpers.js";
import { pngInfo } from "../src/png.js";
it("validates chunks instead of accepting a PNG-looking envelope", () => {
  expect(pngInfo(PNG).width).toBe(1);
  const corrupted = Buffer.from(PNG);
  corrupted[40] ^= 1;
  expect(() => pngInfo(corrupted)).toThrow("valid chunks");
  expect(() =>
    pngInfo(Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)])),
  ).toThrow();
});
