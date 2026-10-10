// A deliberately scoped action-button classifier, not a second global gesture runtime.
// Pointer traces, arbitrary gesture zones, profiles and binding resolution belong upstream
// in input-bindings (#57); this only distinguishes the supported gestures on one button.
export const TOUCH_TAP_MAX_TRAVEL_PX = 18;
export const TOUCH_SWIPE_MIN_DISTANCE_PX = 32;
const DIRECTION_DOMINANCE = 1.3;

export function classifyActionButtonStroke({ startX, startY, endX, endY, maxTravel }) {
  // A dragged finger returning to its start is not a tap.
  if (maxTravel <= TOUCH_TAP_MAX_TRAVEL_PX) return "tap";

  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.hypot(dx, dy) < TOUCH_SWIPE_MIN_DISTANCE_PX) return null;

  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (horizontal >= vertical * DIRECTION_DOMINANCE) return dx > 0 ? "right" : "left";
  if (vertical >= horizontal * DIRECTION_DOMINANCE) return dy > 0 ? "down" : "up";
  // Diagonals are intentionally unbound: never accidentally commit an attack.
  return null;
}
