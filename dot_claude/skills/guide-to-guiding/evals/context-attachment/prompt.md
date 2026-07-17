Turn these maintainer notes into the directives section of an `AGENTS.md` for our Django repo. Keep the information; the wording is up to you. Output only the section contents.

Notes:

- deploys freeze every Friday
- database migrations must be reversible — we roll back in prod a few times a year
- the payments module is legacy code from before the service split; it has no owner, so changes there need a second reviewer
