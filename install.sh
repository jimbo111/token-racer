#!/bin/sh
# token-racer installer — POSIX sh, macOS + Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jimbo111/token-racer/main/install.sh | sh
#
# Environment overrides:
#   TOKEN_RACER_INSTALL_DIR=/custom/path    (default: $HOME/.local/bin, fallback /usr/local/bin)
#   TOKEN_RACER_VERSION=vX.Y.Z              (default: latest)
#
# What this does, in order:
#   1. Checks platform is macOS or Linux (Windows → use WSL).
#   2. Checks `node --version` is ≥ 22.
#   3. Picks an install dir — user-writable preferred, sudo only as fallback.
#   4. Downloads index.mjs from the GitHub release.
#   5. Validates the shebang so a GitHub 404 HTML page can't slip through.
#   6. Installs as `token-racer`, mode 0755.
#   7. Warns if the install dir is not on PATH.
#
# What this does NOT do: run `token-racer setup`. The installer mutates
# $PATH-accessible state only; setup mutates ~/.claude/settings.json and your
# shell rc, which we won't do without you typing the command yourself.

set -eu

REPO="jimbo111/token-racer"
BIN_NAME="token-racer"
ASSET_NAME="index.mjs"
MIN_NODE_MAJOR=22

# ---------------------------------------------------------------------------
# Output helpers — colors only when stdout is a TTY.
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
    BOLD="$(printf '\033[1m')"
    DIM="$(printf '\033[2m')"
    RED="$(printf '\033[31m')"
    GREEN="$(printf '\033[32m')"
    YELLOW="$(printf '\033[33m')"
    RESET="$(printf '\033[0m')"
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()    { printf '  %s\n' "$*"; }
note()    { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
warn()    { printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err()     { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
success() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

# ---------------------------------------------------------------------------
# Platform + Node
# ---------------------------------------------------------------------------

detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      echo "unsupported" ;;
    esac
}

check_node() {
    if ! command -v node >/dev/null 2>&1; then
        err "Node.js not found."
        note "token-racer needs Node.js $MIN_NODE_MAJOR or newer."
        note "Install via fnm:"
        note "  curl -fsSL https://fnm.vercel.app/install | bash"
        note "  fnm install $MIN_NODE_MAJOR && fnm default $MIN_NODE_MAJOR"
        exit 1
    fi

    _v="$(node --version 2>/dev/null || echo v0)"
    # Parse "v22.12.0" → "22". Handles "v22", "v22.1.0-pre", etc.
    _major="$(printf '%s' "$_v" | sed -E 's/^v?([0-9]+).*/\1/')"

    # Distinguish "version string we couldn't parse" from "version too old".
    # An unparseable output (weird nvm state, exotic build) deserves a clearer
    # error than "Node.js v0 is too old".
    if [ -z "$_major" ] || ! printf '%s' "$_major" | grep -qE '^[0-9]+$'; then
        err "Could not parse Node version from: $_v"
        note "Run \`node --version\` yourself and check the output. Expected something like v22.12.0."
        exit 1
    fi

    if ! [ "$_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
        err "Node.js $_v is too old. Need v$MIN_NODE_MAJOR or newer."
        note "Upgrade via fnm:  fnm install $MIN_NODE_MAJOR && fnm default $MIN_NODE_MAJOR"
        exit 1
    fi

    success "Node $_v detected (meets requirement)"
}

# ---------------------------------------------------------------------------
# Install prefix
# ---------------------------------------------------------------------------

pick_install_dir() {
    if [ -n "${TOKEN_RACER_INSTALL_DIR:-}" ]; then
        mkdir -p "$TOKEN_RACER_INSTALL_DIR" 2>/dev/null || true
        echo "$TOKEN_RACER_INSTALL_DIR"
        return
    fi

    # Prefer $HOME/.local/bin — POSIX user-local, no sudo. Create if missing.
    _local_bin="$HOME/.local/bin"
    mkdir -p "$_local_bin" 2>/dev/null || true
    if [ -w "$_local_bin" ]; then
        echo "$_local_bin"
        return
    fi

    # Last resort: /usr/local/bin (sudo required).
    echo "/usr/local/bin"
}

is_on_path() {
    case ":${PATH:-}:" in
        *":$1:"*) return 0 ;;
        *)        return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

download_to() {
    # $1 = URL, $2 = destination path
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 2 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --tries=2 "$1" -O "$2"
    else
        err "Neither curl nor wget found. Install one and try again."
        exit 1
    fi
}

release_url() {
    _version="${TOKEN_RACER_VERSION:-latest}"
    if [ "$_version" = "latest" ]; then
        echo "https://github.com/$REPO/releases/latest/download/$ASSET_NAME"
    else
        echo "https://github.com/$REPO/releases/download/$_version/$ASSET_NAME"
    fi
}

validate_artifact() {
    # Guard against a 404 HTML page being written to disk on a missing release.
    _path="$1"
    if [ ! -s "$_path" ]; then
        err "Downloaded file is empty."
        exit 1
    fi
    if ! head -n 1 "$_path" | grep -q '^#!/usr/bin/env node'; then
        err "Downloaded file is not a valid token-racer binary (missing Node shebang)."
        note "The GitHub release may not exist. Check:"
        note "  $(release_url)"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    printf '\n'
    printf '  %stoken-racer installer%s\n' "$BOLD" "$RESET"
    printf '  ────────────────────────────────────────\n\n'

    # 1. Platform
    _os="$(detect_os)"
    if [ "$_os" = "unsupported" ]; then
        err "Unsupported platform: $(uname -s). Supported: macOS, Linux (use WSL on Windows)."
        exit 1
    fi
    note "Platform: $_os"

    # 2. Node
    check_node

    # 3. Install dir
    install_dir="$(pick_install_dir)"
    note "Install dir: $install_dir"

    needs_sudo=0
    if [ ! -w "$install_dir" ]; then
        needs_sudo=1
        warn "$install_dir is not writable — will prompt for sudo."
    fi

    # 4. Download
    tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t 'token-racer-install')"
    trap 'rm -rf "$tmpdir"' EXIT INT HUP TERM

    url="$(release_url)"
    info "Downloading $url"
    if ! download_to "$url" "$tmpdir/$ASSET_NAME"; then
        err "Download failed."
        note "Try a specific version:  TOKEN_RACER_VERSION=v0.1.0 …"
        exit 1
    fi

    validate_artifact "$tmpdir/$ASSET_NAME"

    # 5. Install
    target="$install_dir/$BIN_NAME"
    if [ "$needs_sudo" -eq 1 ]; then
        if ! command -v sudo >/dev/null 2>&1; then
            err "sudo is required to write to $install_dir but is not installed."
            note "Set TOKEN_RACER_INSTALL_DIR to a writable path, e.g.:"
            note "  TOKEN_RACER_INSTALL_DIR=\"\$HOME/.local/bin\" curl -fsSL … | sh"
            exit 2
        fi
        info "Installing to $target (sudo)"
        sudo install -m 0755 "$tmpdir/$ASSET_NAME" "$target"
    else
        install -m 0755 "$tmpdir/$ASSET_NAME" "$target"
    fi

    success "Installed $BIN_NAME → $target"

    # 6. PATH sanity — if install_dir isn't on PATH, name the exact rc file
    # the user needs to edit, with a copy-paste-ready line. Without this, the
    # "next: token-racer setup" step fails with "command not found" and the
    # new user has no idea why.
    if ! is_on_path "$install_dir"; then
        warn "$install_dir is NOT on your PATH — \`token-racer\` won't be found yet."

        _shell_base="$(basename "${SHELL:-}")"
        case "$_shell_base" in
            zsh)
                _rc_file="$HOME/.zshrc"
                _rc_line="export PATH=\"$install_dir:\$PATH\""
                ;;
            bash)
                _rc_file="$HOME/.bashrc"
                _rc_line="export PATH=\"$install_dir:\$PATH\""
                ;;
            fish)
                _rc_file="$HOME/.config/fish/config.fish"
                _rc_line="set -gx PATH $install_dir \$PATH"
                ;;
            *)
                _rc_file=""
                _rc_line="export PATH=\"$install_dir:\$PATH\""
                ;;
        esac

        if [ -n "$_rc_file" ]; then
            note "Add this one line to $_rc_file, then open a new terminal:"
            note "  $_rc_line"
        else
            note "Unknown shell ($_shell_base). Add this line to your shell's rc file, then open a new terminal:"
            note "  $_rc_line"
        fi
    fi

    # 7. Next steps — don't auto-run setup; it mutates ~/.claude and shell rc.
    printf '\n'
    printf '  %sNext:%s  token-racer setup\n' "$BOLD" "$RESET"
    printf '  %s(interactive — edits ~/.claude/settings.json and your shell rc)%s\n\n' "$DIM" "$RESET"
}

main "$@"
