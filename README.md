# 🏁 token-racer

Race your friends on LLM token usage. Install one CLI, keep using Claude Code / Codex / OpenCode the way you already do, and your token totals show up above your shell prompt + on the live leaderboard at **[token-racer-dashboard.vercel.app](https://token-racer-dashboard.vercel.app)**.

No resident process. No prompts read. No tool calls or file contents leave your laptop. Every batch is signed on your machine with your own Ed25519 key before it's sent.

---

## Install

> **Requires** Node 22+ on macOS or Linux. On Windows, use WSL. Supported shells: **bash, zsh, fish** (other shells: the statusline integration is skipped, but everything else works).

```bash
curl -fsSL https://raw.githubusercontent.com/jimbo111/token-racer/main/install.sh | sh
token-racer setup
```

That's it. The installer drops the binary in `~/.local/bin/token-racer`, then `setup` (interactive — it edits `~/.claude/settings.json` and your shell rc) walks you through generating a signing key, picking a nickname, and wiring up Claude Code's statusLine + your shell prompt.

Open a new terminal when it's done. You should see a usage line appear above your prompt:

```
🔥 Today: 12.3K tokens · $0.04 · Claude Code ▸ 10.1K · Codex ▸ 2.2K
~/projects/foo $
```

(Cached for 5 seconds, so the count lags a few seconds behind your last prompt — that's expected, not a bug.)

### See your standings

Open **[token-racer-dashboard.vercel.app](https://token-racer-dashboard.vercel.app)** to see the global racer leaderboard, country brackets, and live Nation Wars sessions in a Windows 95 dashboard. Your statusline shows today's totals; the dashboard is where you find out who's actually winning.

> **Back up `~/.token-racer/keys/`** if you care about preserving your leaderboard history across machines or reinstalls. The backend cannot re-issue an API key for a lost keypair — you'd have to start a new account.

**Default backend**: Data is POSTed to `https://token-racer-backend.onrender.com`. Pass `--apiUrl` or set `TOKEN_RACER_API_URL` to use your own.

### Uninstalling

```bash
token-racer uninstall          # remove the integration, keep your account
token-racer uninstall --purge  # full wipe — deletes local keys too (interactive: type 'purge' to confirm; use --yes in scripts)
```

### Pointing at a different backend (self-hosters)

```bash
token-racer setup --apiUrl https://your.backend.example
# or set TOKEN_RACER_API_URL in your shell env
```

---

## What gets shipped

| ✅ Sent | ❌ Never sent |
|---------|--------------|
| Token counts (input, output, cache) | Your prompts |
| Model IDs, timestamps, cost | Tool calls or arguments |
| Hashed project names (SHA-256, 12 hex chars) | File contents or raw paths |
| Your public key + nickname | Your private key (stays in `~/.token-racer/keys/`, mode 0600) |

Every batch is Ed25519-signed locally before it leaves your machine. If you're curious what a sync looks like over the wire, run `token-racer sync` and watch the output.

---

## How it works

1. Your shell prompt and Claude Code's `statusLine` both invoke `token-racer statusline` on every render (cached 5s so it's free).
2. That invocation renders today's usage from local logs and spawns a short-lived `sync` that exits within a second (rate-limited to once per 15s).
3. `sync` tails any new bytes from each LLM tool's log dir, signs batches, POSTs them to the backend, and advances a byte-offset cursor only after the backend confirms.

Nothing stays running between prompts. If the backend is down, nothing is lost: your LLM tool's log files are the source of truth, and the cursor only advances after a successful POST. Events queue up for the next successful sync.

---

## Commands

| Command | What it does |
|---|---|
| `token-racer setup [--apiUrl U] [--force] [--skip-claude] [--skip-shell]` | One-command onboarding. `--force` overrides an existing Claude statusLine from another tool. Re-run anytime — it picks up where it left off. |
| `token-racer status` | Show who you are, where you're syncing to, and when you last synced. |
| `token-racer doctor [--json]` | Health checks for Node version, PATH, keys, backend reachability, providers, and shell integration. `--json` for CI. |
| `token-racer sync` | Manually flush pending events. Normally automatic. |
| `token-racer auth nickname <new>` | Change your nickname. |
| `token-racer auth show` | Print your keyId + public key. |
| `token-racer uninstall [--purge]` | Remove the integration. `--purge` also deletes `~/.token-racer/`. |

`setup`, `status`, `doctor`, and `auth` accept `--apiUrl <url>` for self-hosters pointing at a different backend. `sync` intentionally does **not** accept it — sync attaches your bearer apiKey to every request, and allowing a per-run destination override would turn any `--apiUrl https://evil.example` invocation into an apiKey exfil. Change backends via `setup --apiUrl <url>` instead.

---

## Something broken?

**Run `token-racer doctor`.** It tells you exactly what's wrong and how to fix it.

Common issues:

- **"Statusline doesn't appear"** — restart your shell, or check `doctor`'s "Binary on PATH" line. If `~/.local/bin` isn't on PATH, add it to your shell rc.
- **"Claude statusLine conflict"** — you have another tool (`cship`, `ccusage`) set as your Claude Code statusLine. Run `token-racer setup --force` to overwrite, or remove theirs manually.
- **"Backend unreachable"** — check your network. `doctor` shows the exact URL and error.
- **"Key already registered"** — you wiped `~/.token-racer/` without backing up `keys/`. The backend can't re-issue an API key. Restore from backup or start a new account.

Anything weirder → [open an issue](https://github.com/jimbo111/token-racer/issues) with the output of `token-racer doctor --json`.

---

## On-disk layout

```
~/.token-racer/
├── keys/{public,private}.pem    # Ed25519 keypair (private is 0600)
├── config.json                  # Backend URL, API key, userId, username
├── cursors.json                 # Byte offsets per log file
├── last-sync.json               # Timestamp + accepted count
└── sync.lock                    # Advisory lock during a sync

# Also added:
~/.claude/settings.json          # one statusLine entry
~/.zshrc (or .bashrc / fish)     # one marker-delimited block
```

`token-racer uninstall` removes the Claude + shell integration. `--purge` also clears `~/.token-racer/`.

---

## Privacy FAQ

**"Is my code being sent?"** No. Only the numbers from your LLM tool's own logs (token counts, model names, timestamps, cost). Never prompts, never tool arguments, never file contents.

**"Can someone derive my prompts from what you send?"** No. You can run `token-racer sync` and read the exact bytes leaving your machine.

**"Can I run my own backend?"** Yes — point `token-racer setup --apiUrl https://your-backend` at a service that implements the [signed batch protocol](#signed-batch-protocol).

**"How do I delete my data?"** `token-racer uninstall --purge` wipes your local state. Ask the backend operator if you want your account deleted server-side too.

---

## Signed batch protocol

Every batch POSTed to `/v1/ingest` carries:

- **Headers**: `Authorization: Bearer <apiKey>`, `X-Signature-Ed25519`, `X-Signature-Timestamp`, `X-Key-Id`
- **Body**: `{ version: 1, batchId, keyId, timestamp, events[], signature }`
- **Signed message**: `canonicalJson(events) + "\n" + batchId + "\n" + timestamp`, Ed25519 over the raw bytes

Signature format must stay byte-identical between the CLI and any backend. See `src/crypto/signer.ts` for the reference implementation.

---

## Development

```bash
git clone https://github.com/jimbo111/token-racer
cd token-racer
pnpm install
pnpm dev              # hot-reload
pnpm test             # vitest
pnpm typecheck
pnpm lint
pnpm build            # → dist/index.mjs
```

Run the CLI directly from source while hacking:

```bash
node --experimental-strip-types --no-warnings src/index.ts doctor
```

To test the shell integration end-to-end: `pnpm build && npm link` puts `token-racer` on your PATH, then `token-racer setup` wires it up.

---

## Contributing

PRs welcome. A few ground rules so we don't step on each other:

- **Tests before fixes** — if you're fixing a bug, write a failing test first.
- **Keep the sync pipeline deterministic** — cursor advancement is the commit point. Don't introduce side effects that run before the backend accepts a batch.
- **Don't change `canonicalJson`** without also updating the backend's copy. Signatures must match byte-for-byte.

---

## License

[MIT](./LICENSE). Do whatever you want with it; if it breaks, it's your problem.
