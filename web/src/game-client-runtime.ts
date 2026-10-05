// Browser game-client runtime: owns the single active gameplay source (local Rust/Wasm
// authority, peer host/guest or dedicated server), command sequencing, held input and the
// fixed-tick loop outside React. React subscribes to `getState()` for bounded shell changes
// and to the snapshot store for per-tick views; it never reaches into sources directly.
//
// Lifecycle: idle → starting → running ⇄ disconnected; any active state → failed; stop()
// returns to idle and dispose() is terminal. Every source replacement advances a generation;
// late async completions from an older generation are ignored and cannot mutate the
// replacement.
//
// Background tabs: the tick loop uses the host interval timer. Browsers throttle it in
// hidden tabs, so local simulation slows rather than catching up in a burst; simulation
// time is never fast-forwarded to wall-clock time.

import { decodeSnapshot, encodeCommand } from "./wire-protocol.js";
import { trainingTicksForFrame } from "./training-arena.js";

export const TICK_INTERVAL_MS = 1000 / 60;

export type ClientMode = "local" | "host" | "guest" | "dedicated";
export type ClientLifecycle =
  | "idle"
  | "starting"
  | "running"
  | "disconnected"
  | "failed"
  | "disposed";

export interface TrainingState {
  paused: boolean;
  speed: number;
  // Named arpg-core workbench scenario the authority was created from.
  scenario: string;
}

export interface ClientState {
  lifecycle: ClientLifecycle;
  mode: ClientMode;
  playerId: number | null;
  lobbyCode: string;
  // Advances whenever a new authority or remote source replaces the previous one.
  sourceGeneration: number;
  training: TrainingState | null;
}

export type MovementKey = "forward" | "backward" | "left" | "right";
export type GuardSource = "keyboard" | "touch";

export interface WasmGameLike {
  addPlayer(id: number): void;
  removePlayer?(id: number): void;
  applyCommand(playerId: number, sequence: number, encoded: string): void;
  advanceTick(): void;
  snapshotJson(): string;
  saveStateJson(): string;
  free?(): void;
}

export interface PeerSessionLike {
  hostParticipantId?: string | null;
  host(maxParticipants: number): Promise<{ displayCode: string }>;
  join(code: string): Promise<unknown>;
  sendReliable(peerId: string, data: unknown): void;
  broadcastRealtime(data: unknown): void;
  close(): void;
}

export interface DedicatedSessionLike {
  connect(callbacks: {
    onWelcome?: (welcome: { playerId: number; tickHz: number }) => void;
    onSnapshot?: (frame: { payload: Uint8Array }) => void;
    onStateChange?: (state: string) => void;
    onError?: (error: unknown) => void;
  }): Promise<unknown>;
  sendCommand(sequence: number, payload: Uint8Array): Promise<unknown>;
  close(): void;
}

export interface SnapshotSink {
  publish(snapshot: unknown): void;
}

