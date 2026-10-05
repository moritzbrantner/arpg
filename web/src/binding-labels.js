// Display label for the key currently bound to an action, from the effective (profile-
// applied) bindings, so prompts follow rebinding instead of advertising the default key.
const NAMED_KEYS = {
  Space: "Space",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
};

function strokeLabel(stroke) {
  const value = stroke?.key?.value ?? "";
  const key =
    NAMED_KEYS[value] ??
    (/^Key[A-Z]$/.test(value)
      ? value.slice(3)
      : /^Digit\d$/.test(value)
        ? value.slice(5)
        : value.length === 1
          ? value.toUpperCase()
          : value);
  const modifiers = stroke?.modifiers ?? {};
  return [
    modifiers.ctrl && "Ctrl",
    modifiers.alt && "Alt",
    modifiers.shift && "Shift",
    modifiers.meta && "Meta",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

export function keyLabelForAction(bindings, actionId) {
  const binding = [...bindings]
    .filter((candidate) => candidate.action === actionId && candidate.sequence?.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  return binding ? binding.sequence.map(strokeLabel).join(" ") : null;
}
