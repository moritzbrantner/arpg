export const PROFILE_KEY = "arpg-input-profile-v1";
export const SETUP_URL_KEY = "arpg-setup-service-url-v1";
export const DEDICATED_URL_KEY = "arpg-dedicated-url-v1";
export const GRAPHICS_KEY = "arpg-graphics-v1";
export const MOUSE_AIM_KEY = "arpg-mouse-aim-v1";

export function readStoredValue(key, fallback, storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(key) ?? fallback;
  } catch {
    // Browser policy can block both storage access and reads; session defaults remain usable.
    return fallback;
  }
}

export function persistStoredValue(key, value, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(key, value);
    return true;
  } catch {
    // Persistence is optional; callers retain and apply the in-memory preference.
    return false;
  }
}

export function loadGraphics(storage) {
  try {
    const parsed = JSON.parse(readStoredValue(GRAPHICS_KEY, "null", storage));
    if (
      parsed &&
      typeof parsed.shadows === "boolean" &&
      [1, 1.5, 2].includes(parsed.pixelRatioLimit)
    ) {
      return { shadows: parsed.shadows, pixelRatioLimit: parsed.pixelRatioLimit };
    }
  } catch {
    // Invalid local presentation settings fall back to known-safe defaults.
  }
  return { shadows: true, pixelRatioLimit: 2 };
}

export function loadProfile(validate, storage) {
  try {
    const parsed = JSON.parse(readStoredValue(PROFILE_KEY, "null", storage));
    if (
      parsed &&
      typeof parsed.id === "string" &&
      Array.isArray(parsed.patches) &&
      validate(parsed)
    )
      return parsed;
  } catch {
    // Invalid local profiles fall back to the registry defaults.
  }
  return { id: "arpg-player", patches: [] };
}

// Mouse aim is opt-in: by default melee and the bow follow committed facing.
export function loadMouseAim(storage) {
  return readStoredValue(MOUSE_AIM_KEY, "off", storage) === "on";
}
