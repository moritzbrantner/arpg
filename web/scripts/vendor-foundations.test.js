import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendorFoundations } from "./vendor-foundations.mjs";

const bytes = Buffer.from("export const foundation = true;\n");
const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const files = [["owner/foundation", "immutable-revision", "public.js", hash, "foundation.js"]];

test("reuses verified foundations without fetching or rewriting, and repairs corrupt output", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "arpg-foundations-"));
  let requests = 0;
  const fetchSource = async () => {
    requests += 1;
    return new Response(bytes);
  };
  try {
    await vendorFoundations({ outputRoot, files, fetchSource });
    const target = join(outputRoot, "foundation.js");
    const before = await stat(target);
    await vendorFoundations({ outputRoot, files, fetchSource });
    expect(requests).toBe(1);
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
    await writeFile(target, "corrupt");
    await vendorFoundations({ outputRoot, files, fetchSource });
    expect(requests).toBe(2);
    expect(await readFile(target)).toEqual(bytes);
  } finally {
    await rm(outputRoot, { recursive: true });
  }
});

test("refuses destinations outside the declared output root", async () => {
  await expect(
    vendorFoundations({
      outputRoot: "/tmp/arpg-vendor-boundary",
      files: [[...files[0].slice(0, 4), "../escape.js"]],
    }),
  ).rejects.toThrow("escapes output root");
});

test("does not follow symlinks when reusing or replacing foundations", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "arpg-foundations-"));
  try {
    const original = join(outputRoot, "original.js");
    await writeFile(original, bytes);
    await symlink(original, join(outputRoot, "foundation.js"));
    await expect(vendorFoundations({ outputRoot, files })).rejects.toThrow("symlink");
    expect(await readFile(original)).toEqual(bytes);
  } finally {
    await rm(outputRoot, { recursive: true });
  }
});

test("bounds downloads with cancellation", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "arpg-foundations-"));
  try {
    await expect(
      vendorFoundations({
        outputRoot,
        files,
        timeoutMs: 5,
        fetchSource: (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(outputRoot, { recursive: true });
  }
});

test("a corrupt download preserves existing output", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "arpg-foundations-"));
  const target = join(outputRoot, "foundation.js");
  try {
    await writeFile(target, "previous output");
    await expect(
      vendorFoundations({
        outputRoot,
        files,
        fetchSource: async () => new Response("wrong bytes"),
      }),
    ).rejects.toThrow("Pinned blob mismatch");
    expect(await readFile(target, "utf8")).toBe("previous output");
  } finally {
    await rm(outputRoot, { recursive: true });
  }
});
