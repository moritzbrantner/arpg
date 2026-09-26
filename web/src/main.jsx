import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { createThreeSceneRenderer } from "@moritzbrantner/three-d-renderer";
import { InputRuntimeController } from "@moritzbrantner/input-bindings-runtime";
import { attachKeyboardRuntime } from "@moritzbrantner/input-bindings-web";
import { KeybindingEditor } from "@moritzbrantner/input-bindings-react";
import "@moritzbrantner/input-bindings-react/styles.css";
import initWasm, { WasmGame } from "./wasm/arpg_web_wasm.js";
import { DedicatedGameSession } from "./dedicated-session.js";
import { ResilientLobbySession } from "./vendor/multiplayer-setup-service/resilient-lobby-session.js";
import { sampleVirtualStick } from "./virtual-stick.js";
import {
  CHARACTER_PRESETS,
  loadSelectedCharacterId,
  persistSelectedCharacterId,
  resolveCharacter,
} from "./character-selection.js";
import {
  DEFAULT_TRAINING_SEED,
  TRAINING_SPEEDS,
  parseRunSeed,
  readTrainingRequest,
  trainingTicksForFrame,
  withTrainingRequest,
} from "./training-arena.js";
import "./styles.css";

const PROFILE_KEY = "arpg-input-profile-v1";
const SETUP_URL_KEY = "arpg-setup-service-url-v1";
const DEDICATED_URL_KEY = "arpg-dedicated-url-v1";
const GRAPHICS_KEY = "arpg-graphics-v1";
const PROTOCOL_VERSION = 6;
const gameplayContext = { op: "context", id: "gameplay" };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const physical = (id, action, code, when = gameplayContext) => ({
  id,
  action,
  sequence: [{ key: { kind: "physical", value: code }, modifiers: {} }],
  when,
  priority: 0,
});

const inputRegistry = {
  actions: [
    ["game.moveForward", "Move forward", "KeyW", "allow", "Movement"],
    ["game.moveBackward", "Move backward", "KeyS", "allow", "Movement"],
    ["game.moveLeft", "Move left", "KeyA", "allow", "Movement"],
    ["game.moveRight", "Move right", "KeyD", "allow", "Movement"],
    ["game.primaryAttack", "Primary attack", "Space", "never", "Combat"],
    ["game.secondaryAttack", "Heavy attack", "KeyQ", "never", "Combat"],
    ["game.interact", "Interact / pick up", "KeyE", "never", "Interaction"],
  ]
    .map(([id, title, code, repeatPolicy, category]) => ({
      id,
      title,
      categoryPath: ["ARPG", category],
      repeatPolicy,
      allowedDevices: ["keyboard"],
      defaults: [physical(`${id}.default`, id, code)],
      provenance: { source: "arpg", version: "1" },
    }))
    .concat([
      {
        id: "game.settings",
        title: "Open or close settings",
        categoryPath: ["ARPG", "System"],
        repeatPolicy: "never",
        allowedDevices: ["keyboard"],
        defaults: [physical("game.settings.default", "game.settings", "Escape", { op: "always" })],
        provenance: { source: "arpg", version: "1" },
      },
    ]),
};

function loadProfile() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null");
    if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.patches)) return parsed;
  } catch {
    // Invalid local profile state falls back to authoritative defaults.
  }
  return { id: "arpg-player", patches: [] };
}

function loadGraphics() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GRAPHICS_KEY) ?? "null");
    if (
      parsed &&
      typeof parsed.shadows === "boolean" &&
      Number.isFinite(parsed.pixelRatioLimit)
    ) {
      return parsed;
    }
  } catch {
    // Invalid local presentation settings fall back to known-safe defaults.
  }
  return { shadows: true, pixelRatioLimit: 2 };
}

function freshRunSeed() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

function requestedRunSeed() {
  return parseRunSeed(new URLSearchParams(location.search).get("seed"));
}

function encodeCommand(payload) {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, payload });
}

function decodeSnapshot(encoded) {
  const envelope = JSON.parse(encoded);
  if (envelope?.protocolVersion !== PROTOCOL_VERSION || !envelope.payload) {
    throw new Error("Unsupported or malformed ARPG snapshot");
  }
  return envelope.payload;
}

function segmentIntersectsRect(startX, startZ, endX, endZ, minX, maxX, minZ, maxZ) {
  let minimumT = 0;
  let maximumT = 1;
  for (const [start, end, minimum, maximum] of [
    [startX, endX, minX, maxX],
    [startZ, endZ, minZ, maxZ],
  ]) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) {
      if (start < minimum || start > maximum) return false;
      continue;
    }
    const first = (minimum - start) / delta;
    const second = (maximum - start) / delta;
    const enter = Math.min(first, second);
    const exit = Math.max(first, second);
    minimumT = Math.max(minimumT, enter);
    maximumT = Math.min(maximumT, exit);
    if (minimumT > maximumT) return false;
  }
  return maximumT >= 0.03 && minimumT <= 0.97;
}

