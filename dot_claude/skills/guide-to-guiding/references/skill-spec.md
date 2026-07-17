# Agent Skill Specification

A skill is a directory containing, at minimum, a `SKILL.md` file:

```
skill-name/
├── SKILL.md       # Required: metadata + instructions
├── scripts/       # Optional: executable code
├── references/    # Optional: documentation
├── assets/        # Optional: resources, templates
└── ...            # Any additional files or directories
```

## `SKILL.md`

The `SKILL.md` file must contain YAML frontmatter followed by Markdown content.

### frontmatter

- `name` (required):
  - Must be 1–64 characters
  - May only contain Unicode lowercase alphanumeric characters (`a-z`, `0-9`) and hyphens (`-`)
  - Must not start or end with a hyphen (`-`)
  - Must not contain consecutive hyphens (`--`)
  - Must match the parent directory name
- `description` (required):
  - Must be 1–1024 characters
  - Should describe both what the skill does and when to use it
  - Should include specific keywords that help agents identify relevant tasks
- `license` (optional):
  - Specifies the license applied to the skill
  - We recommend keeping it short (either the name of a license or the name of a bundled license file)
- `compatibility` (optional):
  - Must be 1-500 characters if provided
  - Should only be included if your skill has specific environment requirements
  - Can indicate intended product, required system packages, network access needs, etc.
- `metadata` (optional):
  - A map from string keys to string values
  - Clients can use this to store additional properties not defined by the Agent Skills spec
  - We recommend making your key names reasonably unique to avoid accidental conflicts
- `allowed-tools` (optional):
  - A space-separated string of tools that are pre-approved to run
  - Support for this field may vary between agent implementations

For example:

```markdown
---
name: skill-name
description: A description of what this skill does and when to use it.
license: Apache-2.0
compatibility: Requires git, docker, jq, and access to the internet
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Bash(jq:*) Read
---
```

### Body content

The Markdown body after the frontmatter contains the skill instructions. There are no format restrictions. Agents load skills _progressively_, and skills should be structured to take advantage of this:

1. **Metadata** (\~100 tokens): The `name` and `description` fields of all skills are included in the system prompt
2. **Instructions** (\< 5000 tokens recommended): The full `SKILL.md` body is loaded when the skill is activated
3. **Resources** (as needed): Files (e.g., those in `scripts/`, `references/`, or `assets/`) are loaded only when requested

When referencing other files in your skill, use relative paths from the skill root:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Additional directories

- `scripts/` contains executable code that agents can run. Scripts should:
  - Be self-contained or clearly document dependencies
  - Include helpful error messages
  - Handle edge cases graceful
- `references/` contains additional focused documentation that agents can read when needed. Some examples:
  - `REFERENCE.md` - Detailed technical reference
  - `FORMS.md` - Form templates or structured data formats
  - Domain-specific files (`finance.md`, `legal.md`, etc.)
- `assets/` contains static resources:
  - Templates (document templates, configuration templates)
  - Images (diagrams, examples)
  - Data files (lookup tables, schemas)
