import { useEffect, useState, useSyncExternalStore } from "react";

export function useSnapshot(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function focusedPlayer(snapshot, playerId) {
  return snapshot?.players.find((player) => player.id === playerId) ?? null;
}

export function PlayerHud({ store, playerId, status, interactKey = "E" }) {
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
          <span>{player.weapon === "bow" ? "Bow (unlimited arrows)" : "Sword & shield"}</span>
          {player.drawTicks != null && <span>Draw {player.drawTicks}t</span>}
        </div>
      )}
      <p>{status}</p>
      {player && !player.alive && <p className="defeated-status">Defeated</p>}
      {player?.alive && interactionPromptText(player.interaction, interactKey) && (
        <p className="interaction-prompt">
          {interactionPromptText(player.interaction, interactKey)}
        </p>
      )}
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
        WASD move · Space primary / hold to draw bow · Q heavy · F hold shield · X switch bow · E
        interact · Esc settings
      </p>
      <p className="mobile-controls-hint">
        Left stick to move · Attack / Heavy / Guard / Interact on the right
      </p>
    </section>
  );
}

const LIGHT_KINDS = new Set(["primaryAttack", "counter", "lightFollowUp", "lightFinisher"]);
const HEAVY_KINDS = new Set(["secondaryAttack", "heavyFinisher"]);