function barrierOccludesFocus(collider, target, scale) {
  if (!target || (collider.kind !== "wall" && collider.kind !== "door")) return false;
  const centerX = collider.position[0] / scale;
  const centerZ = collider.position[2] / scale;
  const halfX = collider.halfExtents[0] / scale + 0.35;
  const halfZ = collider.halfExtents[2] / scale + 0.35;
  const cameraX = target[0] + 10;
  const cameraZ = target[2] + 10;
  return segmentIntersectsRect(
    cameraX,
    cameraZ,
    target[0],
    target[2],
    centerX - halfX,
    centerX + halfX,
    centerZ - halfZ,
    centerZ + halfZ,
  );
}

function dungeonFloor(snapshot, scale) {
  if (!snapshot.rooms?.length) {
    return { center: [0, -0.08, 0], size: [18, 0.12, 13] };
  }
  const minX = Math.min(...snapshot.rooms.map((room) => room.minX)) / scale;
  const maxX = Math.max(...snapshot.rooms.map((room) => room.maxX)) / scale;
  const minZ = Math.min(...snapshot.rooms.map((room) => room.minZ)) / scale;
  const maxZ = Math.max(...snapshot.rooms.map((room) => room.maxZ)) / scale;
  return {
    center: [(minX + maxX) / 2, -0.08, (minZ + maxZ) / 2],
    size: [maxX - minX, 0.12, maxZ - minZ],
  };
}

function buildFrame(snapshot, focusPlayerId, width, height, focusPlayerAccent = "#d6b45f") {
  const scale = snapshot.worldUnitsPerMeter;
  const focus =
    snapshot.players.find((player) => player.id === focusPlayerId) ?? snapshot.players[0];
  const target = focus
    ? [focus.position[0] / scale, 0, focus.position[2] / scale]
    : [0, 0, 0];
  const aspect = Math.max(1, width) / Math.max(1, height);
  const near = 0.1;
  const far = 100;
  const fovYRadians = (43 * Math.PI) / 180;
  const top = near * Math.tan(fovYRadians * 0.5);
  const projectionHeight = 2 * top;
  const projectionWidth = aspect * projectionHeight;
  const left = -0.5 * projectionWidth;
  const projectionMatrix = new THREE.Matrix4().makePerspective(
    left,
    left + projectionWidth,
    top,
    top - projectionHeight,
    near,
    far,
    THREE.WebGPUCoordinateSystem,
    false,
  );
  const camera = new THREE.PerspectiveCamera(43, aspect, near, far);
  camera.position.set(target[0] + 10, 11, target[2] + 10);
  camera.lookAt(target[0], 0, target[2]);
  camera.updateMatrixWorld(true);
  const floor = dungeonFloor(snapshot, scale);

  const nodes = [
    {
      id: "floor",
      geometry: { kind: "box", size: floor.size },
      color: "#292722",
      transform: { translation: floor.center },
    },
    ...snapshot.staticColliders.map((collider) => {
      const fullSize = collider.halfExtents.map((value) => (value * 2) / scale);
      const isBarrier = collider.kind === "wall" || collider.kind === "door";
      const lowered = isBarrier && barrierOccludesFocus(collider, target, scale);
      const visualHeight = lowered ? Math.min(fullSize[1], 0.55) : fullSize[1];
      const translation = collider.position.map((value) => value / scale);
      if (isBarrier) translation[1] = visualHeight / 2;
      return {
        id: `static-${collider.id}`,
        geometry: {
          kind: "box",
          size: [fullSize[0], visualHeight, fullSize[2]],
        },
        color: lowered ? "#62594e" : collider.kind === "pillar" ? "#5d5142" : "#403a33",
        transform: { translation },
      };
    }),
    ...snapshot.players.flatMap((player) => {
      const position = player.position.map((value) => value / scale);
      const facing = player.action?.facing ?? player.facing ?? [1, 0];
      const facingLength = Math.hypot(facing[0], facing[1]) || 1;
      const facingX = facing[0] / facingLength;
      const facingZ = facing[1] / facingLength;
      const actionColor =
        player.action?.phase === "windup"
          ? "#e3a45d"
          : player.action?.phase === "active"
            ? "#fff0a3"
            : player.action?.phase === "recovery"
              ? "#9d8060"
              : null;
      const color = !player.alive
        ? "#45413d"
        : player.reaction?.kind === "hurt"
          ? "#e05a4f"
          : actionColor ?? (player.id === focusPlayerId ? focusPlayerAccent : "#6f91b6");
      return [
        {
          id: `player-${player.id}`,
          geometry: { kind: "cylinder", radius: 0.3, height: 1 },
          color,
          transform: { translation: position },
        },
        {
          id: `player-facing-${player.id}`,
          geometry: { kind: "sphere", radius: 0.09 },
          color: "#f5df9b",
          transform: {
            translation: [
              position[0] + facingX * 0.48,
              Math.max(position[1], 0.12),
              position[2] + facingZ * 0.48,
            ],
          },
        },
      ];
    }),
    ...snapshot.monsters
      .filter((monster) => monster.alive)
      .flatMap((monster) => {
        const translation = monster.position.map((value) => value / scale);
        if (monster.reaction?.kind === "stagger") translation[1] += 0.08;
        const phase = monster.action?.phase;
        const monsterColor =
          monster.reaction?.kind === "stagger"
            ? "#e8a25d"
            : phase === "active"
              ? "#ff6a4f"
              : phase === "windup"
                ? "#c85b46"
                : phase === "recovery"
                  ? "#6e3934"
                  : "#8f4037";
        const nodes = [
          {
            id: `monster-${monster.id}`,
            geometry: { kind: "sphere", radius: 0.42 },
            color: monsterColor,
            transform: { translation },
          },
        ];
        if ((phase === "windup" || phase === "active") && monster.action?.range) {
          const radius = monster.action.range / scale;
          const telegraphColor = phase === "active" ? "#f06a4e" : "#824239";
          for (let index = 0; index < 12; index += 1) {
            const angle = (index / 12) * Math.PI * 2;
            nodes.push({
              id: `monster-${monster.id}-telegraph-${index}`,
              geometry: { kind: "sphere", radius: phase === "active" ? 0.1 : 0.075 },
              color: telegraphColor,
              transform: {
                translation: [
                  monster.position[0] / scale + Math.cos(angle) * radius,
                  0.075,
                  monster.position[2] / scale + Math.sin(angle) * radius,
                ],
              },
            });
          }
          const targetPlayer = snapshot.players.find(
            (candidate) => candidate.id === monster.action.targetPlayerId,
          );
          if (targetPlayer?.alive) {
            nodes.push({
              id: `monster-${monster.id}-target`,
              geometry: { kind: "sphere", radius: 0.12 },
              color: telegraphColor,
              transform: {
                translation: [
                  targetPlayer.position[0] / scale,
                  0.14,
                  targetPlayer.position[2] / scale,
                ],
              },
            });
          }
        }
        return nodes;
      }),
    ...(snapshot.groundLoot ?? []).map((loot) => ({
      id: `loot-${loot.id}`,
      geometry: { kind: "sphere", radius: 0.16 },
      color: loot.kind === "gold" ? "#d9b44a" : "#c8c1b7",
      transform: {
        translation: [loot.position[0] / scale, 0.16, loot.position[2] / scale],
      },
    })),
  ];

  return {
    camera: {
      viewMatrix: camera.matrixWorldInverse.toArray(),
      projectionMatrix: projectionMatrix.toArray(),
    },
    nodes,
  };
}

