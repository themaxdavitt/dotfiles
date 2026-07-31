/**
 * Launch a read-only planning Pi under nono, review the submitted plan with
 * Plannotator, then print (or run) the implementing Pi command for the approved
 * plan. `bin/session-plan.js` is a thin wrapper around `main()` here.
 *
 * Plain ESM under bare node: this runs from the DEPLOYED target, which has no
 * node_modules and therefore no tsx. Everything it knows about the plan store
 * comes from ./store.js — the same module the extension imports, so the tested
 * code and the running code are the same code.
 *
 * The argv builders are exported and pure so the tests can assert the launch
 * contract (nono flags, tool allowlists, env) without spawning anything.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultAgentDir,
  findApprovedSessionPlanByRunId,
  getPlannotatorDataDir,
  makePlanId,
} from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function usage() {
  console.log(`Usage: session-plan [options] [--] [pi args...]

Launch a read-only planning Pi under nono, review the submitted plan with
Plannotator, then print the implementing Pi command for the approved plan.

Options:
  --profile <name>     nono profile name (default: SESSION_PLANNER_PROFILE or pi-session-planner)
  --pi <path>          Pi binary (default: SESSION_PLANNER_PI_BIN or pi)
  --nono <path>        nono binary (default: SESSION_PLANNER_NONO_BIN or nono)
  --extension <path>   Session-planner extension entry (default: this package's index.ts)
  --cwd <path>         Working directory for both Pi invocations (default: current directory)
  --exec               Run the implementing Pi after approval instead of only printing it
  -h, --help           Show this help
`);
}

/** Quote only when needed, so the printed command stays copy-pasteable.
 *  @param {string} value @returns {string} */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * @param {string[]} argv
 * @returns {{ options: Record<string, any>, passthrough: string[], help: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    profile: process.env.SESSION_PLANNER_PROFILE || "pi-session-planner",
    pi: process.env.SESSION_PLANNER_PI_BIN || "pi",
    nono: process.env.SESSION_PLANNER_NONO_BIN || "nono",
    extension: resolve(HERE, "..", "index.ts"),
    cwd: process.cwd(),
    exec: false,
  };
  /** @type {string[]} */
  const passthrough = [];

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") return { options, passthrough, help: true };
    if (arg === "--exec") {
      options.exec = true;
      continue;
    }
    if (arg === "--profile" || arg === "--pi" || arg === "--nono") {
      options[arg.slice(2)] = takeValue(i, arg);
      i++;
      continue;
    }
    if (arg === "--extension" || arg === "--cwd") {
      options[arg.slice(2)] = resolve(takeValue(i, arg));
      i++;
      continue;
    }
    passthrough.push(arg);
  }
  return { options, passthrough, help: false };
}

/**
 * Tail Plannotator's ready-file side channel so the review URL reaches the
 * terminal even though the planning Pi owns the tty.
 * @param {string} file @returns {() => void} stop
 */
export function startReadyFileWatcher(file) {
  let offset = 0;
  let buffer = "";
  let stopped = false;
  const seen = new Set();
  const tick = () => {
    if (stopped || !existsSync(file)) return;
    const text = readFileSync(file, "utf-8");
    buffer += text.slice(offset);
    offset = text.length;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const metadata = JSON.parse(trimmed);
        if (metadata.url && !seen.has(metadata.url)) {
          seen.add(metadata.url);
          console.error("");
          console.error("Plannotator session ready:");
          console.error(`  ${metadata.url}`);
          console.error("");
        }
      } catch {
        // Ignore malformed side-channel data; Plannotator also prints to stderr.
      }
    }
  };
  const timer = setInterval(tick, 500);
  return () => {
    stopped = true;
    clearInterval(timer);
    tick();
  };
}

/**
 * @param {Record<string, any>} options
 * @param {string[]} passthrough
 * @param {string} runId
 * @param {string} plannotatorDataDir
 * @returns {string[]} argv for `nono`
 */
