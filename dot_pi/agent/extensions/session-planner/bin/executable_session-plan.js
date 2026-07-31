#!/usr/bin/env node
// Thin wrapper: everything lives in ../src/cli.js so the tests can import it
// without reaching for this file's chezmoi source name (`executable_` prefix,
// which makes the source filename differ from the deployed one).

import { main } from "../src/cli.js";

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
