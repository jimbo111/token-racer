# Changelog

All notable user-facing changes to the `token-racer` CLI are recorded here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-04-18

### Fixed

- **Registration error messages** — when the backend rejected a registration
  with a validation error (e.g., nickname format), the CLI printed a generic
  `invalid nickname` / `invalid input` fallback because it was parsing the
  old response shape. Now parses the current shape and surfaces the real
  field + reason.
- **`sync` command cleanup on exit** — replaced `process.exit()` with
  `process.exitCode` so any pending writes in `finally` blocks flush before
  the process terminates. Retryable-vs-fatal exit semantics are unchanged:
  retryable failures still exit 0 (so shell hooks don't surface them).

### Changed

- **Registration timeout** — bumped from 10s to 45s for the first-time
  registration call. The hosted backend can take up to ~30s to wake from
  idle on the free tier, and the previous timeout would bounce first-time
  users with a scary "backend unreachable" message. Regular sync still uses
  the 10s timeout.
- Registration timeout message now hints that the backend may be waking up
  and suggests retrying, instead of suggesting the service is down.

### Added

- `SECURITY.md` with a responsible-disclosure contact and a documented
  account-deletion path.

## [0.2.0] — 2026-04-14

First tagged public release.

- `token-racer setup` unifies keypair generation, registration, shell-hook
  install, and Claude Code statusline in a single resumable flow.
- `token-racer uninstall` / `--purge` cleanly removes shell integration and
  optionally all local data.
- `install.sh` validates downloaded artifact shebang, supports `--yes` for
  non-interactive installs, handles zsh/bash/fish PATH hints.
- Ed25519 signing, batched ingest, and Claude Code / Codex / OpenCode log
  tailing.
