#!/usr/bin/env node
// ProofDeck CLI — v0.1: init / daemon / status.
//
// init    scaffold a project dir (daemon.config.json, .proofdeck board dir,
//         control.token, workdirs/) and print the next steps
// daemon  run the orchestration daemon against the current project dir
//         (PROOFDECK_BASE=cwd; config from ./daemon.config.json)
// status  one-shot board snapshot (head, task counts, verify counts)
//
// The package is self-contained: the vendored board lives next to this file
// (../board), so no extra downloads are needed after `npm i proofdeck`.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_PKG = join(PKG_ROOT, "board");
const EXAMPLE = join(PKG_ROOT, "config.example.json");

const say = (m = "") => console.log(m);
const ok = (m) => console.log("✅ " + m);
const warn = (m) => console.log("⚠️  " + m);

function usage() {
  say(`ProofDeck — verification-first task board & orchestrator for coding-agent fleets

Usage:
  proofdeck init [dir]             Scaffold a project dir (default: current)
  proofdeck daemon                 Run the daemon for the current project dir
  proofdeck status                 Show board head / task / verify counts
  proofdeck assign <key> <agent>   Queue a task card to an agent face
  proofdeck --version              Print version

Docs: https://github.com/kumu314/proofdeck`);
}

function findFreePort(start = 8790, tries = 20) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => (tries-- > 0 ? res(findFreePort(start + 1, tries)) : res(start)));
    srv.once("listening", () => srv.close(() => res(start)));
    srv.listen(start, "127.0.0.1");
  });
}

function cmdInit(args) {
  const dir = resolve(args[0] ?? ".");
  const cfgPath = join(dir, "daemon.config.json");
  if (existsSync(cfgPath) && !args.includes("--force")) {
    warn(`${cfgPath} already exists — refusing to overwrite (pass --force to replace)`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });

  const cfg = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  // Point the vendored board at the packaged copy so init works from anywhere.
  cfg.board.package = BOARD_PKG.replace(/\\/g, "/");
  cfg.board.dir = "./.proofdeck";

  // Per-face workdirs up front: agents spawn with -C <workdir>; a missing dir
  // kills the face with os error 3 before it can say anything (dogfood finding).
  const faces = Object.entries(cfg.agents ?? {});
  for (const [name, face] of faces) {
    if (face.workdir) face.workdir = join(dir, "workdirs", name).replace(/\\/g, "/");
  }

  // Free control-plane port: a fixed 8790 collides with any other ProofDeck on
  // the machine (dogfood finding).
  const port = findFreePort(cfg.http?.port ?? 8790);
  return Promise.resolve(port).then((free) => {
    if (cfg.http) cfg.http.port = free;
    cfg.runtime ??= {};
    cfg.runtime.autoAssign = true; // open+auto-flagged tasks queue to their face automatically

    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    mkdirSync(join(dir, ".proofdeck"), { recursive: true });
    mkdirSync(join(dir, "briefs"), { recursive: true });
    for (const [name] of faces) mkdirSync(join(dir, "workdirs", name), { recursive: true });
    const tokenPath = join(dir, "control.token");
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("hex") + "\n");

    // starter task book: the pointer-style brief with a ```bridge fence
    const brief = join(dir, "briefs", "my-first-task.md");
    if (!existsSync(brief)) {
      writeFileSync(brief, [
        "Write hello.md in the workspace containing the single line: it works.",
        "",
        "```bridge",
        '{ "auto": "yes", "risk": "low", "impact": "low" }',
        "```",
        "",
      ].join("\n"));
    }

    ok(`scaffolded ${dir}  (control port: ${free})`);
    say(`   daemon.config.json   ← edit agents.* to point at your CLI(s)`);
    say(`   briefs/my-first-task.md ← starter task book (pointer-style)`);
    say(`   .proofdeck/          ← board lives here (one SQLite file + audit chain)`);
    say(`   control.token        ← local control-plane credential`);
    say("");
    say("Next:");
    say("   1) edit daemon.config.json — set agents.codex.script to your agent CLI");
    say("   2) define the task card (see briefs/my-first-task.md + docs/task-book.md):");
    say(`        description: "任务书：${join(dir, "briefs", "my-first-task.md").replace(/\\\\/g, "/")}"`);
    say("   3) proofdeck daemon      (or: node daemon.js daemon.config.json)");
    say("   4) proofdeck assign my-first-task codex   — or let autoAssign queue it");
    say("   5) proofdeck status      — watch the verify gate work");
    return 0;
  });
}


