import { useSyncExternalStore } from "react";

export function useSnapshot(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function focusedPlayer(snapshot, playerId) {
  return snapshot?.players.find((player) => player.id === playerId) ?? null;
}

export function PlayerHud({ store, playerId, status }) {
  const snapshot = useSnapshot(store);
  const player = focusedPlayer(snapshot, playerId);
  const healthPercent = player?.maxHealth
    ? Math.max(0, Math.min(100, (player.health / player.maxHealth) * 100))
    : 0;
  return (
    <section className="hud" aria-label="Player status">
      <div className="health">
        <span style={{ width: `${healthPercent}%` }} />
      </div>
      {player && (
        <div className="progression" aria-label="Character progression">
          <strong>Level {player.level}</strong>
          <span>
            XP {player.experienceIntoLevel}/{player.experienceForNextLevel}
          </span>
          <span>Damage {player.attackDamage}</span>
          <span>Gold {player.gold}</span>
          <span>
            Guard {player.guardPoints}/{player.maxGuardPoints}
          </span>
        </div>
      )}
      <p>{status}</p>
      {player && !player.alive && <p className="defeated-status">Defeated</p>}
      {player?.alive && (player.guard || player.reaction?.kind === "guardBroken") && (
        <p className="guard-status" aria-live="polite">
          {player.reaction?.kind === "guardBroken"
            ? "Guard broken"
            : player.reaction?.kind === "blocked"
              ? "Blocked"
              : player.guard.phase === "raised"
                ? "Shield raised"
                : "Raising shield"}
        </p>
      )}
      {player?.alive && player.counter && snapshot.tick < player.counter.expiresAtTick && (
        <p className="counter-prompt">
          {/* Announced once when the opportunity opens; the per-tick countdown is visual only. */}
          <span role="alert">Counter!</span>{" "}
          <span aria-hidden="true">· {player.counter.expiresAtTick - snapshot.tick}t</span>
        </p>
      )}
      {player?.action && (
        <p className="action-status">
          {player.action.kind === "secondaryAttack"
            ? "Heavy"
            : player.action.kind === "interact"
              ? "Interact"
              : player.action.kind === "counter"
                ? "Counter"
                : player.action.kind === "lightFollowUp"
                  ? "Light 2"
                  : player.action.kind === "lightFinisher"
                    ? "Light finisher"
                    : player.action.kind === "heavyFinisher"
                      ? "Heavy finisher"
                      : "Primary"}{" "}
          · {player.action.phase} · {player.action.ticksRemaining}t
        </p>
      )}
      <p className="desktop-controls-hint">
        WASD move · Space primary · Q heavy · F hold shield · E interact · Esc settings
      </p>
      <p className="mobile-controls-hint">
        Left stick to move · Attack / Heavy / Guard / Interact on the right
      </p>
    </section>
  );
}

const LIGHT_KINDS = new Set(["primaryAttack", "counter", "lightFollowUp", "lightFinisher"]);
const HEAVY_KINDS = new Set(["secondaryAttack", "heavyFinisher"]);

export function CombatActions({ store, playerId, triggerCombatAction, setTouchGuard }) {
  const player = focusedPlayer(useSnapshot(store), playerId);
  const light = LIGHT_KINDS.has(player?.action?.kind);
  const heavy = HEAVY_KINDS.has(player?.action?.kind);
  // Attack buttons stay usable during attacks: the authority decides whether a press
  // continues a combo, is buffered or is ignored.
  const canAttack = Boolean(playerId && player?.alive);
  return (
    <section className="combat-actions" aria-label="Combat actions">
      <button
        type="button"
        className={`combat-action combat-action-primary ${light ? "is-committed" : ""} ${
          player?.counter ? "is-counter-ready" : ""
        }`}
        data-phase={light ? player.action.phase : undefined}
        data-counter={player?.counter ? "ready" : undefined}
        aria-label="Primary attack"
        disabled={!canAttack}
        onClick={() => triggerCombatAction("primaryAttack")}
      >
        <strong>{player?.counter ? "Counter" : "Attack"}</strong>
        <span>Space</span>
      </button>
      <button
        type="button"
        className={`combat-action combat-action-secondary ${heavy ? "is-committed" : ""}`}
        data-phase={heavy ? player.action.phase : undefined}
        aria-label="Heavy attack"
        disabled={!canAttack}
        onClick={() => triggerCombatAction("secondaryAttack")}
      >
        <strong>Heavy</strong>
        <span>Q</span>
      </button>
      <button
        type="button"
        className={`combat-action combat-action-guard ${player?.guard ? "is-committed" : ""}`}
        data-guard={player?.guard?.phase}
        aria-label="Hold shield"
        disabled={!playerId || !player?.alive}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setTouchGuard(true);
        }}
        onPointerUp={() => setTouchGuard(false)}
        onPointerCancel={() => setTouchGuard(false)}
        onLostPointerCapture={() => setTouchGuard(false)}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !event.repeat) setTouchGuard(true);
        }}
        onKeyUp={(event) => {
          if (event.key === "Enter" || event.key === " ") setTouchGuard(false);
        }}
        onBlur={() => setTouchGuard(false)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <strong>Guard</strong>
        <span>F</span>
      </button>
      <button
        type="button"
        className={`combat-action combat-action-interact ${
          player?.action?.kind === "interact" ? "is-committed" : ""
        }`}
        data-phase={player?.action?.kind === "interact" ? player.action.phase : undefined}
        aria-label="Interact or pick up"
        disabled={!playerId || !player?.alive || Boolean(player?.action)}
        onClick={() => triggerCombatAction("interact")}
      >
        <strong>Interact</strong>
        <span>E</span>
      </button>
    </section>
  );
}

export function TrainingTick({ store }) {
  const snapshot = useSnapshot(store);
  return <span>Tick {snapshot?.tick ?? 0}</span>;
}

export function TrainingDiagnostics({ store, playerId }) {
  const snapshot = useSnapshot(store);
  const player = focusedPlayer(snapshot, playerId);
  const aliveMonsterCount = snapshot?.monsters.filter((monster) => monster.alive).length ?? 0;
  const actingMonsterCount =
    snapshot?.monsters.filter((monster) => monster.alive && monster.action).length ?? 0;
  const playerActionLabel = player?.action
    ? [
        player.action.kind,
        player.action.phase,
        `${player.action.ticksRemaining}t`,
        player.action.connected ? "hit" : null,
        player.action.buffered ? `queued ${player.action.buffered}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "idle";
  return (
    <dl className="training-diagnostics">
      <div>
        <dt>Monsters</dt>
        <dd>
          {aliveMonsterCount}/{snapshot?.monsters.length ?? 0}
        </dd>
      </div>
      <div>
        <dt>Enemy actions</dt>
        <dd>{actingMonsterCount}</dd>
      </div>
      <div>
        <dt>Player action</dt>
        <dd>{playerActionLabel}</dd>
      </div>
    </dl>
  );
}

export function GameSummary({ store, mode, playerId }) {
  const snapshot = useSnapshot(store);
  return (
    <p>
      Current mode: <strong>{mode}</strong>
      {playerId ? ` · player ${playerId}` : ""}
      {snapshot ? ` · run seed ${snapshot.runSeed}` : ""}
    </p>
  );
}
