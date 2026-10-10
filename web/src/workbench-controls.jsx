import { useState } from "react";
import { useSnapshot } from "./snapshot-views.jsx";
import { WORKBENCH_MONSTERS, spawnOperation, tuningOperation } from "./training-arena.js";

// Local-training workbench controls (#126): spawn or remove a monster at an exact offset
// from the scenario room's centre, reset the arrangement, and enter exact tuning values.
// The local arpg-core authority validates and records every operation; this panel only
// drafts them and shows the authority's validation message.
export function WorkbenchControls({ runtime, store, setStatus }) {
  const snapshot = useSnapshot(store);
  const [definition, setDefinition] = useState(WORKBENCH_MONSTERS[0].id);
  const [offsetX, setOffsetX] = useState("150");
  const [offsetZ, setOffsetZ] = useState("150");
  const [removeId, setRemoveId] = useState("");
  const [tuning, setTuning] = useState(() => runtime.trainingTuning() ?? []);
  const [parameter, setParameter] = useState(tuning[0]?.parameter ?? "");
  const [valueDraft, setValueDraft] = useState(String(tuning[0]?.value ?? ""));
  const [error, setError] = useState(null);
  const [roomId] = useState(() => runtime.trainingWorkbenchRoom());

  // Only the workbench room's monsters can be removed; others stay out of the selector.
  const living = (snapshot?.monsters ?? []).filter(
    (monster) => monster.alive && monster.roomId === roomId,
  );
  const selectedRemoveId =
    living.find((monster) => String(monster.id) === removeId)?.id ?? living[0]?.id ?? null;

  const apply = (drafted, done) => {
    if (drafted.error) {
      setError(drafted.error);
      return;
    }
    try {
      runtime.applyWorkbench(drafted.operation);
      setError(null);
      setStatus(done);
      setTuning(runtime.trainingTuning() ?? []);
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
    }
  };

  const selectParameter = (next) => {
    setParameter(next);
    const current = tuning.find((entry) => entry.parameter === next);
    setValueDraft(current ? String(current.value) : "");
  };

  return (
    // Collapsed by default so the panel stays compact over phone touch controls.
    <details className="training-workbench">
      <summary>Arrangement and tuning</summary>
      <section aria-label="Workbench arrangement and tuning">
        <div className="training-actions">
          <label>
            <span aria-hidden="true">Monster</span>
            <select
              aria-label="Monster"
              value={definition}
              onChange={(event) => setDefinition(event.target.value)}
            >
              {WORKBENCH_MONSTERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span aria-hidden="true">Offset x</span>
            <input
              aria-label="Offset x"
              type="text"
              inputMode="numeric"
              value={offsetX}
              onChange={(event) => setOffsetX(event.target.value)}
            />
          </label>
          <label>
            <span aria-hidden="true">Offset z</span>
            <input
              aria-label="Offset z"
              type="text"
              inputMode="numeric"
              value={offsetZ}
              onChange={(event) => setOffsetZ(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() =>
              apply(
                spawnOperation(definition, offsetX, offsetZ),
                `Workbench · spawned ${definition} at ${offsetX}, ${offsetZ}`,
              )
            }
          >
            Spawn
          </button>
        </div>

        <div className="training-actions">
          <label>
            <span aria-hidden="true">Living monster</span>
            <select
              aria-label="Living monster"
              value={selectedRemoveId ?? ""}
              onChange={(event) => setRemoveId(event.target.value)}
              disabled={selectedRemoveId === null}
            >
              {living.map((monster) => (
                <option key={monster.id} value={monster.id}>
                  #{monster.id} {monster.definition}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={selectedRemoveId === null}
            onClick={() =>
              apply(
                {
                  operation: {
                    type: "removeMonster",
                    monsterId: selectedRemoveId,
                  },
                },
                `Workbench · removed monster #${selectedRemoveId}`,
              )
            }
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() =>
              apply({ operation: { type: "resetArrangement" } }, "Workbench · arrangement reset")
            }
          >
            Reset arrangement
          </button>
        </div>

        {tuning.length > 0 && (
          <div className="training-actions">
            <label>
              <span aria-hidden="true">Tuning</span>
              <select
                aria-label="Tuning"
                value={parameter}
                onChange={(event) => selectParameter(event.target.value)}
              >
                {tuning.map((entry) => (
                  <option key={entry.parameter} value={entry.parameter}>
                    {entry.parameter} ({entry.value})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span aria-hidden="true">Value</span>
              <input
                aria-label="Value"
                type="text"
                inputMode="numeric"
                value={valueDraft}
                onChange={(event) => setValueDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                apply(
                  tuningOperation(parameter, valueDraft),
                  `Workbench · ${parameter} = ${valueDraft.trim()}`,
                )
              }
            >
              Set
            </button>
          </div>
        )}

        {error && (
          <p className="training-workbench-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </details>
  );
}
