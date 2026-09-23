import { describe, expect, test } from "bun:test";
import {
  SAVE_DOCUMENT_FORMAT,
  SAVE_DOCUMENT_VERSION,
  SAVE_STORAGE_KEY,
  createSaveDocument,
  hasPersistedSaveDocument,
  loadPersistedSaveDocument,
  parseSaveDocument,
  persistSaveDocument,
  saveFileName,
  serializeSaveDocument,
} from "./save-state.js";

function storage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

const coreStateJson = JSON.stringify({
  schemaVersion: 1,
  runSeed: 1234,
  tick: 5678,
  players: [{ id: 1, lastSequence: 9 }],
});

describe("save documents", () => {
  test("wraps deterministic core state with presentation/client metadata", () => {
    const document = createSaveDocument(coreStateJson, {
      characterId: "mara",
      controlledPlayerId: 1,
    });
    expect(document.format).toBe(SAVE_DOCUMENT_FORMAT);
    expect(document.fileVersion).toBe(SAVE_DOCUMENT_VERSION);
    expect(document.coreState.runSeed).toBe(1234);
    expect(document.presentation.characterId).toBe("mara");
    expect(document.client.controlledPlayerId).toBe(1);
    expect(saveFileName(document)).toBe("arpg-save-seed-1234-tick-5678.json");
  });

  test("serializes and parses an importable save file", () => {
    const document = createSaveDocument(coreStateJson, {
      characterId: "aldren",
      controlledPlayerId: 1,
    });
    const encoded = serializeSaveDocument(document);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(parseSaveDocument(encoded)).toEqual(document);
  });

  test("rejects unrelated and future save formats before Wasm load", () => {
    expect(() => parseSaveDocument('{"format":"other","fileVersion":1}')).toThrow(
      "Not an ARPG save file",
    );
    expect(() =>
      parseSaveDocument(
        JSON.stringify({
          format: SAVE_DOCUMENT_FORMAT,
          fileVersion: SAVE_DOCUMENT_VERSION + 1,
          coreState: {},
          presentation: { characterId: "aldren" },
          client: { controlledPlayerId: 1 },
        }),
      ),
    ).toThrow("Unsupported ARPG save file version");
  });

  test("persists and reloads the same save document", () => {
    const store = storage();
    const document = createSaveDocument(coreStateJson, {
      characterId: "thorne",
      controlledPlayerId: 1,
    });
    expect(hasPersistedSaveDocument(store)).toBe(false);
    persistSaveDocument(store, document);
    expect(hasPersistedSaveDocument(store)).toBe(true);
    expect(store.getItem(SAVE_STORAGE_KEY)).toBe(serializeSaveDocument(document));
    expect(loadPersistedSaveDocument(store)).toEqual(document);
  });
});
