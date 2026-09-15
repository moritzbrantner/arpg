import React, { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { createThreeSceneRenderer } from "@moritzbrantner/three-d-renderer";
import { InputRuntimeController } from "@moritzbrantner/input-bindings-runtime";
import { attachKeyboardRuntime } from "@moritzbrantner/input-bindings-web";
import { KeybindingEditor } from "@moritzbrantner/input-bindings-react";
import "@moritzbrantner/input-bindings-react/styles.css";
import initWasm, { WasmGame } from "./wasm/arpg_web_wasm.js";
import { ResilientLobbySession } from "./vendor/multiplayer-setup-service/resilient-lobby-session.js";
import "./styles.css";

const PROFILE_KEY = "arpg-input-profile-v1";
const SETUP_URL_KEY = "arpg-setup-service-url-v1";
const GRAPHICS_KEY = "arpg-graphics-v1";
const PROTOCOL_VERSION = 1;
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

function buildFrame(snapshot, focusPlayerId, width, height) {
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

  const nodes = [
    {
      id: "floor",
      geometry: { kind: "box", size: [18, 0.12, 13] },
      color: "#292722",
      transform: { translation: [0, -0.08, 0] },
    },
    ...snapshot.staticColliders.map((collider) => ({
      id: `static-${collider.id}`,
      geometry: {
        kind: "box",
        size: collider.halfExtents.map((value) => (value * 2) / scale),
      },
      color: collider.kind === "pillar" ? "#5d5142" : "#403a33",
      transform: { translation: collider.position.map((value) => value / scale) },
    })),
    ...snapshot.players.map((player) => ({
      id: `player-${player.id}`,
      geometry: { kind: "cylinder", radius: 0.3, height: 1 },
      color: player.id === focusPlayerId ? "#d6b45f" : "#6f91b6",
      transform: { translation: player.position.map((value) => value / scale) },
    })),
    ...snapshot.monsters
      .filter((monster) => monster.alive)
      .map((monster) => ({
        id: `monster-${monster.id}`,
        geometry: { kind: "sphere", radius: 0.42 },
        color: "#8f4037",
        transform: { translation: monster.position.map((value) => value / scale) },
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
  const peerPlayersRef = useRef(new Map());
  const sequenceRef = useRef(0);
  const movementRef = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    lastX: 0,
    lastZ: 0,
  });
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("local");
  const [snapshot, setSnapshot] = useState(null);
  const [playerId, setPlayerId] = useState(1);
  const [status, setStatus] = useState("Loading Rust simulation…");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profile, setProfile] = useState(loadProfile);
  const [graphics, setGraphics] = useState(loadGraphics);
  const [setupUrl, setSetupUrl] = useState(
    () => localStorage.getItem(SETUP_URL_KEY) ?? "http://127.0.0.1:8787",
  );
  const [lobbyCode, setLobbyCode] = useState("");
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(location.search).get("join") ?? "",
  );

  const health = useMemo(
    () => snapshot?.players.find((player) => player.id === playerId)?.health ?? 0,
    [snapshot, playerId],
  );

  const setModeValue = (next) => {
    modeRef.current = next;
    setMode(next);
  };

  const resetMovement = () => {
    movementRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
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

  const createAuthority = () => {
    gameRef.current?.free?.();
    const game = new WasmGame();
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
      } else {
        gameRef.current?.applyCommand(playerId, sequence, encoded);
      }
    } catch (error) {
      setStatus(String(error));
    }
  };

  const flushMovement = () => {
    const movement = movementRef.current;
    const x = Number(movement.right) - Number(movement.left);
    const z = Number(movement.backward) - Number(movement.forward);
    if (x === movement.lastX && z === movement.lastZ) return;
    movement.lastX = x;
    movement.lastZ = z;
    dispatchCommand({ type: "setMovement", x, z });
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

  const startLocal = () => {
    closeSession();
    createAuthority();
    setModeValue("local");
    setStatus("Local Rust/Wasm authority");
  };

  const hostPeerGame = async () => {
    try {
      closeSession();
      createAuthority();
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
      setPlayerId(null);
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
        createAuthority();
        setReady(true);
        setStatus("Local Rust/Wasm authority");
      })
      .catch((error) => setStatus(`Wasm failed: ${error}`));
    return () => {
      cancelled = true;
      closeSession();
      gameRef.current?.free?.();
    };
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const timer = setInterval(() => {
      if (modeRef.current === "guest" || !gameRef.current) return;
      try {
        gameRef.current.advanceTick();
        updateSnapshotFromGame();
      } catch (error) {
        setStatus(`Simulation stopped: ${error}`);
      }
    }, 1000 / 60);
    return () => clearInterval(timer);
  }, [ready]);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
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
        renderer.render(buildFrame(snapshot, playerId, rect.width, rect.height));
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
  }, [graphics.shadows, graphics.pixelRatioLimit]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !snapshot) return;
    const rect = canvas.getBoundingClientRect();
    renderer.render(buildFrame(snapshot, playerId, rect.width, rect.height));
  }, [snapshot, playerId]);

  useEffect(() => {
    if (!ready) return undefined;
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
        if (dispatch.action === "game.primaryAttack" && dispatch.phase === "press") {
          dispatchCommand({ type: "primaryAttack" });
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
  }, [ready, profile, settingsOpen, mode, playerId]);

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

  const copyInvite = async () => {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("join", lobbyCode);
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite URL copied with public lobby code only");
  };

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" aria-label="ARPG game world" />
      <header className="game-header">
        <div>
          <strong>ARPG foundation MVP</strong>
          <span>
            {mode === "local" ? "Local" : mode === "host" ? "Peer host" : "Peer guest"}
          </span>
        </div>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>

      <section className="hud" aria-label="Player status">
        <div className="health">
          <span style={{ width: `${health}%` }} />
        </div>
        <p>{status}</p>
        <p>WASD to move · Space to attack · Esc for settings</p>
      </section>

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
              </p>
              <button type="button" onClick={startLocal}>
                Start local game
              </button>
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
