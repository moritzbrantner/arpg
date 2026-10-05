import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { createThreeSceneRenderer } from "@moritzbrantner/three-d-renderer";
import { validateRegistry } from "@moritzbrantner/input-bindings";
import { createSnapshotStore } from "./snapshot-store.js";
import {
  PlayerHud,
  CombatActions,
  TrainingDiagnostics,
  TrainingTick,
  GameSummary,
} from "./snapshot-views.jsx";
import { SettingsDialog } from "./settings-dialog.jsx";
import {
  PROFILE_KEY,
  SETUP_URL_KEY,
  DEDICATED_URL_KEY,
  GRAPHICS_KEY,
  loadProfile,
  loadGraphics,
  readStoredValue,
  persistStoredValue,
} from "./preferences.js";
import { InputRuntimeController } from "@moritzbrantner/input-bindings-runtime";
import { attachKeyboardRuntime } from "@moritzbrantner/input-bindings-web";
import { KeybindingEditor } from "@moritzbrantner/input-bindings-react";
import "@moritzbrantner/input-bindings-react/styles.css";
import initWasm, { WasmGame, loadGameFromSaveStateJson } from "./wasm/arpg_web_wasm.js";
import { attachPeerGameSession } from "./peer-session.js";
import { DedicatedGameSession } from "./dedicated-session.js";
import { DemoLobbySession } from "./vendor/multiplayer-setup-service/demo-session.ts";
import { sampleVirtualStick } from "./virtual-stick.js";
import {
  CHARACTER_PRESETS,
  loadSelectedCharacterId,
  persistSelectedCharacterId,
  resolveCharacter,
} from "./character-selection.js";
import {
  MAX_SAVE_FILE_BYTES,
  createSaveDocument,
  hasPersistedSaveDocument,
  loadPersistedSaveDocument,
  parseSaveDocument,
  persistSaveDocument,
  saveFileName,
  serializeSaveDocument,
} from "./save-state.js";
import {
  DEFAULT_TRAINING_SEED,
  TRAINING_SPEEDS,
  parseRunSeed,
  readTrainingRequest,
  withTrainingRequest,
} from "./training-arena.js";
import { createGameClientRuntime } from "./game-client-runtime.ts";
import "./styles.css";

const gameplayContext = { op: "context", id: "gameplay" };

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
    ["game.guard", "Raise shield (hold)", "KeyF", "never", "Combat"],
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

function freshRunSeed() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

