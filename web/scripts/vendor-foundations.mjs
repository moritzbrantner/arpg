import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_REV = "b3b7204faa47d3b0af56eebc55cdfd4ced127ddc";
const SETUP_REV = "556f1aa2ac889acffd5b2b27163fca10f1901793";

const files = [
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings/src/index.ts", "14b7e1c361d920d9d6367b9c72ab835ba931d573", "src/vendor/input-bindings/packages/input-bindings/src/index.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings/src/public.ts", "d5a1a8956116ee4b938d680cbee81bbc10a2ee7f", "src/vendor/input-bindings/packages/input-bindings/src/public.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings/src/registry.ts", "e228b665b7304b7cec6775669010783dfa755fc9", "src/vendor/input-bindings/packages/input-bindings/src/registry.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-runtime/src/index.ts", "8532830d87470623d41c7c72ec5bd8dea2ef29da", "src/vendor/input-bindings/packages/input-bindings-runtime/src/index.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-web/src/index.ts", "bcc52b12f8945d871f7d3d727aa82865393741e4", "src/vendor/input-bindings/packages/input-bindings-web/src/index.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-react/src/index.tsx", "7f1a20d6fd9b4bec4326d46f7da44d1522a8cd65", "src/vendor/input-bindings/packages/input-bindings-react/src/index.tsx"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-react/src/keyboard.ts", "cd13da916f954cdd67a758b34983e570feb65076", "src/vendor/input-bindings/packages/input-bindings-react/src/keyboard.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-react/src/model.ts", "e15efa03596e56eee8b0d5f03978e6e108fae66f", "src/vendor/input-bindings/packages/input-bindings-react/src/model.ts"],
  ["moritzbrantner/input-bindings", INPUT_REV, "packages/input-bindings-react/src/styles.css", "c0cbe97eb5fdac6a6029ee389aea51e10a9b67a1", "src/vendor/input-bindings/packages/input-bindings-react/src/styles.css"],
  ["moritzbrantner/multiplayer-setup-service", SETUP_REV, "web/resilient-lobby-session.js", "2a047238640bc82cfa3a9fd7108a5893e31567ef", "src/vendor/multiplayer-setup-service/resilient-lobby-session.js"],
];

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

for (const [repository, revision, source, expectedSha, destination] of files) {
  const url = `https://raw.githubusercontent.com/${repository}/${revision}/${source}`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Could not vendor ${source}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha = gitBlobSha(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`Pinned blob mismatch for ${source}: expected ${expectedSha}, got ${actualSha}`);
  }
  const target = resolve(root, destination);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

console.log(`Vendored input-bindings ${INPUT_REV} and multiplayer-setup-service ${SETUP_REV}`);
