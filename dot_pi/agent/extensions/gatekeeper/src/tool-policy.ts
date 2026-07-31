const HIDDEN_BUILTIN_TOOLS = new Set(["ls", "find", "grep"]);

export function isHiddenBuiltinTool(toolName: string): boolean {
  return HIDDEN_BUILTIN_TOOLS.has(toolName);
}

export function hiddenBuiltinToolBlockReason(toolName: string): string {
  return `Gatekeeper: Pi's built-in ${toolName} tool is disabled. Use Bash CLI commands instead.`;
}

export function stripHiddenBuiltinTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((tool) => !isHiddenBuiltinTool(tool));
}

/**
 * The active tool set Gatekeeper insists on: no hidden built-ins, and the turn
 * plan tool always available so the agent can satisfy the plan gate.
 *
 * Deliberately additive about everything else — other extensions (e.g.
 * session-planner) manage their own tools, and this must not strip them.
 */
export function normalizeGatekeeperTools(
  toolNames: readonly string[],
  options: { planTool: string },
): string[] {
  const toolSet = new Set(stripHiddenBuiltinTools(toolNames));
  toolSet.add(options.planTool);
  return [...toolSet];
}
