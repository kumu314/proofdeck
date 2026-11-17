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

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_PKG = join(PKG_ROOT, "board");
const EXAMPLE = join(PKG_ROOT, "config.example.json");

const say = (m = "") => console.log(m);
const ok = (m) => console.log("✅ " + m);
const warn = (m) => console.log("⚠️  " + m);

function usage() {
  say(`ProofDeck — verification-first task board & orchestrator for coding-agent fleets

Usage:
  proofdeck init [dir]        Scaffold a project dir (default: current)
  proofdeck daemon            Run the daemon for the current project dir
  proofdeck status            Show board head / task / verify counts
  proofdeck --version         Print version

Docs: https://github.com/kumu314/proofdeck`);
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
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

  mkdirSync(join(dir, ".proofdeck"), { recursive: true });
  mkdirSync(join(dir, "workdirs"), { recursive: true });
  const tokenPath = join(dir, "control.token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("hex") + "\n");

  ok(`scaffolded ${dir}`);
  say(`   daemon.config.json   ← edit agents.* to point at your CLI(s)`);
  say(`   .proofdeck/          ← board lives here (one SQLite file + audit chain)`);
  say(`   control.token        ← local control-plane credential`);
  say("");
  say("Next:");
  say("   1) edit daemon.config.json — set agents.codex.script to your agent CLI");
  say("   2) proofdeck daemon      (or: node daemon.js daemon.config.json)");
  say("   3) define a task with acceptance criteria, then watch the gate work");
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
} else if (cmd === "init") process.exit(cmdInit(rest));
else if (cmd === "daemon") process.exit(await cmdDaemon());
else if (cmd === "status") process.exit(await cmdStatus());
else { warn(`unknown command: ${cmd}`); usage(); process.exit(1); }