export function buildPlannerArgs(options, passthrough, runId, plannotatorDataDir) {
  const childPath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":");
  const plannerCommand = [
    "/usr/bin/env",
    `PATH=${childPath}`,
    `SESSION_PLANNER_RUN_ID=${runId}`,
    "SESSION_PLANNER_PLANNOTATOR_VERBOSE=1",
    `PLANNOTATOR_DATA_DIR=${plannotatorDataDir}`,
    ...(process.platform === "darwin"
      ? [`PLANNOTATOR_BROWSER=${process.env.PLANNOTATOR_BROWSER || "/usr/bin/open"}`]
      : []),
    "PLANNOTATOR_ORIGIN=pi",
    `PLANNOTATOR_READY_FILE=${join(plannotatorDataDir, "ready.jsonl")}`,
    options.pi,
    "-e",
    options.extension,
    "--session-planner",
    // Gatekeeper's own flags — that extension is loaded too, and the planning
    // Pi must not stop for approval dialogs it has no human watching.
    "--gatekeeper-mode",
    "auto",
    "--gatekeeper-ask",
    "never",
    "--tools",
    "read,bash,set_turn_plan,submit_session_plan",
    "--exclude-tools",
    "ls,find,grep,edit,write",
    ...passthrough,
  ];
  return [
    "run",
    "--profile",
    options.profile,
    ...(process.platform === "darwin" ? ["--allow-launch-services"] : []),
    "--workdir",
    options.cwd,
    "--read",
    options.cwd,
    "--",
    ...plannerCommand,
  ];
}

/** @param {Record<string, any>} options @param {string} planId @returns {string[]} */
export function buildExecutionArgs(options, planId) {
  return [
    "-e",
    options.extension,
    "--approved-session-plan",
    planId,
    "--tools",
    "read,bash,edit,write,set_turn_plan",
    "--exclude-tools",
    "ls,find,grep",
  ];
}

export async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (parsed.help) {
    usage();
    return;
  }
  const { options, passthrough } = parsed;

  const agentDir = defaultAgentDir();
  const runId = makePlanId();
  const plannotatorDataDir = getPlannotatorDataDir(agentDir, runId);
  mkdirSync(plannotatorDataDir, { recursive: true });

  console.error(`Session planner run: ${runId}`);
  console.error(`Plannotator data dir: ${plannotatorDataDir}`);
  console.error("");

  const stopWatching = startReadyFileWatcher(join(plannotatorDataDir, "ready.jsonl"));
  const planning = spawn(
    options.nono,
    buildPlannerArgs(options, passthrough, runId, plannotatorDataDir),
    { cwd: options.cwd, stdio: "inherit", env: process.env },
  );
  const status = await new Promise((resolveStatus) => {
    planning.on("error", (err) => {
      console.error(`Failed to launch nono: ${err.message}`);
      resolveStatus(1);
    });
    planning.on("close", (code) => resolveStatus(code ?? 1));
  });
  stopWatching();

  if (status !== 0) process.exit(status);

  const record = findApprovedSessionPlanByRunId(agentDir, runId);
  if (!record?.id) {
    console.error(`No approved session plan found for planner run ${runId}`);
    process.exit(1);
  }

  const executionArgs = buildExecutionArgs(options, record.id);
  console.log("");
  console.log("Approved session plan:");
  console.log(`  ${record.planPath || record.id}`);
  console.log("Plannotator data:");
  console.log(`  ${plannotatorDataDir}`);
  console.log("");
  console.log("Implementing Pi command:");
  console.log(`  ${[options.pi, ...executionArgs].map(shellQuote).join(" ")}`);

  if (options.exec) {
    const execution = spawnSync(options.pi, executionArgs, {
      cwd: options.cwd,
      stdio: "inherit",
      env: process.env,
    });
    if (execution.error) {
      console.error(`Failed to launch Pi: ${execution.error.message}`);
      process.exit(1);
    }
    process.exit(execution.status ?? 0);
  }
}
