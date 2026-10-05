// Snapshots can outpace the display, so several may be coalesced into one drawn frame.
// One-tick action phases (the impact of an attack) would then never be drawn. These helpers
// remember every entity whose action was active since the last draw and show that impact in
// the next drawn frame. Presentation only: the authoritative snapshot is never modified.

export function createActiveCueTracker() {
  let players = new Map();
  let monsters = new Map();
  return {
    observe(snapshot) {
      if (!snapshot) return;
      for (const player of snapshot.players)
        if (player.action?.phase === "active") players.set(player.id, player.action);
      for (const monster of snapshot.monsters)
        if (monster.action?.phase === "active") monsters.set(monster.id, monster.action);
    },
    // Returns a presentation copy in which entities that were active since the last draw
    // still show their active phase, then forgets them.
    take(snapshot) {
      if (!snapshot || (players.size === 0 && monsters.size === 0)) {
        players = new Map();
        monsters = new Map();
        return snapshot;
      }
      const withCue = (entity, cues) => {
        const action = cues.get(entity.id);
        return action && entity.action?.phase !== "active" ? { ...entity, action } : entity;
      };
      const frame = {
        ...snapshot,
        players: snapshot.players.map((player) => withCue(player, players)),
        monsters: snapshot.monsters.map((monster) => withCue(monster, monsters)),
      };
      players = new Map();
      monsters = new Map();
      return frame;
    },
  };
}
