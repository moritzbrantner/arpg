import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createSnapshotStore } from "../../src/snapshot-store.js";
import { TrainingTick } from "../../src/snapshot-views.jsx";

export function verifySnapshotUpdateDomain(container) {
  const store = createSnapshotStore();
  let shellRenders = 0;
  function Shell() {
    // oxlint-disable-next-line react/globals -- Test-only counter measures shell render attempts under flushSync.
    shellRenders += 1;
    return <TrainingTick store={store} />;
  }
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Shell />));
    for (let tick = 1; tick <= 120; tick += 1) {
      flushSync(() => store.publish({ tick }));
    }
    return { shellRenders, text: container.textContent };
  } finally {
    root.unmount();
  }
}
