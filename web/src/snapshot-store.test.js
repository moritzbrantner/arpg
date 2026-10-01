import { expect, test } from "bun:test";
import { createSnapshotStore } from "./snapshot-store.js";

test("consumers share the latest snapshot and stop receiving it after teardown", () => {
  const store = createSnapshotStore();
  const observed = [];
  const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
  const snapshot = { tick: 1, players: [] };
  store.publish(snapshot);
  store.publish(snapshot);
  expect(observed).toEqual([snapshot]);
  expect(store.getSnapshot()).toBe(snapshot);
  unsubscribe();
  store.publish(null);
  expect(observed).toEqual([snapshot]);
  expect(store.getSnapshot()).toBe(null);
});

test("separate sessions cannot overwrite each other's snapshots", () => {
  const first = createSnapshotStore();
  const second = createSnapshotStore();
  first.publish({ tick: 2 });
  expect(second.getSnapshot()).toBeNull();
});
