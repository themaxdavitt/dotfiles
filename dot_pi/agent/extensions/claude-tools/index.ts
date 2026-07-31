/**
 * Claude Tools Extension
 *
 * Tools Claude-trained models reach for that Pi does not ship. Right now that
 * is exactly one: AskUserQuestion.
 *
 * Scope boundary, deliberately narrow: this extension registers only tool names
 * Pi does NOT have. Claude-shaped compatibility for Pi's *built-in* tools
 * (`read`/`write`/`edit`/`bash` accepting `file_path`, `replace_all`,
 * `run_in_background`) lives in the gatekeeper extension instead, because
 * registering a built-in name overrides it and gatekeeper's bash registration
 * is what installs the nono sandbox spawn hook. Two extensions racing to own
 * `bash` would decide OS confinement by directory sort order.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./src/ask-user-question";

export default function claudeTools(pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
