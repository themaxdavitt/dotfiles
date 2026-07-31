/**
 * Gatekeeper's own configuration, read from the agent dir ONLY.
 *
 * A `<cwd>/.pi/gatekeeper.json` was read here until 2026-07-27, which put
 * Gatekeeper's own policy inside the workdir the sandbox profile grants the
 * agent write access to: writing `{"mode":"danger"}` there bought
 * the next session unrestricted tool use, and an `auditor` pointed at a model
 * of the agent's choosing rubber-stamped `auto` mode. Project-local permission
 * policy needs a trust story it does not have, so there is none.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditorModelRef } from "./auditor";
import { type BinTrustConfig, DEFAULT_BIN_TRUST, isBinTrustConfig } from "./hazmat/bin-trust";
import { type GatekeeperConfig, isAskMode, isPermissionMode } from "./policy";

export const DEFAULT_AUDITOR: AuditorModelRef = {
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
};

export const DEFAULT_CONFIG: GatekeeperConfig = {
  mode: "manual",
  askMode: "headful",
  // Registered by the claude-tools extension; exempt so the agent can ask a
  // clarifying question before it is able to commit to a turn plan.
  planExemptTools: ["AskUserQuestion"],
};

export interface GatekeeperFileConfig extends Partial<GatekeeperConfig> {
  auditor?: Partial<AuditorModelRef>;
  binTrust?: unknown;
}

export interface LoadedConfig {
  config: GatekeeperConfig;
  auditor: AuditorModelRef;
  binTrust: BinTrustConfig;
}

export function gatekeeperConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "gatekeeper.json");
}

function readConfigFile(path: string): GatekeeperFileConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GatekeeperFileConfig;
  } catch (e) {
    console.error(`Gatekeeper: could not parse ${path}: ${e}`);
    return undefined;
  }
}

/**
 * Every field is validated and falls back to its default rather than throwing:
 * a malformed config must never leave the session with no policy at all.
 *
 * @param path Full path to the config file. Callers pass
 *   `gatekeeperConfigPath(getAgentDir())`; the parameter exists so this stays
 *   testable without a live Pi.
 */
export function loadFileConfig(path: string): LoadedConfig {
  const config: GatekeeperConfig = { ...DEFAULT_CONFIG };
  let auditor = DEFAULT_AUDITOR;
  let binTrust = DEFAULT_BIN_TRUST;

  const data = readConfigFile(path);
  if (data) {
    if (isPermissionMode(data.mode)) config.mode = data.mode;
    if (isAskMode(data.askMode)) config.askMode = data.askMode;
    if (
      Array.isArray(data.planExemptTools) &&
      data.planExemptTools.every((tool) => typeof tool === "string")
    ) {
      config.planExemptTools = data.planExemptTools;
    }
    if (data.auditor?.provider && data.auditor.modelId) {
      auditor = { provider: data.auditor.provider, modelId: data.auditor.modelId };
    }
    if (data.binTrust !== undefined) {
      if (isBinTrustConfig(data.binTrust)) {
        binTrust = {
          roots: data.binTrust.roots ?? DEFAULT_BIN_TRUST.roots,
          miseTools: data.binTrust.miseTools ?? DEFAULT_BIN_TRUST.miseTools,
        };
      } else {
        console.error(
          `Gatekeeper: ignoring malformed binTrust in ${path} — expected { roots?: string[], miseTools?: string[] }`,
        );
      }
    }
  }

  return { config, auditor, binTrust };
}