async function cmdAssign(args) {
  const [key, agent] = args;
  if (!key || !agent) { warn("usage: proofdeck assign <key> <agent>"); return 1; }
  const cfgPath = join(process.cwd(), "daemon.config.json");
  if (!existsSync(cfgPath)) { warn(`no daemon.config.json in ${process.cwd()}`); return 1; }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const boardDir = resolve(process.cwd(), cfg.board.dir ?? ".proofdeck");
  const pkg = cfg.board.package ?? BOARD_PKG;
  const { Board } = await import(new URL("file://" + join(resolve(pkg), "dist", "board.js").replace(/\\/g, "/")).href);
  const b = Board.open({ boardDir, agent: cfg.board.identity ?? "bridge" });
  try {
    b.assign(cfg.board.identity ?? "bridge", key, agent);
    ok(`queued ${key} → ${agent}`);
  } finally { try { b.close(); } catch { } }
  return 0;
}

async function cmdDaemon() {
  const cfgPath = join(process.cwd(), "daemon.config.json");
  if (!existsSync(cfgPath)) {
    warn(`no daemon.config.json in ${process.cwd()} — run: proofdeck init`);
    return 1;
  }
  const child = spawn(process.execPath, [join(PKG_ROOT, "daemon.js"), cfgPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, PROOFDECK_BASE: process.cwd() },
  });
  // Long-running: hold the CLI until the daemon exits, then propagate its code.
  return await new Promise((r) => child.on("exit", (code) => r(code ?? 0)));
}

async function cmdStatus() {
  const cfgPath = join(process.cwd(), "daemon.config.json");
  if (!existsSync(cfgPath)) {
    warn(`no daemon.config.json in ${process.cwd()} — run: proofdeck init`);
    return 1;
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const boardDir = resolve(process.cwd(), cfg.board.dir ?? ".proofdeck");
  const pkg = cfg.board.package ?? BOARD_PKG;
  const { Board } = await import(new URL("file://" + join(resolve(pkg), "dist", "board.js").replace(/\\/g, "/")).href);
  const b = Board.open({ boardDir, agent: cfg.board.identity ?? "bridge" });
  try {
    const head = b.head();
    const cards = b.listTaskCards();
    const byStatus = {};
    let verified = 0, withAcc = 0;
    for (const c of cards) {
      const t = c.task || {};
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.acceptance != null) withAcc++;
    }
    const chain = b.verifyChain ? b.verifyChain() : null;
    const events = b.timeline(2000);
    verified = events.filter((e) => e.kind === "verify").length;
    say(`board   ${boardDir}`);
    say(`head    seq ${head.seq}   chain ${chain?.ok ? "OK (anchored)" : "?"}${chain?.brokenAtSeq != null ? ` BROKEN @ ${chain.brokenAtSeq}` : ""}`);
    say(`tasks   ${cards.length} total — ${Object.entries(byStatus).map(([k, v]) => k + " " + v).join(" / ")}`);
    say(`accept  ${withAcc} task(s) carry acceptance   verify events: ${verified}`);
  } finally { try { b.close(); } catch { } }
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") { usage(); process.exit(0); }
else if (cmd === "--version" || cmd === "-v") {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
} else if (cmd === "init") process.exit(await cmdInit(rest));
else if (cmd === "assign") process.exit(await cmdAssign(rest));
else if (cmd === "daemon") process.exit(await cmdDaemon());
else if (cmd === "status") process.exit(await cmdStatus());
else { warn(`unknown command: ${cmd}`); usage(); process.exit(1); }
