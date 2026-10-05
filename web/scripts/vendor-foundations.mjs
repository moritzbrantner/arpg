import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_REV = "b3b7204faa47d3b0af56eebc55cdfd4ced127ddc";
const SETUP_REV = "cc5c20fabdac0fc9da4329a5be04d0f4e8eae383";

export const FOUNDATION_FILES = [
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings/src/index.ts",
    "14b7e1c361d920d9d6367b9c72ab835ba931d573",
    "src/vendor/input-bindings/packages/input-bindings/src/index.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings/src/public.ts",
    "d5a1a8956116ee4b938d680cbee81bbc10a2ee7f",
    "src/vendor/input-bindings/packages/input-bindings/src/public.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings/src/registry.ts",
    "e228b665b7304b7cec6775669010783dfa755fc9",
    "src/vendor/input-bindings/packages/input-bindings/src/registry.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-runtime/src/index.ts",
    "8532830d87470623d41c7c72ec5bd8dea2ef29da",
    "src/vendor/input-bindings/packages/input-bindings-runtime/src/index.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-web/src/index.ts",
    "bcc52b12f8945d871f7d3d727aa82865393741e4",
    "src/vendor/input-bindings/packages/input-bindings-web/src/index.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-react/src/index.tsx",
    "7f1a20d6fd9b4bec4326d46f7da44d1522a8cd65",
    "src/vendor/input-bindings/packages/input-bindings-react/src/index.tsx",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-react/src/keyboard.ts",
    "cd13da916f954cdd67a758b34983e570feb65076",
    "src/vendor/input-bindings/packages/input-bindings-react/src/keyboard.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-react/src/model.ts",
    "e15efa03596e56eee8b0d5f03978e6e108fae66f",
    "src/vendor/input-bindings/packages/input-bindings-react/src/model.ts",
  ],
  [
    "moritzbrantner/input-bindings",
    INPUT_REV,
    "packages/input-bindings-react/src/styles.css",
    "c0cbe97eb5fdac6a6029ee389aea51e10a9b67a1",
    "src/vendor/input-bindings/packages/input-bindings-react/src/styles.css",
  ],
  [
    "moritzbrantner/multiplayer-setup-service",
    SETUP_REV,
    "web/resilient-lobby-session.ts",
    "7ebebeba27c15b627dee1fbe165ab74a2ec8f09e",
    "src/vendor/multiplayer-setup-service/resilient-lobby-session.ts",
  ],
  [
    "moritzbrantner/multiplayer-setup-service",
    SETUP_REV,
    "web/demo-session.ts",
    "41719539090b9abc72520a896248476e9df1d8a3",
    "src/vendor/multiplayer-setup-service/demo-session.ts",
  ],
  [
    "moritzbrantner/multiplayer-setup-service",
    SETUP_REV,
    "web/turn-credentials.ts",
    "9807da9f052c7998545d0bb3d10e96cb94d588c0",
    "src/vendor/multiplayer-setup-service/turn-credentials.ts",
  ],
  [
    "moritzbrantner/multiplayer-setup-service",
    SETUP_REV,
    "web/events.ts",
    "9b588c4b71a509f3d0870c8d83fb951978fd08a6",
    "src/vendor/multiplayer-setup-service/events.ts",
  ],
  [
    "moritzbrantner/multiplayer-setup-service",
    SETUP_REV,
    "web/lobby-types.ts",
    "9018fb2ffb0c95fee4007479beb57c2a6d303591",
    "src/vendor/multiplayer-setup-service/lobby-types.ts",
  ],
];

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

export async function vendorFoundations({
  outputRoot = root,
  files = FOUNDATION_FILES,
  fetchSource = fetch,
  timeoutMs = 15_000,
} = {}) {
  const changes = [];
  for (const [repository, revision, source, expectedSha, destination] of files) {
    const target = resolve(outputRoot, destination);
    const targetRelative = relative(outputRoot, target);
    if (!targetRelative || isAbsolute(targetRelative) || targetRelative.startsWith("..")) {
      throw new Error(`Foundation destination escapes output root: ${destination}`);
    }
    let inspected = resolve(outputRoot);
    for (const fragment of ["", ...targetRelative.split(sep)]) {
      inspected = resolve(inspected, fragment);
      try {
        if ((await lstat(inspected)).isSymbolicLink())
          throw new Error(`Foundation destination crosses a symlink: ${destination}`);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
    }
    let previous = null;
    try {
      previous = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous && gitBlobSha(previous) === expectedSha) {
      changes.push({ destination, status: "unchanged" });
      continue;
    }
    const url = `https://raw.githubusercontent.com/${repository}/${revision}/${source}`;
    const response = await fetchSource(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Could not vendor ${source}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualSha = gitBlobSha(bytes);
    if (actualSha !== expectedSha) {
      throw new Error(
        `Pinned blob mismatch for ${source}: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    changes.push({ destination, status: previous ? "changed" : "created" });
  }
  return changes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await vendorFoundations();
  console.log(
    JSON.stringify({
      status: files.every((file) => file.status === "unchanged") ? "unchanged" : "changed",
      files,
    }),
  );
}
