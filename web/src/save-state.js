export const SAVE_STORAGE_KEY = "arpg-save-document-v1";
export const SAVE_DOCUMENT_FORMAT = "arpg-save";
export const SAVE_DOCUMENT_VERSION = 1;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function createSaveDocument(coreStateJson, { characterId, controlledPlayerId }) {
  const coreState = assertObject(JSON.parse(coreStateJson), "coreState");
  if (typeof characterId !== "string" || !characterId) {
    throw new Error("characterId must be a non-empty string");
  }
  if (!Number.isInteger(controlledPlayerId) || controlledPlayerId <= 0) {
    throw new Error("controlledPlayerId must be a positive integer");
  }
  return {
    format: SAVE_DOCUMENT_FORMAT,
    fileVersion: SAVE_DOCUMENT_VERSION,
    presentation: { characterId },
    client: { controlledPlayerId },
    coreState,
  };
}

export function parseSaveDocument(text) {
  const document = assertObject(JSON.parse(text), "save document");
  if (document.format !== SAVE_DOCUMENT_FORMAT) {
    throw new Error("Not an ARPG save file");
  }
  if (document.fileVersion !== SAVE_DOCUMENT_VERSION) {
    throw new Error(
      `Unsupported ARPG save file version ${String(document.fileVersion)}; expected ${SAVE_DOCUMENT_VERSION}`,
    );
  }

  assertObject(document.coreState, "coreState");
  const presentation = assertObject(document.presentation, "presentation");
  const client = assertObject(document.client, "client");
  if (typeof presentation.characterId !== "string" || !presentation.characterId) {
    throw new Error("Save file is missing a character id");
  }
  if (!Number.isInteger(client.controlledPlayerId) || client.controlledPlayerId <= 0) {
    throw new Error("Save file has an invalid controlled player id");
  }

  return document;
}

export function serializeSaveDocument(document) {
  return `${JSON.stringify(parseSaveDocument(JSON.stringify(document)), null, 2)}\n`;
}

export function persistSaveDocument(storage, document) {
  const encoded = serializeSaveDocument(document);
  storage.setItem(SAVE_STORAGE_KEY, encoded);
  return encoded;
}

export function loadPersistedSaveDocument(storage) {
  const encoded = storage.getItem(SAVE_STORAGE_KEY);
  return encoded === null ? null : parseSaveDocument(encoded);
}

export function hasPersistedSaveDocument(storage) {
  try {
    return storage.getItem(SAVE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveFileName(document) {
  const core = assertObject(document.coreState, "coreState");
  const seed = Number.isInteger(core.runSeed) ? core.runSeed : "unknown";
  const tick = Number.isInteger(core.tick) ? core.tick : "unknown";
  return `arpg-save-seed-${seed}-tick-${tick}.json`;
}
