export const VIRTUAL_STICK_DEAD_ZONE = 0.42;
export const VIRTUAL_STICK_DIAGONAL_RATIO = 0.72;
export const VIRTUAL_STICK_TRAVEL_RATIO = 0.62;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function sampleVirtualStick(clientX, clientY, rect) {
  const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
  const maxTravel = radius * VIRTUAL_STICK_TRAVEL_RATIO;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const rawX = clientX - centerX;
  const rawY = clientY - centerY;
  const distance = Math.hypot(rawX, rawY);
  const travelScale = distance > maxTravel ? maxTravel / distance : 1;
  const visualX = rawX * travelScale;
  const visualY = rawY * travelScale;
  const normalizedX = clamp(visualX / maxTravel, -1, 1);
  const normalizedY = clamp(visualY / maxTravel, -1, 1);
  const magnitude = Math.hypot(normalizedX, normalizedY);

  if (magnitude < VIRTUAL_STICK_DEAD_ZONE) {
    return { x: 0, z: 0, visualX, visualY };
  }

  const absX = Math.abs(normalizedX);
  const absY = Math.abs(normalizedY);
  let x = 0;
  let z = 0;

  if (absX >= absY) {
    x = Math.sign(normalizedX);
    if (absX > 0 && absY / absX >= VIRTUAL_STICK_DIAGONAL_RATIO) {
      z = Math.sign(normalizedY);
    }
  } else {
    z = Math.sign(normalizedY);
    if (absY > 0 && absX / absY >= VIRTUAL_STICK_DIAGONAL_RATIO) {
      x = Math.sign(normalizedX);
    }
  }

  return { x, z, visualX, visualY };
}