function App() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const gameRef = useRef(null);
  const modeRef = useRef("local");
  const sessionRef = useRef(null);
  const dedicatedSessionRef = useRef(null);
  const peerPlayersRef = useRef(new Map());
  const sequenceRef = useRef(0);
  const touchStickRef = useRef(null);
  const touchKnobRef = useRef(null);
  const touchPointerIdRef = useRef(null);
  const initialTrainingRef = useRef(readTrainingRequest(location.search));
  const initialRunSeedRef = useRef(
    requestedRunSeed() ??
      (initialTrainingRef.current.requested ? initialTrainingRef.current.seed : freshRunSeed()),
  );
  const trainingClockCarryRef = useRef(0);
  const movementRef = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    touchX: 0,
    touchZ: 0,
    lastX: 0,
    lastZ: 0,
  });
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("local");
  const [snapshot, setSnapshot] = useState(null);
  const [playerId, setPlayerId] = useState(1);
  const [status, setStatus] = useState("Loading Rust simulation…");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inWorld, setInWorld] = useState(false);
  const [scenario, setScenario] = useState(
    initialTrainingRef.current.requested ? "training" : "adventure",
  );
  const [trainingPaused, setTrainingPaused] = useState(false);
  const [trainingSpeed, setTrainingSpeed] = useState(1);
  const [trainingSeedDraft, setTrainingSeedDraft] = useState(
    String(initialTrainingRef.current.seed),
  );
  const [selectedCharacterId, setSelectedCharacterId] = useState(() =>
    loadSelectedCharacterId(localStorage),
  );
  const [profile, setProfile] = useState(loadProfile);
  const [graphics, setGraphics] = useState(loadGraphics);
  const [setupUrl, setSetupUrl] = useState(
    () => localStorage.getItem(SETUP_URL_KEY) ?? "http://127.0.0.1:8787",
  );
  const [dedicatedUrl, setDedicatedUrl] = useState(
    () => localStorage.getItem(DEDICATED_URL_KEY) ?? "https://127.0.0.1:4433/arpg",
  );
  const [lobbyCode, setLobbyCode] = useState("");
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(location.search).get("join") ?? "",
  );

  const selectedCharacter = useMemo(
    () => resolveCharacter(selectedCharacterId),
    [selectedCharacterId],
  );
  const player = useMemo(
    () => snapshot?.players.find((candidate) => candidate.id === playerId) ?? null,
    [snapshot, playerId],
  );
  const healthPercent = player?.maxHealth
    ? Math.max(0, Math.min(100, (player.health / player.maxHealth) * 100))
    : 0;

  const setModeValue = (next) => {
    modeRef.current = next;
    setMode(next);
  };

  const resetMovement = () => {
    touchPointerIdRef.current = null;
    if (touchKnobRef.current) {
      touchKnobRef.current.style.transform = "translate3d(0px, 0px, 0)";
    }
    movementRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      touchX: 0,
      touchZ: 0,
      lastX: 0,
      lastZ: 0,
    };
  };

  const updateSnapshotFromGame = () => {
    if (!gameRef.current) return;
    const encoded = gameRef.current.snapshotJson();
    setSnapshot(decodeSnapshot(encoded));
    if (modeRef.current === "host") {
      sessionRef.current?.broadcastRealtime({ kind: "snapshot", encoded });
    }
  };

  const createAuthority = (runSeed = freshRunSeed()) => {
    gameRef.current?.free?.();
    const game = new WasmGame(runSeed);
    game.addPlayer(1);
    gameRef.current = game;
    sequenceRef.current = 0;
    peerPlayersRef.current.clear();
    resetMovement();
    setPlayerId(1);
    updateSnapshotFromGame();
  };

  const closeSession = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    dedicatedSessionRef.current?.close();
    dedicatedSessionRef.current = null;
    peerPlayersRef.current.clear();
    setLobbyCode("");
  };

  const dispatchCommand = (command) => {
    const sequence = ++sequenceRef.current;
    const encoded = encodeCommand(command);
    try {
      if (modeRef.current === "guest") {
        const session = sessionRef.current;
        if (!session || !playerId || !session.hostParticipantId) return;
        session.sendReliable(session.hostParticipantId, {
          kind: "command",
          sequence,
          encoded,
        });
      } else if (modeRef.current === "dedicated") {
        const session = dedicatedSessionRef.current;
        if (!session || !playerId) return;
        void session
          .sendCommand(sequence, textEncoder.encode(encoded))
          .catch((error) => setStatus(`Dedicated command failed: ${error}`));
      } else {
        gameRef.current?.applyCommand(playerId, sequence, encoded);
      }
    } catch (error) {
      setStatus(String(error));
    }
  };

  const flushMovement = () => {
    const movement = movementRef.current;
    const keyboardX = Number(movement.right) - Number(movement.left);
    const keyboardZ = Number(movement.backward) - Number(movement.forward);
    const x = Math.max(-1, Math.min(1, keyboardX + movement.touchX));
    const z = Math.max(-1, Math.min(1, keyboardZ + movement.touchZ));
    if (x === movement.lastX && z === movement.lastZ) return;
    movement.lastX = x;
    movement.lastZ = z;
    dispatchCommand({ type: "setMovement", x, z });
  };

  const resetTouchStick = () => {
    touchPointerIdRef.current = null;
    if (touchKnobRef.current) {
      touchKnobRef.current.style.transform = "translate3d(0px, 0px, 0)";
    }
    const movement = movementRef.current;
    if (movement.touchX === 0 && movement.touchZ === 0) return;
    movement.touchX = 0;
    movement.touchZ = 0;
    flushMovement();
  };

  const updateTouchStick = (event) => {
    if (touchPointerIdRef.current !== event.pointerId) return;
    const stick = touchStickRef.current;
    if (!stick) return;
    const sample = sampleVirtualStick(event.clientX, event.clientY, stick.getBoundingClientRect());
    if (touchKnobRef.current) {
      touchKnobRef.current.style.transform = `translate3d(${sample.visualX}px, ${sample.visualY}px, 0)`;
    }
    const movement = movementRef.current;
    movement.touchX = sample.x;
    movement.touchZ = sample.z;
    flushMovement();
  };

  const beginTouchStick = (event) => {
    if (!playerId || !player?.alive || touchPointerIdRef.current !== null) return;
    event.preventDefault();
    touchPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateTouchStick(event);
  };

  const endTouchStick = (event) => {
    if (touchPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resetTouchStick();
  };

  const triggerCombatAction = (type) => {
    if (!playerId || !player?.alive) return;
    dispatchCommand({ type });
  };

  const configureSession = (session, role) => {
    session.addEventListener("peer-ready", (event) => {
      const peerId = event.detail.peerId;
      if (role !== "host") {
        setStatus("Connected to host; waiting for player assignment…");
        return;
      }
      let assigned = peerPlayersRef.current.get(peerId);
      if (!assigned) {
        const used = new Set(peerPlayersRef.current.values());
        assigned = [2, 3, 4].find((candidate) => !used.has(candidate));
        if (!assigned) {
          setStatus("Lobby is full");
          return;
        }
        gameRef.current.addPlayer(assigned);
        peerPlayersRef.current.set(peerId, assigned);
      }
      session.sendReliable(peerId, {
        kind: "welcome",
        playerId: assigned,
        encodedSnapshot: gameRef.current.snapshotJson(),
      });
      setStatus(`Peer connected as player ${assigned}`);
    });

    session.addEventListener("reliable", (event) => {
      const { peerId, data } = event.detail;
      if (role === "host" && data?.kind === "command") {
        const assigned = peerPlayersRef.current.get(peerId);
        if (!assigned) return;
        try {
          gameRef.current.applyCommand(assigned, data.sequence, data.encoded);
        } catch (error) {
          setStatus(`Rejected peer command: ${error}`);
        }
      } else if (role === "guest" && data?.kind === "welcome") {
        setPlayerId(data.playerId);
        setSnapshot(decodeSnapshot(data.encodedSnapshot));
        setStatus(`Connected as player ${data.playerId}`);
      }
    });

    session.addEventListener("realtime", (event) => {
      if (role !== "guest" || event.detail.data?.kind !== "snapshot") return;
      setSnapshot(decodeSnapshot(event.detail.data.encoded));
    });

    session.addEventListener("participant-disconnected", (event) => {
      if (role !== "host") return;
      const assigned = peerPlayersRef.current.get(event.detail.participantId);
      if (!assigned) return;
      peerPlayersRef.current.delete(event.detail.participantId);
      gameRef.current?.removePlayer(assigned);
      setStatus(`Player ${assigned} disconnected`);
    });

    session.addEventListener("statechange", (event) => {
      if (event.detail?.state) setStatus(`Network: ${event.detail.state}`);
    });
  };

  const leaveTrainingScenario = () => {
    trainingClockCarryRef.current = 0;
    setScenario("adventure");
    history.replaceState(null, "", withTrainingRequest(location.href, false, 0));
  };

  const enterTrainingArena = (candidateSeed = trainingSeedDraft) => {
    if (!ready) return;
    const seed = parseRunSeed(candidateSeed);
    if (seed === null) {
      setStatus("Training seed must be an unsigned 32-bit integer");
      return;
    }
    const selectedId = persistSelectedCharacterId(localStorage, selectedCharacterId);
    const selected = resolveCharacter(selectedId);
    closeSession();
    createAuthority(seed);
    initialRunSeedRef.current = null;
    trainingClockCarryRef.current = 0;
    setTrainingSeedDraft(String(seed));
    setTrainingPaused(false);
    setTrainingSpeed(1);
    setScenario("training");
    setModeValue("local");
    setInWorld(true);
    history.replaceState(null, "", withTrainingRequest(location.href, true, seed));
    setStatus(`Training arena · ${selected.name}`);
  };

  const restartTrainingArena = (candidateSeed = trainingSeedDraft) => {
    const seed = parseRunSeed(candidateSeed);
    if (seed === null || scenario !== "training") {
      setStatus("Training seed must be an unsigned 32-bit integer");
      return;
    }
    createAuthority(seed);
    trainingClockCarryRef.current = 0;
    setTrainingSeedDraft(String(seed));
    history.replaceState(null, "", withTrainingRequest(location.href, true, seed));
    setStatus(`Training arena restarted · seed ${seed}`);
  };

  const stepTrainingArena = () => {
    if (scenario !== "training" || !trainingPaused || !gameRef.current) return;
    try {
      gameRef.current.advanceTick();
      updateSnapshotFromGame();
    } catch (error) {
      setStatus(`Simulation stopped: ${error}`);
    }
  };

  const enterWorld = () => {
    if (!ready) return;
    const selectedId = persistSelectedCharacterId(localStorage, selectedCharacterId);
    const selected = resolveCharacter(selectedId);
    closeSession();
    createAuthority(initialRunSeedRef.current ?? freshRunSeed());
    initialRunSeedRef.current = null;
    leaveTrainingScenario();
    setModeValue("local");
    setInWorld(true);
    setStatus(`Local Rust/Wasm authority · ${selected.name}`);
  };

  const returnToCharacters = () => {
    closeSession();
    resetMovement();
    gameRef.current?.free?.();
    gameRef.current = null;
    sequenceRef.current = 0;
    setSnapshot(null);
    setPlayerId(1);
    setSettingsOpen(false);
    setInWorld(false);
    leaveTrainingScenario();
    setStatus("Choose a character to enter the world");
  };

  const startLocal = () => {
    closeSession();
    createAuthority();
    leaveTrainingScenario();
    setModeValue("local");
    setStatus(`Local Rust/Wasm authority · ${selectedCharacter.name}`);
  };

  const startDedicated = async () => {
    if (!("WebTransport" in globalThis)) {
      setStatus("Dedicated online requires browser WebTransport support");
      return;
    }
    closeSession();
    gameRef.current?.free?.();
    gameRef.current = null;
    sequenceRef.current = 0;
    resetMovement();
    setSnapshot(null);
    setPlayerId(null);
    leaveTrainingScenario();
    setModeValue("dedicated");

    const session = new DedicatedGameSession({ endpoint: dedicatedUrl.trim() });
    dedicatedSessionRef.current = session;
    try {
      await session.connect({
        onWelcome: (welcome) => {
          setPlayerId(welcome.playerId);
          setStatus(
            `Dedicated authority · player ${welcome.playerId} · ${welcome.tickHz} Hz`,
          );
        },
        onSnapshot: (frame) => {
          try {
            setSnapshot(decodeSnapshot(textDecoder.decode(frame.payload)));
          } catch (error) {
            setStatus(`Rejected dedicated snapshot: ${error}`);
            session.close();
          }
        },
        onStateChange: (state) => {
          if (state === "connecting") setStatus("Connecting to dedicated authority…");
          if (state === "disconnected") {
            setPlayerId(null);
            setStatus("Dedicated authority disconnected");
          }
        },
        onError: (error) => setStatus(`Dedicated transport error: ${error}`),
      });
    } catch (error) {
      if (dedicatedSessionRef.current === session) dedicatedSessionRef.current = null;
      setStatus(`Could not connect dedicated server: ${error}`);
    }
  };

  const hostPeerGame = async () => {
    try {
      closeSession();
      createAuthority();
      leaveTrainingScenario();
      const session = new ResilientLobbySession({
        apiBase: setupUrl,
        topology: "host",
      });
      configureSession(session, "host");
      sessionRef.current = session;
      const lobby = await session.host(4);
      setModeValue("host");
      setLobbyCode(lobby.displayCode);
      setStatus(`Hosting lobby ${lobby.displayCode}`);
    } catch (error) {
      setStatus(`Could not host: ${error}`);
    }
  };

  const joinPeerGame = async () => {
    try {
      closeSession();
      gameRef.current?.free?.();
      gameRef.current = null;
      sequenceRef.current = 0;
      resetMovement();
      setSnapshot(null);
      setPlayerId(null);
      leaveTrainingScenario();
      const session = new ResilientLobbySession({
        apiBase: setupUrl,
        topology: "host",
      });
      configureSession(session, "guest");
      sessionRef.current = session;
      await session.join(joinCode);
      setModeValue("guest");
      setStatus(`Joined lobby ${joinCode}; establishing host channel…`);
    } catch (error) {
      setStatus(`Could not join: ${error}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    initWasm()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        if (initialTrainingRef.current.requested) {
          const seed = initialRunSeedRef.current ?? DEFAULT_TRAINING_SEED;
          const selected = resolveCharacter(selectedCharacterId);
          createAuthority(seed);
          initialRunSeedRef.current = null;
          trainingClockCarryRef.current = 0;
          setTrainingSeedDraft(String(seed));
          setTrainingPaused(false);
          setTrainingSpeed(1);
          setScenario("training");
          setModeValue("local");
          setInWorld(true);
          history.replaceState(null, "", withTrainingRequest(location.href, true, seed));
          setStatus(`Training arena · ${selected.name}`);
        } else {
          setStatus("Choose a character to enter the world");
        }
      })
      .catch((error) => setStatus(`Wasm failed: ${error}`));
    return () => {
      cancelled = true;
      closeSession();
      gameRef.current?.free?.();
    };
  }, []);

  useEffect(() => {
    if (!ready || !inWorld) return undefined;
    trainingClockCarryRef.current = 0;
    const timer = setInterval(() => {
      if (
        modeRef.current === "guest" ||
        modeRef.current === "dedicated" ||
        !gameRef.current
      ) {
        return;
      }

      let ticks = 1;
      if (scenario === "training") {
        if (trainingPaused) return;
        const scheduled = trainingTicksForFrame(trainingSpeed, trainingClockCarryRef.current);
        trainingClockCarryRef.current = scheduled.carry;
        ticks = scheduled.ticks;
        if (ticks === 0) return;
      }

      try {
        for (let tick = 0; tick < ticks; tick += 1) {
          gameRef.current.advanceTick();
        }
        updateSnapshotFromGame();
      } catch (error) {
        setStatus(`Simulation stopped: ${error}`);
      }
    }, 1000 / 60);
    return () => clearInterval(timer);
  }, [ready, inWorld, scenario, trainingPaused, trainingSpeed]);

  useEffect(() => {
    if (!inWorld || !canvasRef.current) return undefined;
    const renderer = createThreeSceneRenderer(canvasRef.current, {
      background: "#11100f",
      shadows: graphics.shadows,
      pixelRatioLimit: graphics.pixelRatioLimit,
    });
    rendererRef.current = renderer;
    const resize = () => {
      const rect = canvasRef.current.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, devicePixelRatio);
      if (snapshot) {
        renderer.render(buildFrame(snapshot, playerId, rect.width, rect.height, selectedCharacter.accent));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvasRef.current);
    resize();
    return () => {
      observer.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [graphics.shadows, graphics.pixelRatioLimit, inWorld, selectedCharacter.accent]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !snapshot) return;
    const rect = canvas.getBoundingClientRect();
    renderer.render(buildFrame(snapshot, playerId, rect.width, rect.height, selectedCharacter.accent));
  }, [snapshot, playerId, selectedCharacter.accent]);

  useEffect(() => {
    if (settingsOpen) resetTouchStick();
  }, [settingsOpen]);

  useEffect(() => {
    if (!ready || !inWorld) return undefined;
    const controller = new InputRuntimeController({
      registry: inputRegistry,
      profile,
      getActiveContexts: () => new Set(settingsOpen ? [] : ["gameplay"]),
      consumePolicy: "matched",
      onDispatch: (dispatch) => {
        if (dispatch.action === "game.settings" && dispatch.phase === "press") {
          setSettingsOpen((open) => !open);
          return;
        }
        if (settingsOpen) return;
        const combatCommand = {
          "game.primaryAttack": "primaryAttack",
          "game.secondaryAttack": "secondaryAttack",
          "game.interact": "interact",
        }[dispatch.action];
        if (combatCommand && dispatch.phase === "press") {
          dispatchCommand({ type: combatCommand });
          return;
        }
        const key = {
          "game.moveForward": "forward",
          "game.moveBackward": "backward",
          "game.moveLeft": "left",
          "game.moveRight": "right",
        }[dispatch.action];
        if (!key) return;
        movementRef.current[key] = dispatch.phase !== "release";
        flushMovement();
      },
    });
    const detach = attachKeyboardRuntime(controller, {
      mode: "physical",
      ignoreTextEntry: true,
      stopPropagation: true,
    });
    return detach;
  }, [ready, inWorld, profile, settingsOpen, mode, playerId]);

  const updateProfile = (next) => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    setProfile(next);
  };

  const updateGraphics = (next) => {
    localStorage.setItem(GRAPHICS_KEY, JSON.stringify(next));
    setGraphics(next);
  };

  const updateSetupUrl = (value) => {
    setSetupUrl(value);
    localStorage.setItem(SETUP_URL_KEY, value);
  };

  const updateDedicatedUrl = (value) => {
    setDedicatedUrl(value);
    localStorage.setItem(DEDICATED_URL_KEY, value);
  };

  const selectCharacter = (characterId) => {
    setSelectedCharacterId(persistSelectedCharacterId(localStorage, characterId));
  };

  const copyInvite = async () => {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("join", lobbyCode);
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite URL copied with public lobby code only");
  };

  const modeLabel =
    scenario === "training"
      ? "Training arena"
      : mode === "local"
        ? "Local"
        : mode === "host"
          ? "Peer host"
          : mode === "guest"
            ? "Peer guest"
            : "Dedicated online";

  const aliveMonsterCount = snapshot?.monsters.filter((monster) => monster.alive).length ?? 0;
  const actingMonsterCount =
    snapshot?.monsters.filter((monster) => monster.alive && monster.action).length ?? 0;
  const playerActionLabel = player?.action
    ? `${player.action.kind} · ${player.action.phase} · ${player.action.ticksRemaining}t`
    : "idle";

  if (!inWorld) {
    return (
      <main className="character-select-shell" aria-label="Character selection">
        <div className="character-select-atmosphere" aria-hidden="true" />
        <header className="character-select-header">
          <div>
            <span className="character-select-eyebrow">ARPG</span>
            <h1>Choose your character</h1>
            <p>Select an adventurer, then enter the world.</p>
          </div>
          <div className="realm-chip" aria-label="Current realm">
            <span>Realm</span>
            <strong>Local Realm</strong>
          </div>
        </header>

        <div className="character-select-layout">
          <section className="character-stage" aria-live="polite">
            <div className="character-stage-ground" aria-hidden="true" />
            <div
              className={`character-avatar character-avatar-${selectedCharacter.tone}`}
              style={{ "--character-accent": selectedCharacter.accent }}
              aria-hidden="true"
            >
              <span className="character-aura" />
              <span className="character-head" />
              <span className="character-torso" />
              <span className="character-arm character-arm-left" />
              <span className="character-arm character-arm-right" />
              <span className="character-leg character-leg-left" />
              <span className="character-leg character-leg-right" />
              <span className="character-weapon" />
            </div>
            <div className="character-stage-copy">
              <span>{selectedCharacter.role}</span>
              <h2>{selectedCharacter.name}</h2>
              <p>
                {selectedCharacter.appearance} appearance · {selectedCharacter.location}
              </p>
            </div>
          </section>

          <aside className="character-roster" aria-label="Characters">
            <div className="character-roster-heading">
              <span>Characters</span>
              <strong>{CHARACTER_PRESETS.length}</strong>
            </div>
            <div className="character-roster-list">
              {CHARACTER_PRESETS.map((character) => {
                const selected = character.id === selectedCharacter.id;
                return (
                  <button
                    key={character.id}
                    type="button"
                    className={`character-card ${selected ? "is-selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => selectCharacter(character.id)}
                  >
                    <span
                      className={`character-card-portrait character-card-portrait-${character.tone}`}
                      style={{ "--character-accent": character.accent }}
                      aria-hidden="true"
                    />
                    <span className="character-card-copy">
                      <strong>{character.name}</strong>
                      <small>{character.role}</small>
                    </span>
                    <span className="character-card-meta">{character.appearance}</span>
                  </button>
                );
              })}
            </div>
            <p className="character-selection-note">
              Appearance profiles currently share the same authoritative gameplay rules.
            </p>
          </aside>
        </div>

        <footer className="character-select-footer">
          <span className="character-select-status">
            {ready ? "World runtime ready" : status}
          </span>
          <button
            type="button"
            className="training-entry-button"
            onClick={() => enterTrainingArena(trainingSeedDraft)}
            disabled={!ready}
          >
            Training Arena
          </button>
          <button
            type="button"
            className="enter-world-button"
            onClick={enterWorld}
            disabled={!ready}
          >
            Enter World
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" aria-label="ARPG game world" />
      <header className="game-header">
        <div>
          <strong>ARPG foundation MVP</strong>
          <span>{modeLabel}</span>
        </div>
        <div className="game-header-actions">
          <button type="button" onClick={returnToCharacters}>
            Characters
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {scenario === "training" && (
        <aside className="training-panel" aria-label="Training arena controls">
          <header>
            <strong>Training arena</strong>
            <span>Tick {snapshot?.tick ?? 0}</span>
          </header>

          <div className="training-actions">
            <button type="button" onClick={() => setTrainingPaused((paused) => !paused)}>
              {trainingPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={stepTrainingArena} disabled={!trainingPaused}>
              Step
            </button>
            <label>
              <span>Speed</span>
              <select
                value={trainingSpeed}
                onChange={(event) => setTrainingSpeed(Number(event.target.value))}
              >
                {TRAINING_SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="training-seed">
            <label>
              <span>Seed</span>
              <input
                type="number"
                min="0"
                max="4294967295"
                step="1"
                inputMode="numeric"
                value={trainingSeedDraft}
                onChange={(event) => setTrainingSeedDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => restartTrainingArena(trainingSeedDraft)}
              disabled={parseRunSeed(trainingSeedDraft) === null}
            >
              Restart
            </button>
            <button
              type="button"
              onClick={() => {
                const seed = freshRunSeed();
                setTrainingSeedDraft(String(seed));
                restartTrainingArena(seed);
              }}
            >
              New seed
            </button>
          </div>

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
        </aside>
      )}

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

      {ready && !settingsOpen && (
        <section className="mobile-controls" aria-label="Touch controls">
          <div
            ref={touchStickRef}
            className="virtual-stick"
            role="group"
            aria-label="Movement joystick"
            aria-disabled={!playerId || !player?.alive}
            onPointerDown={beginTouchStick}
            onPointerMove={updateTouchStick}
            onPointerUp={endTouchStick}
            onPointerCancel={endTouchStick}
            onLostPointerCapture={endTouchStick}
            onContextMenu={(event) => event.preventDefault()}
          >
            <span ref={touchKnobRef} className="virtual-stick-knob" />
          </div>
        </section>
      )}

      {ready && !settingsOpen && (
        <section className="combat-actions" aria-label="Combat actions">
          <button
            type="button"
            className={`combat-action combat-action-primary ${
              player?.action?.kind === "primaryAttack" ? "is-committed" : ""
            }`}
            data-phase={player?.action?.kind === "primaryAttack" ? player.action.phase : undefined}
            aria-label="Primary attack"
            disabled={!playerId || !player?.alive || Boolean(player?.action)}
            onPointerDown={(event) => {
              event.preventDefault();
              triggerCombatAction("primaryAttack");
            }}
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
            onPointerDown={(event) => {
              event.preventDefault();
              triggerCombatAction("secondaryAttack");
            }}
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
            onPointerDown={(event) => {
              event.preventDefault();
              triggerCombatAction("interact");
            }}
          >
            <strong>Interact</strong>
            <span>E</span>
          </button>
        </section>
      )}

      {settingsOpen && (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <aside className="settings-panel" aria-label="Settings menu">
            <header>
              <div>
                <h1>Settings</h1>
                <p>
                  Shared foundations are configured here rather than in the renderer or simulation.
                </p>
              </div>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </header>

            <section>
              <h2>Game</h2>
              <p>
                Current mode: <strong>{mode}</strong>
                {playerId ? ` · player ${playerId}` : ""}
                {snapshot ? ` · run seed ${snapshot.runSeed}` : ""}
              </p>
              <button type="button" onClick={startLocal}>
                Start local game
              </button>
            </section>

            <section>
              <h2>Dedicated online</h2>
              <label>
                WebTransport endpoint
                <input
                  value={dedicatedUrl}
                  onChange={(event) => updateDedicatedUrl(event.target.value)}
                  placeholder="https://127.0.0.1:4433/arpg"
                />
              </label>
              <button
                type="button"
                onClick={startDedicated}
                disabled={!ready || !dedicatedUrl.trim()}
              >
                Connect dedicated server
              </button>
              <p className="settings-note">
                The shared game-server owns admission, ticks, reconnect identity, recovery, and
                snapshot framing. The browser only submits versioned ARPG commands and renders
                verified authoritative snapshots.
              </p>
            </section>

            <section>
              <h2>Peer co-op</h2>
              <label>
                Setup service URL
                <input
                  value={setupUrl}
                  onChange={(event) => updateSetupUrl(event.target.value)}
                />
              </label>
              <div className="settings-actions">
                <button type="button" onClick={hostPeerGame} disabled={!ready}>
                  Host co-op
                </button>
                {lobbyCode && (
                  <button type="button" onClick={copyInvite}>
                    Copy invite {lobbyCode}
                  </button>
                )}
              </div>
              <label>
                Lobby code
                <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} />
              </label>
              <button type="button" onClick={joinPeerGame} disabled={!joinCode.trim()}>
                Join host
              </button>
              <p className="settings-note">
                The setup service handles rendezvous only. Gameplay commands and snapshots use direct
                WebRTC data channels.
              </p>
            </section>

            <section>
              <h2>Graphics</h2>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={graphics.shadows}
                  onChange={(event) =>
                    updateGraphics({ ...graphics, shadows: event.target.checked })
                  }
                />
                Enable shadows
              </label>
              <label>
                Pixel ratio limit
                <select
                  value={graphics.pixelRatioLimit}
                  onChange={(event) =>
                    updateGraphics({
                      ...graphics,
                      pixelRatioLimit: Number(event.target.value),
                    })
                  }
                >
                  <option value="1">1×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                </select>
              </label>
            </section>

            <section className="keybindings-section">
              <h2>Controls</h2>
              <KeybindingEditor
                registry={inputRegistry}
                profile={profile}
                onProfileChange={updateProfile}
              />
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
