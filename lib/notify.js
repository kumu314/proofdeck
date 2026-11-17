// Doorbell watcher: OS file event on <boardDir>/notify.json (zero polling),
// with debounce, a mtime fallback and a slow reconcile timer that exists only
// as a crash backstop — the notification path is the fs.watch event.
import { watch, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function createNotifier(boardDir, { debounceMs = 50, reconcileMs = 60000 }, onWake) {
  const bellPath = join(boardDir, "notify.json");
  let lastSeqSeen = -1;
  let timer = null;
  let watcher = null;
  let stopped = false;

  const fire = (why) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) onWake(why);
    }, debounceMs);
  };

  const start = () => {
    try {
      watcher = watch(boardDir, { recursive: false }, (_evt, filename) => {
        if (filename && filename !== "notify.json") return;
        fire("doorbell");
      });
      watcher.on("error", (e) => {
        console.error("notify: watcher error, relying on reconcile:", e.message);
      });
    } catch (e) {
      console.error("notify: fs.watch failed, relying on reconcile:", e.message);
    }
    // catch a bell that rang before we started watching
    if (existsSync(bellPath)) {
      try {
        const hint = JSON.parse(readFileSync(bellPath, "utf8"));
        if (typeof hint.head === "number" && hint.head !== lastSeqSeen) fire("bell-at-boot");
      } catch { fire("bell-at-boot"); }
    }
  };

  // periodic reconcile — backstop for missed OS events / daemon restart, NOT the notify path
  const interval = setInterval(() => fire("reconcile"), reconcileMs);
  start();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timer);
      if (watcher) try { watcher.close(); } catch { /* noop */ }
    },
    noteSeq(seq) { lastSeqSeen = seq; },
  };
}