export function CombatActions({
  store,
  playerId,
  triggerCombatAction,
  setTouchGuard,
  setTouchDraw,
  switchWeapon,
}) {
  const player = focusedPlayer(useSnapshot(store), playerId);
  const light = LIGHT_KINDS.has(player?.action?.kind);
  const heavy = HEAVY_KINDS.has(player?.action?.kind);
  // Attack buttons stay usable during attacks: the authority decides whether a press
  // continues a combo, is buffered or is ignored.
  const canAttack = Boolean(playerId && player?.alive);
  const bow = player?.weapon === "bow";
  // With the bow, Attack is a held draw: press draws, release shoots.
  const drawHandlers = bow
    ? {
        onPointerDown: (event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setTouchDraw(true);
        },
        onPointerUp: () => setTouchDraw(false),
        // Interrupted pointers cancel the draw; only a deliberate release shoots.
        onPointerCancel: () => setTouchDraw(false, true),
        onLostPointerCapture: () => setTouchDraw(false, true),
        onKeyDown: (event) => {
          if ((event.key === "Enter" || event.key === " ") && !event.repeat) setTouchDraw(true);
        },
        onKeyUp: (event) => {
          if (event.key === "Enter" || event.key === " ") setTouchDraw(false);
        },
        onContextMenu: (event) => event.preventDefault(),
      }
    : { onClick: () => triggerCombatAction("primaryAttack") };
  return (
    <section className="combat-actions" aria-label="Combat actions">
      <button
        type="button"
        className={`combat-action combat-action-primary ${light ? "is-committed" : ""} ${
          player?.counter ? "is-counter-ready" : ""
        }`}
        data-phase={light ? player.action.phase : undefined}
        data-counter={player?.counter ? "ready" : undefined}
        aria-label={bow ? "Draw bow" : "Primary attack"}
        data-draw={player?.drawTicks != null ? "drawing" : undefined}
        disabled={!canAttack}
        {...drawHandlers}
      >
        <strong>{bow ? "Draw" : player?.counter ? "Counter" : "Attack"}</strong>
        <span>Space</span>
      </button>
      <button
        type="button"
        className={`combat-action combat-action-secondary ${heavy ? "is-committed" : ""}`}
        data-phase={heavy ? player.action.phase : undefined}
        aria-label="Heavy attack"
        disabled={!canAttack || bow}
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
        disabled={!playerId || !player?.alive || bow}
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
        className="combat-action combat-action-swap"
        aria-label={bow ? "Switch to sword and shield" : "Switch to bow"}
        disabled={!canAttack || Boolean(player?.action)}
        onClick={switchWeapon}
      >
        <strong>{bow ? "Sword" : "Bow"}</strong>
        <span>X</span>
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

const TIMELINE_LIMIT = 8;

// Prompts come from the authority's own interaction choice, never a browser radius.
function interactionPromptText(interaction, key) {
  if (interaction?.kind === "available") {
    const what = interaction.target.kind === "chest" ? "Open chest" : "Pick up gold";
    return key ? `${key} · ${what}` : `${what} (Interact is unbound)`;
  }
  if (interaction?.reason === "chestLocked") return "Chest locked until the room is cleared";
  if (interaction?.reason === "obstructed") return "Out of reach behind a wall";
  return null;
}

function describeInteraction(event) {
  const { result } = event;
  if (result.kind === "refused")
    return `player ${event.playerId} · interact refused · ${result.reason}`;
  const verb = result.kind === "opened" ? "opened" : "picked up";
  return `player ${event.playerId} · ${verb} ${result.target.kind} ${result.target.id} · +${result.gold} gold`;
}

function describeParty(party) {
  return `${party.kind} ${party.id}`;
}

function describeResult(result) {
  if (result.kind === "hit") return `hit ${result.damage}${result.defeated ? " · defeated" : ""}`;
  if (result.kind === "blocked") return `blocked · guard −${result.guardDamage}`;
  if (result.kind === "guardBroken") return "guard broken";
  return result.kind;
}

// Bounded, tick-stamped log of authoritative strike outcomes. It is evidence from the
// simulation, not a renderer animation; restarting the simulation clears it.
export function StrikeTimeline({ store }) {
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    let lastTick = -1;
    return store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (!snapshot) return;
      const restarted = snapshot.tick < lastTick;
      lastTick = snapshot.tick;
      // The authority numbers every event of a tick; show them in that order.
      const lines = [
        ...(snapshot.strikeEvents ?? []).map((event) => ({
          order: event.order,
          text: `${event.definition} · ${describeParty(event.source)} → ${describeParty(
            event.target,
          )} · ${describeResult(event.result)}`,
        })),
        ...(snapshot.interactionEvents ?? []).map((event) => ({
          order: event.order,
          text: describeInteraction(event),
        })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((line) => line.text);
      if (!restarted && lines.length === 0) return;
      setEntries((current) =>
        [
          ...lines.map((line, index) => ({
            key: `${snapshot.tick}-${index}`,
            text: `tick ${snapshot.tick} · ${line}`,
          })),
          ...(restarted ? [] : current),
        ].slice(0, TIMELINE_LIMIT),
      );
    });
  }, [store]);
  return (
    <section className="strike-timeline" aria-label="Event timeline">
      <h2>Events</h2>
      {entries.length === 0 ? (
        <p>No events yet</p>
      ) : (
        <ol>
          {entries.map((entry) => (
            <li key={entry.key}>{entry.text}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function TrainingDiagnostics({ store, playerId }) {
  const snapshot = useSnapshot(store);
  const player = focusedPlayer(snapshot, playerId);
  const aliveMonsterCount = snapshot?.monsters.filter((monster) => monster.alive).length ?? 0;
  const actingMonsterCount =
    snapshot?.monsters.filter((monster) => monster.alive && monster.action).length ?? 0;
  const pursuingMonsterCount =
    snapshot?.monsters.filter((monster) => monster.behavior === "pursuing").length ?? 0;
  const retreatingMonsterCount =
    snapshot?.monsters.filter((monster) => monster.behavior === "retreating").length ?? 0;
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
        <dt>Pursuing</dt>
        <dd>{pursuingMonsterCount}</dd>
      </div>
      <div>
        <dt>Retreating</dt>
        <dd>{retreatingMonsterCount}</dd>
      </div>
      <div>
        <dt>Player action</dt>
        <dd>{playerActionLabel}</dd>
      </div>
      <div>
        <dt>Arrows</dt>
        <dd>{snapshot?.arrows?.length ?? 0}</dd>
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
