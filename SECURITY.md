# Security Policy

Thanks for helping keep Token Racer and its users safe.

## Reporting a Vulnerability

If you think you've found a security issue — in the CLI, the backend it talks
to, or the dashboard — please **don't open a public GitHub issue**. Instead:

- Email **sgyeom0319@gmail.com** with the subject line `[token-racer security]`
- Or use GitHub's private vulnerability reporting:
  <https://github.com/jimbo111/token-racer/security/advisories/new>

Please include:

- A short description of the issue and its impact
- Steps to reproduce, or a minimal proof-of-concept
- Any affected versions (CLI, backend, dashboard) you've identified
- Whether you plan to disclose publicly and on what timeline

You'll get an acknowledgement within **72 hours**. I'll follow up with a fix
plan or further questions as soon as I can — typically within a week for
anything I can reproduce.

## Scope

In scope:

- The `token-racer` CLI (this repo)
- The hosted backend at `https://token-racer-backend.onrender.com`
- The hosted dashboard at `https://token-racer-dashboard.vercel.app`
- The `install.sh` install flow and released `index.mjs` artifact

Out of scope:

- Rate-limit fairness and Nation Wars scoring edge cases (file these as normal
  issues)
- Denial-of-service from a single client against the hosted backend (the
  backend has rate limits; please don't try to find the ceiling experimentally)
- Issues in third-party dependencies — report those upstream, but do CC me so
  I can pin/patch

## What Token Racer Reads From Your Machine

Worth repeating here since it's load-bearing for trust:

- The CLI only reads **token-usage metadata** from your LLM tool logs — model
  names, token counts, timestamps, cost estimates.
- It never reads your **prompts, completions, or file contents** from those
  logs. See the [Privacy](README.md#privacy) section of the README for specifics.
- Your Ed25519 private key stays on your machine in `~/.token-racer/keys/`
  (mode `0600`). The backend only ever sees the public half.
- The one-time API key returned at registration is stored locally in
  `~/.token-racer/config.json` (mode `0600`) and used as a bearer token for
  ingest. `token-racer uninstall --purge` removes both.

## Data Deletion

To remove your account and server-side data, email **sgyeom0319@gmail.com**
with the subject `[token-racer delete-account]` and the nickname shown by
`token-racer status`. I'll confirm once your user row and associated events
are removed.
