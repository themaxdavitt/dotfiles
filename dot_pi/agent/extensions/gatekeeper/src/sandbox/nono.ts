import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { toolsProfile } from "./wrap";

const execFileAsync = promisify(execFile);

const DENIAL_PATTERNS = [
  /operation not permitted/i,
  /permission denied/i,
  /\bEACCES\b/i,
  /\bEPERM\b/i,
  /landlock/i,
  /sandbox(?:ed)?:?\s+deny/i,
  /sandbox denied/i,
];

// Remediation framing borrowed from always-further/nono-packs
// (pi/extensions/nono-sandbox.ts): sandboxed tool calls stay immutable; policy
// changes happen in the profile, via promoted drafts.
// `nono why --self` is suggested because the model runs it through the bash
// tool, i.e. *inside* the per-call sandbox, where --self sees the live caps.
const NONO_DENIAL_GUIDANCE = `

[nono sandbox diagnostic]
This looks like a nono sandbox denial from the per-call bash sandbox, not a Unix permission problem.

Next step (runs inside the same sandbox, so --self reflects it):
  nono why --self --path <blocked-path> --op <read|write|readwrite>

Offer the user exactly two remediation options:
  Option A: for a single command, request it through the elevated_bash tool
    (runs outside the sandbox; the user approves each command).

  Option B: for a persistent need, draft a profile change under
    ~/.config/nono/profile-drafts/<name>.json and ask the user to run:
    nono profile validate --draft <name>
    nono profile promote <name>

Do not suggest sudo, chmod, chown, Full Disk Access, or Pi approval changes for this denial.
`.trim();

// Injected into the system prompt so the model treats tool-call boundaries as
// OS-enforced facts rather than problems to hack around.
export const NONO_SYSTEM_CONTEXT =
  "Every unprivileged bash command this session runs is wrapped in its own nono " +
  "sandbox, and file tools (read/edit/write) are checked against the same profile " +
  "before they run. Those limits are enforced by the operating system, not by Pi. " +
  "On 'operation not permitted'-style failures, diagnose with `nono why --self` " +
  "instead of reaching for sudo/chmod/chown — those cannot override kernel " +
  "enforcement.";

export interface NonoQueryResult {
  status: string;
  reason?: string;
  details?: string;
}

/**
 * Ask nono whether the tools profile allows `op` on `path`, mirroring the
 * runtime workdir grant with an explicit --allow for the session cwd.
 */
export async function queryToolsProfile(
  path: string,
  op: "read" | "write" | "readwrite",
  cwd: string,
): Promise<NonoQueryResult | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "nono",
      [
        "why",
        "--json",
        "--silent",
        "--profile",
        toolsProfile(),
        "--allow",
        cwd,
        "--path",
        path,
        "--op",
        op,
      ],
      { timeout: 2000 },
    );
    const parsed = JSON.parse(stdout) as Partial<NonoQueryResult>;
    if (typeof parsed.status === "string") {
      return {
        status: parsed.status,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        details: typeof parsed.details === "string" ? parsed.details : undefined,
      };
    }
  } catch {
    // nono missing, non-JSON output, or query timeout.
  }
  return undefined;
}

/** File-path input and the access it implies, for the in-process file tools. */
export function pathQueryForTool(
  event: Pick<ToolCallEvent, "toolName" | "input">,
): { path: string; op: "read" | "write" | "readwrite" } | undefined {
  const input = event.input as { path?: unknown };
  const raw = input.path;
  if (typeof raw !== "string" || !raw) return undefined;
  if (event.toolName === "read") return { path: raw, op: "read" };
  if (event.toolName === "write") return { path: raw, op: "write" };
  if (event.toolName === "edit") return { path: raw, op: "readwrite" };
  return undefined;
}

export interface FileGateDenial {
  path: string;
  op: "read" | "write" | "readwrite";
  /** Human-sized denial cause, for the approval dialog. */
  detail: string;
  /** Full model-facing reason for when the call ends up blocked. */
  blockReason: string;
}

/**
 * Pseudo-sandboxing for Pi's in-process file tools: they cannot be OS-confined
 * without confining Pi itself, so the extension gates them when the tools
 * profile would deny the path. The only route around this gate is bash, which
 * IS OS-confined. Returns a denial for the caller to escalate to the user
 * (elevation is a human decision), or undefined to let the call run.
 *
 * Fail-closed: a failed query is treated as a denial — danger mode
 * (checked by the caller) is the escape hatch when nono itself is broken.
 */
export async function gateFileTool(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  cwd: string,
): Promise<FileGateDenial | undefined> {
  const query = pathQueryForTool(event);
  if (!query) return undefined;

  const path = isAbsolute(query.path) ? query.path : resolve(cwd, query.path);
  const result = await queryToolsProfile(path, query.op, cwd);
  if (!result) {
    return {
      path,
      op: query.op,
      detail: "profile query failed",
      blockReason:
        `Gatekeeper: could not verify ${path} against the '${toolsProfile()}' nono profile ` +
        "(query failed). Ask the user to check the nono install, or to switch to " +
        "danger via /gatekeeper if this gate is misfiring.",
    };
  }
  if (result.status === "allowed") return undefined;

  const detail = result.details ?? result.reason ?? "denied";
  return {
    path,
    op: query.op,
    detail,
    blockReason:
      `Gatekeeper: '${toolsProfile()}' profile denies ${query.op} on ${path} (${detail}).` +
      NONO_DENIAL_GUIDANCE,
  };
}

function textFromEvent(event: Pick<ToolResultEvent, "content">): string {
  return event.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function looksLikeNonoDenial(
  event: Pick<ToolResultEvent, "toolName" | "content" | "details" | "isError">,
): boolean {
  if (!event.isError) return false;
  const haystack = [event.toolName, textFromEvent(event), JSON.stringify(event.details ?? {})].join(
    "\n",
  );
  return DENIAL_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Bash results are the only place sandbox denials still surface (file tools
 * are gated before they run), so failures that look like denials get the
 * diagnostic + remediation guidance appended.
 */
export function appendNonoDenialGuidance(
  event: ToolResultEvent,
): ToolResultEventResult | undefined {
  if (!looksLikeNonoDenial(event)) return undefined;

  return {
    content: [
      ...event.content,
      {
        type: "text",
        text: NONO_DENIAL_GUIDANCE,
      },
    ],
    isError: true,
  };
}
