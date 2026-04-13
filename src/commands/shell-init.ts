import { define } from "gunshi";

/**
 * Outputs shell initialization code that adds the token-racer statusline to
 * the user's prompt. No background daemon — statusline itself spawns a
 * detached `sync` if events need shipping (see `commands/statusline.ts`).
 *
 * Contract: `token-racer` must be on PATH for this to work. The curl installer
 * is responsible for placing the binary in a PATH location. Each function
 * below additionally guards with `command -v` / `command -q` so PATH loss
 * mid-session results in a silent no-op rather than an error on every prompt.
 *
 * Usage — add one of these to ~/.zshrc, ~/.bashrc, or ~/.config/fish/config.fish:
 *   eval "$(token-racer shell-init)"                  # zsh / bash
 *   token-racer shell-init --shell=fish | source      # fish
 */
const shellInitCommand = define({
	name: "shell-init",
	description: "Output shell initialization code for prompt integration",
	args: {
		shell: {
			type: "string",
			short: "s",
			description: "Shell type: zsh, bash, or fish (auto-detected if omitted)",
			default: "",
		},
	},
	async run(ctx) {
		const shellType = ctx.values.shell || detectShell();

		switch (shellType) {
			case "zsh":
				process.stdout.write(zshInit());
				break;
			case "fish":
				process.stdout.write(fishInit());
				break;
			default:
				process.stdout.write(bashInit());
				break;
		}
	},
});

function detectShell(): "zsh" | "bash" | "fish" {
	const shell = process.env["SHELL"] ?? "";
	if (shell.includes("zsh")) return "zsh";
	if (shell.includes("fish")) return "fish";
	return "bash";
}

export function zshInit(): string {
	return `# Token Racer — shell integration
# Added by: eval "$(token-racer shell-init)"
#
# Requires \`token-racer\` on PATH. Run \`token-racer doctor\` if the statusline
# stops appearing.

__token_racer_statusline() {
  command -v token-racer >/dev/null 2>&1 || return
  token-racer statusline --plain 2>/dev/null
}

# Prepend statusline above the prompt — runs before every prompt render.
# The statusline command itself spawns a detached \`sync\` in the background
# if enough time has passed since the last one (see commands/statusline.ts).
precmd_functions+=(__token_racer_prompt)

__token_racer_prompt() {
  local cache_dir="\${TMPDIR:-/tmp}"
  local cache_file="$cache_dir/token-racer-\${UID}-$$"
  local now
  now=$(date +%s)

  if [[ -f "$cache_file" ]]; then
    local cache_time
    cache_time=$(head -1 "$cache_file" 2>/dev/null)
    if (( now - cache_time < 5 )); then
      local cached_line
      cached_line=$(tail -1 "$cache_file" 2>/dev/null)
      [[ -n "$cached_line" ]] && print -P "%F{green}$cached_line%f"
      return
    fi
  fi

  local line
  line="$(__token_racer_statusline)"
  if [[ -n "$line" ]]; then
    print -P "%F{green}$line%f"
    echo "$now" > "$cache_file"
    echo "$line" >> "$cache_file"
  fi
}
`;
}

export function bashInit(): string {
	return `# Token Racer — shell integration
# Added by: eval "$(token-racer shell-init)"
#
# Requires \`token-racer\` on PATH. Run \`token-racer doctor\` if the statusline
# stops appearing.

__token_racer_statusline() {
  command -v token-racer >/dev/null 2>&1 || return
  token-racer statusline --plain 2>/dev/null
}

# Prepend statusline above the existing PS1.
# The statusline command itself spawns a detached \`sync\` in the background
# if enough time has passed since the last one.
__token_racer_prompt() {
  local cache_dir="\${TMPDIR:-/tmp}"
  local cache_file="$cache_dir/token-racer-$(id -u)-$$"
  local now
  now=$(date +%s)
  local line=""

  if [[ -f "$cache_file" ]]; then
    local cache_time
    cache_time=$(head -1 "$cache_file" 2>/dev/null)
    if (( now - cache_time < 5 )); then
      line=$(tail -1 "$cache_file" 2>/dev/null)
    fi
  fi

  if [[ -z "$line" ]]; then
    line="$(__token_racer_statusline)"
    if [[ -n "$line" ]]; then
      echo "$now" > "$cache_file"
      echo "$line" >> "$cache_file"
    fi
  fi

  if [[ -n "$line" ]]; then
    echo -e "\\033[32m$line\\033[0m"
  fi
}

PROMPT_COMMAND="__token_racer_prompt;\${PROMPT_COMMAND}"
`;
}

export function fishInit(): string {
	return `# Token Racer — shell integration
# Added by: token-racer shell-init --shell=fish | source
#
# Requires \`token-racer\` on PATH. Run \`token-racer doctor\` if the statusline
# stops appearing.

function __token_racer_prompt --on-event fish_prompt
  if not command -q token-racer
    return
  end

  set -l cache_dir (test -n "$TMPDIR"; and echo $TMPDIR; or echo /tmp)
  set -l cache_file $cache_dir/token-racer-(id -u)-%self
  set -l now (date +%s)
  set -l line ""

  if test -f "$cache_file"
    set -l cache_time (head -1 "$cache_file" 2>/dev/null)
    if test (math "$now - $cache_time") -lt 5
      set line (tail -1 "$cache_file" 2>/dev/null)
    end
  end

  if test -z "$line"
    set line (token-racer statusline --plain 2>/dev/null)
    if test -n "$line"
      echo "$now" > "$cache_file"
      echo "$line" >> "$cache_file"
    end
  end

  if test -n "$line"
    set_color green
    echo "$line"
    set_color normal
  end
end
`;
}

export default shellInitCommand;

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest != null) {
	describe("zshInit", () => {
		const out = zshInit();
		it("invokes token-racer by PATH name (no baked-in absolute path)", () => {
			// The actual command line (after the guard) must be a bare `token-racer`,
			// never prefixed with a Node interpreter + script path.
			expect(out).toMatch(/^\s*token-racer statusline --plain/m);
			expect(out).not.toMatch(/^\s*\S*node\S* .*token-racer statusline/m);
		});
		it("guards against missing binary with command -v", () => {
			expect(out).toContain("command -v token-racer >/dev/null 2>&1 || return");
		});
		it("wires precmd hook", () => {
			expect(out).toContain("precmd_functions+=(__token_racer_prompt)");
		});
	});

	describe("bashInit", () => {
		const out = bashInit();
		it("invokes token-racer by PATH name", () => {
			expect(out).toContain("token-racer statusline --plain");
			expect(out).not.toMatch(/\/usr\/bin\/node|\.mjs|\.ts/);
		});
		it("guards against missing binary with command -v", () => {
			expect(out).toContain("command -v token-racer >/dev/null 2>&1 || return");
		});
		it("wires PROMPT_COMMAND", () => {
			expect(out).toContain("PROMPT_COMMAND=");
		});
	});

	describe("fishInit", () => {
		const out = fishInit();
		it("invokes token-racer by PATH name", () => {
			expect(out).toContain("token-racer statusline --plain");
			expect(out).not.toMatch(/\/usr\/bin\/node|\.mjs|\.ts/);
		});
		it("guards against missing binary with command -q (fish idiom)", () => {
			expect(out).toContain("command -q token-racer");
		});
		it("wires fish_prompt event", () => {
			expect(out).toContain("--on-event fish_prompt");
		});
	});
}
