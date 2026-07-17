Write `AGENTS.md` for this repo. Its `README.md` already covers setup and style in detail — excerpt:

> ## Development setup
> Install Go 1.24 via `asdf`, then `make bootstrap` (fetches `protoc` plugins and git hooks). Integration tests need Docker and `make test-integration`; unit tests are `make test`.
>
> ## Style
> Errors are wrapped with `fmt.Errorf("...: %w", err)`; exported symbols need doc comments; table-driven tests preferred.

Output only the `AGENTS.md` file contents.
