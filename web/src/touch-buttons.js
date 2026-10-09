import { useEffect, useRef } from "react";

// Mobile browsers need not synthesize a click for a non-primary finger.
// Dispatch touch presses on pointerdown, but preserve clicks for mouse and keyboard.
export function usePressButton(onPress) {
  const lastTouch = useRef(-Infinity);

  return {
    onPointerDown: (event) => {
      if (event.pointerType !== "touch") return;
      event.preventDefault();
      lastTouch.current = event.timeStamp;
      onPress();
    },
    onPointerUp: (event) => {
      if (event.pointerType === "touch") lastTouch.current = event.timeStamp;
    },
    onClick: (event) => {
      // A primary touch may also produce a click. Never dispatch that action twice.
      const native = event.nativeEvent;
      if (
        native.pointerType === "touch" ||
        native.sourceCapabilities?.firesTouchEvents ||
        (event.detail > 0 &&
          event.timeStamp >= lastTouch.current &&
          event.timeStamp - lastTouch.current < 1000)
      )
        return;
      onPress();
    },
  };
}

// Capture only the pointer that began this hold. A second finger can move or
// activate other controls without ending the shield or bow draw.
export function useHeldButton(onHeldChange, enabled) {
  const pointerId = useRef(null);
  const keyboardHeld = useRef(false);
  const publish = (interrupted = false) =>
    onHeldChange(pointerId.current !== null || keyboardHeld.current, interrupted);
  const endPointer = (event, interrupted) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    publish(interrupted);
  };

  useEffect(() => {
    if (enabled || (pointerId.current === null && !keyboardHeld.current)) return;
    pointerId.current = null;
    keyboardHeld.current = false;
    onHeldChange(false, true);
  }, [enabled, onHeldChange]);

  return {
    onPointerDown: (event) => {
      if (pointerId.current !== null || (event.pointerType === "mouse" && event.button !== 0))
        return;
      if (event.pointerType === "touch") event.preventDefault();
      pointerId.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      publish();
    },
    onPointerUp: (event) => endPointer(event, false),
    onPointerCancel: (event) => endPointer(event, true),
    onLostPointerCapture: (event) => endPointer(event, true),
    onKeyDown: (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
      keyboardHeld.current = true;
      publish();
    },
    onKeyUp: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      keyboardHeld.current = false;
      publish();
    },
    // Losing keyboard focus must not release an independently held touch.
    onBlur: () => {
      if (!keyboardHeld.current) return;
      keyboardHeld.current = false;
      publish(true);
    },
    onContextMenu: (event) => event.preventDefault(),
  };
}
