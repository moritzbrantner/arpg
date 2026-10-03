// Session-owned authoritative snapshots. Only tick-dependent views subscribe;
// the shell and renderer configuration stay outside that React update domain.
export function createSnapshotStore() {
  let snapshot = null;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next) {
      if (Object.is(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
