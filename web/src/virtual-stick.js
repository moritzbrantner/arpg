export const VIRTUAL_STICK_DEAD_ZONE = 0.28;
export const VIRTUAL_STICK_TRAVEL_RATIO = 0.55;

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
  const digitalAxis = (value) =>
    Math.abs(value) < VIRTUAL_STICK_DEAD_ZONE ? 0 : Math.sign(value);

  return {
    x: digitalAxis(normalizedX),
    z: digitalAxis(normalizedY),
    visualX,
    visualY,
  };
}
