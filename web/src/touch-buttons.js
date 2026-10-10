import { useEffect, useRef } from "react";
import { classifyActionButtonStroke } from "./touch-action-gesture.js";

function isTouchClick(event, lastTouchTime) {
  const native = event.nativeEvent;
  return (
    native.pointerType === "touch" ||
    native.sourceCapabilities?.firesTouchEvents ||
    (!native.pointerType &&
      event.detail > 0 &&
      event.timeStamp >= lastTouchTime &&
      event.timeStamp - lastTouchTime < 1000)
  );
}

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
      if (isTouchClick(event, lastTouch.current)) return;
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

// One pointer owns a sword attack gesture. Nothing is dispatched until release,
// so an upward swipe cannot also trigger the primary attack on pointerdown.
export function useGestureButton(onGesture, enabled) {
  const active = useRef(null);
  const lastTouch = useRef(-Infinity);

  useEffect(() => {
    if (!enabled) active.current = null;
  }, [enabled]);

  useEffect(() => {
    const cancel = () => {
      active.current = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const update = (event) => {
    const stroke = active.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    stroke.endX = event.clientX;
    stroke.endY = event.clientY;
    stroke.maxTravel = Math.max(
      stroke.maxTravel,
      Math.hypot(event.clientX - stroke.startX, event.clientY - stroke.startY),
    );
  };

  const cancel = (event) => {
    if (active.current?.pointerId !== event.pointerId) return;
    active.current = null;
    lastTouch.current = event.timeStamp;
  };

  return {
    onPointerDown: (event) => {
      if (event.pointerType !== "touch" || !enabled || active.current !== null) return;
      event.preventDefault();
      lastTouch.current = event.timeStamp;
      active.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        endX: event.clientX,
        endY: event.clientY,
        maxTravel: 0,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: update,
    onPointerUp: (event) => {
      if (active.current?.pointerId !== event.pointerId) return;
      update(event);
      const stroke = active.current;
      active.current = null;
      lastTouch.current = event.timeStamp;
      const gesture = classifyActionButtonStroke(stroke);
      if (gesture) onGesture(gesture);
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    // Mouse and keyboard retain ordinary click semantics. Touch synthesised
    // clicks are ignored even if the gesture was cancelled or was diagonal.
    onClick: (event) => {
      if (!enabled || isTouchClick(event, lastTouch.current)) return;
      onGesture("tap");
    },
    onContextMenu: (event) => event.preventDefault(),
  };
}