export interface GameClientRuntimeOptions {
  snapshots: SnapshotSink;
  createGame(seed: number, scenario?: string): WasmGameLike;
  createPeerSession(apiBase: string): PeerSessionLike;
  attachPeerSession(options: {
    session: PeerSessionLike;
    role: "host" | "guest";
    isCurrent: () => boolean;
    getGame: () => WasmGameLike | null;
    onPlayer: (playerId: number) => void;
    onSnapshot: (snapshot: unknown) => void;
    onStatus: (status: string) => void;
  }): () => void;
  createDedicatedSession(endpoint: string): DedicatedSessionLike;
  supportsWebTransport(): boolean;
  freshRunSeed(): number;
  onStatus(status: string): void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface RestoredGame {
  game: WasmGameLike;
  controlledPlayerId: number;
  lastSequence: number;
  movement: [number, number];
  // Whether the saved authority still holds the guard; this client holds nothing yet.
  guardHeld?: boolean;
  // Whether the saved authority is mid-draw; this client holds no draw yet.
  drawHeld?: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function idleMovement() {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    touchX: 0,
    touchZ: 0,
    lastX: 0,
    lastZ: 0,
  };
}

export function createGameClientRuntime(options: GameClientRuntimeOptions) {
  const schedule = options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms));
  const cancel = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));
  const listeners = new Set<() => void>();
  let state: ClientState = {
    lifecycle: "idle",
    mode: "local",
    playerId: 1,
    lobbyCode: "",
    sourceGeneration: 0,
    training: null,
  };
  let game: WasmGameLike | null = null;
  let peer: PeerSessionLike | null = null;
  let detachPeer: (() => void) | null = null;
  let dedicated: DedicatedSessionLike | null = null;
  let sequence = 0;
  let timer: unknown = null;
  let trainingCarry = 0;
  let movement = idleMovement();
  // Every device currently holding guard; the authority sees one held flag.
  const guardSources = new Set<GuardSource>();
  // Every device currently holding the bow draw. The last deliberate release shoots; an
  // interrupted hold (pointer cancel, focus loss) only cancels.
  const drawSources = new Set<GuardSource>();

  const update = (patch: Partial<ClientState>) => {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(state[key], value)) changed = true;
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const disposed = () => state.lifecycle === "disposed";
  const status = (message: string) => {
    if (!disposed()) options.onStatus(message);
  };

  const stopLoop = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const publishFromGame = () => {
    if (!game) return;
    const encoded = game.snapshotJson();
    options.snapshots.publish(decodeSnapshot(encoded));
    if (state.mode === "host") peer?.broadcastRealtime({ kind: "snapshot", encoded });
  };

  const fail = (message: string) => {
    stopLoop();
    update({ lifecycle: "failed" });
    status(message);
  };

  const advance = (ticks: number) => {
    try {
      // Publish every tick: snapshots carry that tick's transient events (strikes,
      // interactions), so batching ticks would silently drop them. Drawing stays
      // coalesced per animation frame.
      for (let tick = 0; tick < ticks; tick += 1) {
        game.advanceTick();
        publishFromGame();
      }
    } catch (error) {
      fail(`Simulation stopped: ${error}`);
    }
  };

  const onTimer = () => {
    if (!game || state.mode === "guest" || state.mode === "dedicated") return;
    let ticks = 1;
    if (state.training) {
      if (state.training.paused) return;
      const scheduled = trainingTicksForFrame(state.training.speed, trainingCarry);
      trainingCarry = scheduled.carry;
      ticks = scheduled.ticks;
      if (ticks === 0) return;
    }
    advance(ticks);
  };

  const startLoop = () => {
    stopLoop();
    timer = schedule(onTimer, TICK_INTERVAL_MS);
  };

  // Releases every resource owned by the current source and invalidates its callbacks.
  const teardown = () => {
    stopLoop();
    detachPeer?.();
    detachPeer = null;
    const peerSession = peer;
    const dedicatedSession = dedicated;
    peer = null;
    dedicated = null;
    peerSession?.close();
    dedicatedSession?.close();
    game?.free?.();
    game = null;
    sequence = 0;
    trainingCarry = 0;
    movement = idleMovement();
    guardSources.clear();
    drawSources.clear();
  };

  // Replaces the current source. The returned token identifies the new generation.
  const replaceSource = (patch: Partial<ClientState>) => {
    teardown();
    const generation = state.sourceGeneration + 1;
    update({ lobbyCode: "", training: null, ...patch, sourceGeneration: generation });
    return generation;
  };
  const isCurrent = (generation: number) => !disposed() && state.sourceGeneration === generation;

  const installLocalAuthority = (next: WasmGameLike, patch: Partial<ClientState>) => {
    const generation = replaceSource({ mode: "local", lifecycle: "running", ...patch });
    game = next;
    publishFromGame();
    startLoop();
    return generation;
  };

  const newAuthority = (seed: number, scenario?: string) => {
    const next = options.createGame(seed, scenario);
    next.addPlayer(1);
    return next;
  };

  const dispatch = (command: Record<string, unknown>) => {
    if (disposed() || state.lifecycle === "idle" || state.lifecycle === "failed") return;
    const playerId = state.playerId;
    try {
      const encoded = encodeCommand(command);
      if (state.mode === "guest") {
        if (!peer || !playerId || !peer.hostParticipantId) return;
        peer.sendReliable(peer.hostParticipantId, {
          kind: "command",
          sequence: ++sequence,
          encoded,
        });
      } else if (state.mode === "dedicated") {
        const session = dedicated;
        if (!session || !playerId) return;
        void session.sendCommand(++sequence, textEncoder.encode(encoded)).catch((error) => {
          if (dedicated === session) status(`Dedicated command failed: ${error}`);
        });
      } else {
        if (!game || !playerId) return;
        game.applyCommand(playerId, ++sequence, encoded);
      }
    } catch (error) {
      status(String(error));
    }
  };

  const flushMovement = () => {
    const keyboardX = Number(movement.right) - Number(movement.left);
    const keyboardZ = Number(movement.backward) - Number(movement.forward);
    const x = Math.max(-1, Math.min(1, keyboardX + movement.touchX));
    const z = Math.max(-1, Math.min(1, keyboardZ + movement.touchZ));
    if (x === movement.lastX && z === movement.lastZ) return;
    movement.lastX = x;
    movement.lastZ = z;
    dispatch({ type: "setMovement", x, z });
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasTickLoop: () => timer !== null,
    hasAuthority: () => game !== null,

    startLocal({
      seed,
      training = false,
      scenario,
    }: { seed?: number; training?: boolean; scenario?: string } = {}) {
      if (disposed()) return;
      const next = newAuthority(seed ?? options.freshRunSeed(), training ? scenario : undefined);
      installLocalAuthority(next, {
        playerId: 1,
        training: training ? { paused: false, speed: 1, scenario: scenario ?? "dungeon" } : null,
      });
    },

    // Restores a validated save. The caller loads the game first, so a rejected save leaves
    // the current source untouched.
    restore({
      game: next,
      controlledPlayerId,
      lastSequence,
      movement: [x, z],
      guardHeld = false,
      drawHeld = false,
    }: RestoredGame) {
      if (disposed()) {
        next.free?.();
        return;
      }
      installLocalAuthority(next, { playerId: controlledPlayerId });
      sequence = lastSequence;
      movement.lastX = x;
      movement.lastZ = z;
      if (guardHeld) dispatch({ type: "setGuard", raised: false });
      // A restored draw nobody is holding is lowered, never fired.
      if (drawHeld) dispatch({ type: "cancelBow" });
    },

    async hostPeer(apiBase: string) {
      if (disposed()) return;
      const generation = installLocalAuthority(newAuthority(options.freshRunSeed()), {
        playerId: 1,
        lifecycle: "starting",
      });
      const session = options.createPeerSession(apiBase);
      peer = session;
      detachPeer = options.attachPeerSession({
        session,
        role: "host",
        isCurrent: () => isCurrent(generation) && peer === session,
        getGame: () => game,
        onPlayer: (playerId) => update({ playerId }),
        onSnapshot: (snapshot) => options.snapshots.publish(snapshot),
        onStatus: status,
      });
      try {
        const lobby = await session.host(4);
        if (!isCurrent(generation) || peer !== session) return;
        update({ mode: "host", lifecycle: "running", lobbyCode: lobby.displayCode });
        status(`Hosting lobby ${lobby.displayCode}`);
      } catch (error) {
        if (!isCurrent(generation) || peer !== session) return;
        // Hosting failed; the local authority keeps running solo.
        detachPeer?.();
        detachPeer = null;
        peer = null;
        session.close();
        update({ mode: "local", lifecycle: "running", lobbyCode: "" });
        status(`Could not host: ${error}`);
      }
    },

    async joinPeer(apiBase: string, code: string) {
      if (disposed()) return;
      const generation = replaceSource({ mode: "guest", lifecycle: "starting", playerId: null });
      options.snapshots.publish(null);
      const session = options.createPeerSession(apiBase);
      peer = session;
      detachPeer = options.attachPeerSession({
        session,
        role: "guest",
        isCurrent: () => isCurrent(generation) && peer === session,
        getGame: () => null,
        onPlayer: (playerId) => update({ playerId, lifecycle: "running" }),
        onSnapshot: (snapshot) => options.snapshots.publish(snapshot),
        onStatus: status,
      });
      try {
        await session.join(code);
        if (!isCurrent(generation) || peer !== session) return;
        status(`Joined lobby ${code}; establishing host channel…`);
      } catch (error) {
        if (!isCurrent(generation) || peer !== session) return;
        teardown();
        update({ lifecycle: "failed" });
        status(`Could not join: ${error}`);
      }
    },

    async startDedicated(endpoint: string) {
      if (disposed()) return;
      if (!options.supportsWebTransport()) {
        status("Dedicated online requires browser WebTransport support");
        return;
      }
      const generation = replaceSource({
        mode: "dedicated",
        lifecycle: "starting",
        playerId: null,
      });
      options.snapshots.publish(null);
      const session = options.createDedicatedSession(endpoint);
      dedicated = session;
      const current = () => isCurrent(generation) && dedicated === session;
      try {
        await session.connect({
          onWelcome: (welcome) => {
            if (!current()) return;
            update({ playerId: welcome.playerId, lifecycle: "running" });
            status(`Dedicated authority · player ${welcome.playerId} · ${welcome.tickHz} Hz`);
          },
          onSnapshot: (frame) => {
            if (!current()) return;
            try {
              options.snapshots.publish(decodeSnapshot(textDecoder.decode(frame.payload)));
            } catch (error) {
              dedicated = null;
              session.close();
              update({ lifecycle: "failed", playerId: null });
              status(`Rejected dedicated snapshot: ${error}`);
            }
          },
          onStateChange: (next) => {
            if (!current()) return;
            if (next === "connecting") status("Connecting to dedicated authority…");
            if (next === "disconnected") {
              update({ playerId: null, lifecycle: "disconnected" });
              status("Dedicated authority disconnected");
            }
          },
          onError: (error) => {
            if (current()) status(`Dedicated transport error: ${error}`);
          },
        });
      } catch (error) {
        if (!current()) return;
        dedicated = null;
        update({ lifecycle: "failed", playerId: null });
        status(`Could not connect dedicated server: ${error}`);
      }
    },

    // Leaves the current game and returns to the idle (character selection) state.
    stop() {
      if (disposed()) return;
      replaceSource({ mode: "local", lifecycle: "idle", playerId: 1 });
      options.snapshots.publish(null);
    },

    dispose() {
      if (disposed()) return;
      teardown();
      update({
        lifecycle: "disposed",
        playerId: null,
        lobbyCode: "",
        training: null,
        sourceGeneration: state.sourceGeneration + 1,
      });
      listeners.clear();
    },

    dispatch,

    setHeldMovement(key: MovementKey, held: boolean) {
      if (movement[key] === held) return;
      movement[key] = held;
      flushMovement();
    },

    setTouchMovement(x: number, z: number) {
      movement.touchX = x;
      movement.touchZ = z;
      flushMovement();
    },

    // Clears every held input (focus loss, settings, context change) and stops movement.
    // Held shield input from one device; guard stays raised while any device holds it.
    setGuard(source: GuardSource, held: boolean) {
      const wasHeld = guardSources.size > 0;
      if (held) guardSources.add(source);
      else guardSources.delete(source);
      const isHeld = guardSources.size > 0;
      if (isHeld !== wasHeld) dispatch({ type: "setGuard", raised: isHeld });
    },

    // Held bow draw per device: the first hold draws; releasing the last hold shoots
    // (the authority ignores short draws) or, when `interrupted`, cancels without shooting.
    setBowDraw(source: GuardSource, held: boolean, { interrupted = false } = {}) {
      if (held) {
        if (drawSources.size === 0) dispatch({ type: "drawBow" });
        drawSources.add(source);
        return;
      }
      if (!drawSources.delete(source) || drawSources.size > 0) return;
      dispatch({ type: interrupted ? "cancelBow" : "releaseBow" });
    },

    // Drops every held bow draw without shooting (weapon switches, menus).
    cancelBowDraw() {
      if (drawSources.size === 0) return;
      drawSources.clear();
      dispatch({ type: "cancelBow" });
    },

    releaseInput() {
      movement.forward = false;
      movement.backward = false;
      movement.left = false;
      movement.right = false;
      movement.touchX = 0;
      movement.touchZ = 0;
      flushMovement();
      if (guardSources.size > 0) {
        guardSources.clear();
        dispatch({ type: "setGuard", raised: false });
      }
      // Losing focus or opening a menu must never fire a drawn bow.
      if (drawSources.size > 0) {
        drawSources.clear();
        dispatch({ type: "cancelBow" });
      }
    },

    setTrainingPaused(paused: boolean) {
      if (!state.training) return;
      update({ training: { ...state.training, paused } });
    },

    setTrainingSpeed(speed: number) {
      if (!state.training) return;
      update({ training: { ...state.training, speed } });
    },

    stepTraining() {
      if (!state.training?.paused || !game) return;
      advance(1);
    },

    // Captures the current local authority for saving; null outside local play.
    captureSaveState() {
      if (state.mode !== "local" || !game || !state.playerId) return null;
      return { saveStateJson: game.saveStateJson(), playerId: state.playerId };
    },
  };
}

export type GameClientRuntime = ReturnType<typeof createGameClientRuntime>;
