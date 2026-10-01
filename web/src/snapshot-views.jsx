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
  const healthPercent = player?.maxHealth ? Math.max(0, Math.min(100, player.health / player.maxHealth * 100)) : 0;
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
          </div>
        )}
        <p>{status}</p>
        {player && !player.alive && <p className="defeated-status">Defeated</p>}
        {player?.action && (
          <p className="action-status">
            {player.action.kind === "secondaryAttack"
              ? "Heavy"
              : player.action.kind === "interact"
                ? "Interact"
                : "Primary"}{" "}
            · {player.action.phase} · {player.action.ticksRemaining}t
          </p>
        )}
        <p className="desktop-controls-hint">
          WASD move · Space primary · Q heavy · E interact · Esc settings
        </p>
        <p className="mobile-controls-hint">
          Left stick to move · Attack / Heavy / Interact on the right
        </p>
      </section>
  );
}

export function CombatActions({ store, playerId, triggerCombatAction }) {
  const player = focusedPlayer(useSnapshot(store), playerId);
  return (
<section className="combat-actions" aria-label="Combat actions">
          <button
            type="button"
            className={`combat-action combat-action-primary ${
              player?.action?.kind === "primaryAttack" ? "is-committed" : ""
            }`}
            data-phase={player?.action?.kind === "primaryAttack" ? player.action.phase : undefined}
            aria-label="Primary attack"
            disabled={!playerId || !player?.alive || Boolean(player?.action)}
            onClick={() => triggerCombatAction("primaryAttack")}
          >
            <strong>Attack</strong>
            <span>Space</span>
          </button>
          <button
            type="button"
            className={`combat-action combat-action-secondary ${
              player?.action?.kind === "secondaryAttack" ? "is-committed" : ""
            }`}
            data-phase={player?.action?.kind === "secondaryAttack" ? player.action.phase : undefined}
            aria-label="Heavy attack"
            disabled={!playerId || !player?.alive || Boolean(player?.action)}
            onClick={() => triggerCombatAction("secondaryAttack")}
          >
            <strong>Heavy</strong>
            <span>Q</span>
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
  const actingMonsterCount = snapshot?.monsters.filter((monster) => monster.alive && monster.action).length ?? 0;
  const playerActionLabel = player?.action ? `${player.action.kind} · ${player.action.phase} · ${player.action.ticksRemaining}t` : "idle";
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
  return <p>Current mode: <strong>{mode}</strong>{playerId ? ` · player ${playerId}` : ""}{snapshot ? ` · run seed ${snapshot.runSeed}` : ""}</p>;
}
