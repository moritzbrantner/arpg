import { useEffect, useRef } from "react";

export function SettingsDialog({ children, onClose, returnFocusTo }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const focusTarget = returnFocusTo?.current;
    dialog.showModal();
    return () => {
      dialog.close();
      focusTarget?.focus();
    };
  }, [returnFocusTo]);

  return (
    <dialog
      ref={dialogRef}
      className="settings-panel"
      aria-labelledby="settings-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