function requestedRunSeed() {
  return parseRunSeed(new URLSearchParams(location.search).get("seed"));
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
  const target = focus ? [focus.position[0] / scale, 0, focus.position[2] / scale] : [0, 0, 0];
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
          : player.reaction?.kind === "guardBroken"
            ? "#9b6bd6"
            : (actionColor ?? (player.id === focusPlayerId ? focusPlayerAccent : "#6f91b6"));
      // The thin shield board faces along the player's facing.
      const shieldYaw = Math.atan2(facingX, facingZ);
      const shield = player.guard
        ? [
            {
              id: `player-shield-${player.id}`,
              geometry: { kind: "box", size: [0.5, 0.6, 0.08] },
              color:
                player.reaction?.kind === "blocked"
                  ? "#e8f4ff"
                  : player.guard.phase === "raised"
                    ? "#8fb3d9"
                    : "#55687d",
              transform: {
                translation: [
                  position[0] + facingX * 0.42,
                  Math.max(position[1], 0.5),
                  position[2] + facingZ * 0.42,
                ],
                rotationQuaternion: [0, Math.sin(shieldYaw / 2), 0, Math.cos(shieldYaw / 2)],
              },
            },
          ]
        : [];
      return [
        ...shield,
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
  const settingsTriggerRef = useRef(null);
  const touchStickRef = useRef(null);
  const touchKnobRef = useRef(null);
  const touchPointerIdRef = useRef(null);
  const saveFileInputRef = useRef(null);
  const [initialRequest] = useState(() => {
    const training = readTrainingRequest(location.search);
    return {
      training,
      seed: requestedRunSeed() ?? (training.requested ? training.seed : freshRunSeed()),
    };
  });
  const initialTrainingRef = useRef(initialRequest.training);
  const initialRunSeedRef = useRef(initialRequest.seed);
  const [ready, setReady] = useState(false);
  const [snapshotStore] = useState(createSnapshotStore);
  const [status, setStatus] = useState("Loading game…");
  const [runtime] = useState(() =>
    createGameClientRuntime({
      snapshots: snapshotStore,
      createGame: (seed) => new WasmGame(seed),
      createPeerSession: (apiBase) => new DemoLobbySession({ apiBase, topology: "host" }),
      attachPeerSession: attachPeerGameSession,
      createDedicatedSession: (endpoint) => new DedicatedGameSession({ endpoint }),
      supportsWebTransport: () => "WebTransport" in globalThis,
      freshRunSeed,
      onStatus: setStatus,
    }),
  );
  const client = useSyncExternalStore(runtime.subscribe, runtime.getState);
  const { mode, playerId, lobbyCode } = client;
  const scenario = client.training ? "training" : "adventure";
  const trainingPaused = client.training?.paused ?? false;
  const trainingSpeed = client.training?.speed ?? 1;
  const currentPlayer = () =>
    snapshotStore.getSnapshot()?.players.find((player) => player.id === playerId) ?? null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inWorld, setInWorld] = useState(false);
  const [savedGameAvailable, setSavedGameAvailable] = useState(() => hasPersistedSaveDocument());
  const [trainingSeedDraft, setTrainingSeedDraft] = useState(String(initialRequest.training.seed));
  const [selectedCharacterId, setSelectedCharacterId] = useState(() => loadSelectedCharacterId());
  const [profile, setProfile] = useState(() =>
    loadProfile((profile) => validateRegistry(inputRegistry, profile).valid),
  );
  const [graphics, setGraphics] = useState(loadGraphics);
  const [setupUrl, setSetupUrl] = useState(() =>
    readStoredValue(SETUP_URL_KEY, "http://127.0.0.1:8787"),
  );
  const [dedicatedUrl, setDedicatedUrl] = useState(() =>
    readStoredValue(DEDICATED_URL_KEY, "https://127.0.0.1:4433/arpg"),
  );
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(location.search).get("join") ?? "",
  );

  const selectedCharacter = useMemo(
    () => resolveCharacter(selectedCharacterId),
    [selectedCharacterId],
  );

  const resetTouchVisual = useCallback(() => {
    touchPointerIdRef.current = null;
    if (touchKnobRef.current) {
      touchKnobRef.current.style.transform = "translate3d(0px, 0px, 0)";
    }
  }, []);

  const releaseInput = useCallback(() => {
    resetTouchVisual();
    runtime.releaseInput();
  }, [resetTouchVisual, runtime]);

  const resetTouchStick = () => {
    resetTouchVisual();
    runtime.setTouchMovement(0, 0);
  };

  const updateTouchStick = (event) => {
    if (touchPointerIdRef.current !== event.pointerId) return;
    const stick = touchStickRef.current;
    if (!stick) return;
    const sample = sampleVirtualStick(event.clientX, event.clientY, stick.getBoundingClientRect());
    if (touchKnobRef.current) {
      touchKnobRef.current.style.transform = `translate3d(${sample.visualX}px, ${sample.visualY}px, 0)`;
    }
    runtime.setTouchMovement(sample.x, sample.z);
  };

  const beginTouchStick = (event) => {
    if (!playerId || !currentPlayer()?.alive || touchPointerIdRef.current !== null) return;
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
    if (!playerId || !currentPlayer()?.alive) return;
    runtime.dispatch({ type });
  };

  const leaveTrainingUrl = () => {
    history.replaceState(null, "", withTrainingRequest(location.href, false, 0));
  };

  const startTraining = (seed) => {
    resetTouchVisual();
    runtime.startLocal({ seed, training: true });
    initialRunSeedRef.current = null;
    setTrainingSeedDraft(String(seed));
    history.replaceState(null, "", withTrainingRequest(location.href, true, seed));
  };

  const enterTrainingArena = (candidateSeed = trainingSeedDraft) => {
    if (!ready) return;
    const seed = parseRunSeed(candidateSeed);
    if (seed === null) {
      setStatus("Training seed must be an unsigned 32-bit integer");
      return;
    }
    const selectedId = persistSelectedCharacterId(undefined, selectedCharacterId);
    const selected = resolveCharacter(selectedId);
    startTraining(seed);
    setInWorld(true);
    setStatus(`Training arena · ${selected.name}`);
  };

  const restartTrainingArena = (candidateSeed = trainingSeedDraft) => {
    const seed = parseRunSeed(candidateSeed);
    if (seed === null || scenario !== "training") {
      setStatus("Training seed must be an unsigned 32-bit integer");
      return;
    }
    startTraining(seed);
    setStatus(`Training arena restarted · seed ${seed}`);
  };

  const stepTrainingArena = () => {
    if (scenario !== "training") return;
    runtime.stepTraining();
  };

  const enterWorld = () => {
    if (!ready) return;
    const selectedId = persistSelectedCharacterId(undefined, selectedCharacterId);
    const selected = resolveCharacter(selectedId);
    resetTouchVisual();
    runtime.startLocal({ seed: initialRunSeedRef.current ?? freshRunSeed() });
    initialRunSeedRef.current = null;
    leaveTrainingUrl();
    setInWorld(true);
    setStatus(`Local game · ${selected.name}`);
  };

  const returnToCharacters = () => {
    runtime.stop();
    resetTouchVisual();
    setSettingsOpen(false);
    setInWorld(false);
    leaveTrainingUrl();
    setStatus("Select a character");
  };

  const startLocal = () => {
    resetTouchVisual();
    runtime.startLocal();
    leaveTrainingUrl();
    setStatus(`Local game · ${selectedCharacter.name}`);
  };

  const startDedicated = async () => {
    resetTouchVisual();
    const connecting = runtime.startDedicated(dedicatedUrl.trim());
    if (runtime.getState().mode === "dedicated") leaveTrainingUrl();
    await connecting;
  };

  const hostPeerGame = async () => {
    resetTouchVisual();
    leaveTrainingUrl();
    await runtime.hostPeer(setupUrl);
  };

  const joinPeerGame = async () => {
    resetTouchVisual();
    leaveTrainingUrl();
    await runtime.joinPeer(setupUrl, joinCode);
  };

  useEffect(() => {
    let cancelled = false;
    initWasm()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        if (initialTrainingRef.current.requested) {
          const seed = initialRunSeedRef.current ?? DEFAULT_TRAINING_SEED;
          runtime.startLocal({ seed, training: true });
          initialRunSeedRef.current = null;
          setTrainingSeedDraft(String(seed));
          setInWorld(true);
          history.replaceState(null, "", withTrainingRequest(location.href, true, seed));
          setStatus("Training arena");
        } else {
          setStatus("Select a character");
        }
      })
      .catch((error) => {
        if (!cancelled) setStatus(`Wasm failed: ${error}`);
      });
    return () => {
      cancelled = true;
      // Releases the authority, transports and tick loop. The runtime stays reusable so a
      // StrictMode remount can start again.
      runtime.stop();
    };
  }, [runtime]);

  useEffect(() => {
    if (!inWorld || !canvasRef.current) return undefined;
    const renderer = createThreeSceneRenderer(canvasRef.current, {
      background: "#11100f",
      shadows: graphics.shadows,
      pixelRatioLimit: graphics.pixelRatioLimit,
    });
    const render = () => {
      const canvas = canvasRef.current;
      const snapshot = snapshotStore.getSnapshot();
      if (!canvas || !snapshot) return;
      const rect = canvas.getBoundingClientRect();
      renderer.render(
        buildFrame(snapshot, playerId, rect.width, rect.height, selectedCharacter.accent),
      );
    };
    const resize = () => {
      const rect = canvasRef.current.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, devicePixelRatio);
      render();
    };
    const unsubscribe = snapshotStore.subscribe(render);
    const observer = new ResizeObserver(resize);
    observer.observe(canvasRef.current);
    resize();
    return () => {
      unsubscribe();
      observer.disconnect();
      renderer.dispose();
    };
  }, [
    graphics.shadows,
    graphics.pixelRatioLimit,
    inWorld,
    selectedCharacter.accent,
    playerId,
    snapshotStore,
  ]);

  useEffect(() => {
    if (settingsOpen) releaseInput();
  }, [settingsOpen, releaseInput]);

  useEffect(() => {
    // Held keys and touches do not survive focus loss: the release event may never arrive.
    const onBlur = () => releaseInput();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseInput();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [releaseInput]);

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
          runtime.dispatch({ type: combatCommand });
          return;
        }
        if (dispatch.action === "game.guard") {
          runtime.setGuard("keyboard", dispatch.phase !== "release");
          return;
        }
        const key = {
          "game.moveForward": "forward",
          "game.moveBackward": "backward",
          "game.moveLeft": "left",
          "game.moveRight": "right",
        }[dispatch.action];
        if (!key) return;
        runtime.setHeldMovement(key, dispatch.phase !== "release");
      },
    });
    const detach = attachKeyboardRuntime(controller, {
      mode: "physical",
      ignoreTextEntry: true,
      stopPropagation: true,
    });
    return detach;
  }, [ready, inWorld, profile, settingsOpen, runtime]);

  const updateProfile = (next) => {
    if (!persistStoredValue(PROFILE_KEY, JSON.stringify(next)))
      setStatus("Controls updated for this session; browser storage is unavailable");
    setProfile(next);
  };

  const updateGraphics = (next) => {
    if (!persistStoredValue(GRAPHICS_KEY, JSON.stringify(next)))
      setStatus("Graphics updated for this session; browser storage is unavailable");
    setGraphics(next);
  };

  const updateSetupUrl = (value) => {
    setSetupUrl(value);
    if (!persistStoredValue(SETUP_URL_KEY, value))
      setStatus("Endpoint updated for this session; browser storage is unavailable");
  };

  const updateDedicatedUrl = (value) => {
    setDedicatedUrl(value);
    if (!persistStoredValue(DEDICATED_URL_KEY, value))
      setStatus("Endpoint updated for this session; browser storage is unavailable");
  };

  const selectCharacter = (characterId) => {
    setSelectedCharacterId(persistSelectedCharacterId(undefined, characterId));
  };

  const captureSaveDocument = () => {
    const captured = runtime.captureSaveState();
    if (!captured) {
      throw new Error("Saving is available for local games");
    }
    return createSaveDocument(captured.saveStateJson, {
      characterId: selectedCharacter.id,
      controlledPlayerId: captured.playerId,
    });
  };

  const applySaveDocument = (document, sourceLabel, persistImported = false) => {
    const controlledPlayerId = document.client.controlledPlayerId;
    const savedPlayer = document.coreState.players?.find(
      (candidate) => candidate.id === controlledPlayerId,
    );
    if (!savedPlayer) {
      throw new Error("Save file does not contain its controlled player");
    }

    const loadedGame = loadGameFromSaveStateJson(JSON.stringify(document.coreState));
    resetTouchVisual();
    runtime.restore({
      game: loadedGame,
      controlledPlayerId,
      lastSequence: savedPlayer.lastSequence ?? 0,
      movement: [savedPlayer.movement?.[0] ?? 0, savedPlayer.movement?.[1] ?? 0],
      guardHeld: savedPlayer.guard?.held === true,
    });
    initialRunSeedRef.current = null;
    leaveTrainingUrl();
    setSelectedCharacterId(
      persistSelectedCharacterId(undefined, document.presentation.characterId),
    );
    setInWorld(true);
    setSettingsOpen(false);
    let notice = `${sourceLabel} · tick ${document.coreState.tick} · seed ${document.coreState.runSeed}`;
    if (persistImported) {
      // The imported game is already authoritative; keeping a quick-save copy is optional.
      if (persistSaveDocument(undefined, document)) setSavedGameAvailable(true);
      else notice += " · not kept as the local save because browser storage is unavailable";
    }
    setStatus(notice);
  };

  const saveGameLocally = () => {
    try {
      const document = captureSaveDocument();
      if (!persistSaveDocument(undefined, document)) {
        setStatus("Could not save game: browser storage is unavailable; export the save instead");
        return;
      }
      setSavedGameAvailable(true);
      setStatus(`Game saved locally · tick ${document.coreState.tick}`);
    } catch (error) {
      setStatus(`Could not save game: ${error}`);
    }
  };

  const loadSavedGame = () => {
    try {
      const document = loadPersistedSaveDocument();
      if (!document) {
        setSavedGameAvailable(false);
        setStatus("No local save is available");
        return;
      }
      applySaveDocument(document, "Loaded local save");
    } catch (error) {
      setStatus(`Could not load saved game: ${error}`);
    }
  };

  const exportSave = () => {
    try {
      const saveDocument = captureSaveDocument();
      const blob = new Blob([serializeSaveDocument(saveDocument)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = globalThis.document?.createElement?.("a");
      if (!link) throw new Error("Browser download API is unavailable");
      link.href = url;
      link.download = saveFileName(saveDocument);
      link.click();
      URL.revokeObjectURL(url);
      setStatus(`Save exported · tick ${saveDocument.coreState.tick}`);
    } catch (error) {
      setStatus(`Could not export save: ${error}`);
    }
  };

  const requestSaveImport = () => {
    saveFileInputRef.current?.click();
  };

  const importSave = async (event) => {
    const [file] = event.target.files ?? [];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_SAVE_FILE_BYTES) {
        throw new Error(`Save file exceeds ${MAX_SAVE_FILE_BYTES} bytes`);
      }
      const document = parseSaveDocument(await file.text());
      applySaveDocument(document, `Imported ${file.name}`, true);
    } catch (error) {
      setStatus(`Could not import save: ${error}`);
    }
  };

  const copyInvite = async () => {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("join", lobbyCode);
    try {
      await navigator.clipboard.writeText(url.toString());
      setStatus("Invite URL copied");
    } catch (error) {
      setStatus(`Could not copy invite: ${error}`);
    }
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

  if (!inWorld) {
    return (
      <main className="character-select-shell" aria-label="Character selection">
        <div className="character-select-atmosphere" aria-hidden="true" />
        <header className="character-select-header">
          <div>
            <span className="character-select-eyebrow">ARPG</span>
            <h1 className="visually-hidden">Character selection</h1>
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
            {ready && status === "Select a character" ? "Ready" : status}
          </span>
          <div className="character-select-save-actions">
            <button type="button" onClick={loadSavedGame} disabled={!ready || !savedGameAvailable}>
              Load Saved Game
            </button>
            <button type="button" onClick={requestSaveImport} disabled={!ready}>
              Import Save
            </button>
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
          </div>
          <input
            ref={saveFileInputRef}
            className="save-file-input"
            type="file"
            accept=".json,application/json"
            aria-label="Save file"
            onChange={importSave}
          />
        </footer>
      </main>
    );
  }

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" aria-label="ARPG game world" />
      <header className="game-header">
        <div>
          <strong>ARPG</strong>
          <span>{modeLabel}</span>
        </div>
        <div className="game-header-actions">
          <button type="button" onClick={returnToCharacters}>
            Characters
          </button>
          <button ref={settingsTriggerRef} type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {scenario === "training" && (
        <aside className="training-panel" aria-label="Training arena controls">
          <header>
            <strong>Training arena</strong>
            <TrainingTick store={snapshotStore} />
          </header>

          <div className="training-actions">
            <button type="button" onClick={() => runtime.setTrainingPaused(!trainingPaused)}>
              {trainingPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={stepTrainingArena} disabled={!trainingPaused}>
              Step
            </button>
            <label>
              <span>Speed</span>
              <select
                value={trainingSpeed}
                onChange={(event) => runtime.setTrainingSpeed(Number(event.target.value))}
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

          <TrainingDiagnostics store={snapshotStore} playerId={playerId} />
        </aside>
      )}

      <PlayerHud store={snapshotStore} playerId={playerId} status={status} />

      {ready && !settingsOpen && (
        <section className="mobile-controls" aria-label="Touch controls">
          <div
            ref={touchStickRef}
            className="virtual-stick"
            role="group"
            aria-label="Movement joystick"
            aria-disabled={!playerId}
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
        <CombatActions
          store={snapshotStore}
          playerId={playerId}
          triggerCombatAction={triggerCombatAction}
          setTouchGuard={(held) => runtime.setGuard("touch", held)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocusTo={settingsTriggerRef}>
          <header>
            <div>
              <h1 id="settings-heading">Settings</h1>
            </div>
            <button type="button" autoFocus onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </header>

          <section>
            <h2>Game</h2>
            <GameSummary store={snapshotStore} mode={mode} playerId={playerId} />
            <button type="button" onClick={startLocal}>
              Start local game
            </button>
          </section>

          <section>
            <h2>Save & load</h2>
            <div className="save-state-summary">
              <strong>{savedGameAvailable ? "Local save available" : "No local save yet"}</strong>
              <span>
                {mode === "local"
                  ? "Current local authority can be saved or exported."
                  : "Loading a save returns to local play; network sessions are not overwritten."}
              </span>
            </div>
            <div className="settings-actions save-state-actions">
              <button
                type="button"
                onClick={saveGameLocally}
                disabled={mode !== "local" || !playerId}
              >
                Save game
              </button>
              <button
                type="button"
                onClick={loadSavedGame}
                disabled={!ready || !savedGameAvailable}
              >
                Load saved game
              </button>
              <button type="button" onClick={exportSave} disabled={mode !== "local" || !playerId}>
                Export save
              </button>
              <button type="button" onClick={requestSaveImport} disabled={!ready}>
                Import save
              </button>
            </div>
            <input
              ref={saveFileInputRef}
              className="save-file-input"
              type="file"
              accept=".json,application/json"
              aria-label="Save file"
              onChange={importSave}
            />
            <p className="settings-note">
              Saves are versioned and validated by the Rust authority before they replace the
              current game. Exported JSON can be imported on another browser or device.
            </p>
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
          </section>

          <section>
            <h2>Peer co-op</h2>
            <label>
              Setup service URL
              <input value={setupUrl} onChange={(event) => updateSetupUrl(event.target.value)} />
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
          </section>

          <section>
            <h2>Graphics</h2>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={graphics.shadows}
                onChange={(event) => updateGraphics({ ...graphics, shadows: event.target.checked })}
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
        </SettingsDialog>
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
