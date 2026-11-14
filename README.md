# Vision

Vision is an open-source desktop app (macOS, Windows, Linux) for working with AI coding
agents. It runs the official command-line tools you already use, such as Claude Code and
Codex, and keeps the sign-ins of each account profile (for example Work and Personal)
separate. Nothing is hosted, and Vision never stores API keys or tokens.

## Status

Early development, before 0.1. Expect missing features, rough edges and breaking changes.
Installers are built by CI but are not notarised (macOS) or code-signed (Windows).

**In this release** (spec: [`docs/specs/real-app-foundation.md`](docs/specs/real-app-foundation.md)):

- Account profiles that persist across restarts.
- Per-profile sign-in to Claude Code, Codex, GitHub CLI, Google Cloud CLI, Azure CLI,
  AWS CLI and custom tools, each with its own config directory, showing who is signed in.
- Per-profile MCP servers (stdio and HTTP): add, edit, test, remove, and sync them into
  that profile's Claude Code config.
- Installers for macOS (`.dmg`), Windows (NSIS `.exe` and `.msi`) and Linux (`.AppImage`
  and `.deb`).

**Planned** (see [`docs/PLAN.md`](docs/PLAN.md) §9): agent runs with approvals, git and
worktrees, nested projects, the agent editor, orchestration, project memory and search.

## Download and install

Installers are attached to [GitHub Releases](https://github.com/jakubkodajek/Vision/releases)
together with a `SHA256SUMS` file. Builds of pull requests and `main` are available as
artifacts of the **Build installers** workflow run (GitHub sign-in required).

Check a download against `SHA256SUMS`:
`shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS, Linux) or
`Get-FileHash .\<file>` (Windows PowerShell).

### macOS (12 Monterey or later)

Pick `Vision_<version>_aarch64.dmg` for Apple Silicon or `Vision_<version>_x64.dmg` for
Intel Macs.

1. Open the `.dmg` and drag **Vision** onto **Applications**.
2. Open Vision from Applications. macOS says it cannot verify the app, because Vision is
   only ad-hoc signed (no Apple Developer ID, not notarised). Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll to **Security**, and click
   **Open Anyway** next to the message about Vision. Confirm with **Open Anyway** and your
   password. You only have to do this once per installed version.

Terminal alternative to step 3: remove the quarantine flag, then open the app normally.

```bash
xattr -dr com.apple.quarantine /Applications/Vision.app
```

### Windows (10 or later)

Run `Vision_<version>_x64-setup.exe`. It installs for the current user only, so no
administrator prompt appears. If Microsoft Defender SmartScreen shows "Windows protected
your PC", click **More info → Run anyway** (the installer is not code-signed). The installer
downloads the Microsoft WebView2 runtime if it is missing. The `.msi` is an alternative that
installs for all users and needs administrator rights.

### Linux (x86_64)

- **Debian/Ubuntu:** `sudo apt install ./Vision_<version>_amd64.deb`
- **Other distributions:** `chmod +x Vision_<version>_amd64.AppImage` and run it. AppImages
  need FUSE 2 (`libfuse2` on Ubuntu); without it run
  `./Vision_<version>_amd64.AppImage --appimage-extract-and-run`.

Builds target glibc 2.35 (Ubuntu 22.04) or newer.

## Prerequisites

Vision does not bundle or install the tools it drives. Install them yourself:

- **git**
- The CLIs you want to use, from their official pages: Claude Code, Codex, GitHub CLI
  (`gh`), Google Cloud CLI (`gcloud`), Azure CLI (`az`), AWS CLI (`aws`).

Vision detects which ones are on your `PATH` and links to the official install pages for the
rest. You sign in through each CLI's own login flow in a terminal window.

## Development

Requirements: Node.js (version in `.nvmrc`), Rust (pinned in `rust-toolchain.toml`,
installed automatically by `rustup`), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

| Task | Command |
| --- | --- |
| Install dependencies | `make setup` |
| Run the app with hot reload | `make dev` |
| Lint, typecheck and all tests (what CI runs) | `make check` |
| Build installers for this OS | `make build` |
| RustSec advisory check (needs `cargo-deny`) | `make audit` |
| Regenerate icons and DMG background (needs Pillow, after `npm ci`) | `make icons` |

`make build` writes installers to `target/release/bundle/` (or
`target/<target-triple>/release/bundle/` with
`make build TAURI_BUILD_ARGS="--target <target-triple>"`).

Layout: `src/` React UI, `src-tauri/` Tauri shell, `crates/vision-core/` domain logic,
`tests/` UI and config tests, `docs/` plan, specs and ADRs. Contributor and AI-agent rules
are in [`AGENTS.md`](AGENTS.md) and [`docs/agent-workflow.md`](docs/agent-workflow.md).

### CI

- `ci.yml`: agent configuration checks, `make check`, RustSec advisories (`cargo deny`).
- `build.yml`: `make check`, then installers for macOS Apple Silicon and Intel, Windows and
  Linux, uploaded as artifacts. A `v*` tag also creates a draft GitHub Release with the
  installers and `SHA256SUMS`.
- All third-party actions are pinned to commit SHAs; no repository secrets are used.

The macOS DMG window layout (background, icon positions) is written by Finder through
AppleScript while the DMG is built. Tauri skips that step when `CI=true`
([tauri-apps/tauri#1731](https://github.com/tauri-apps/tauri/issues/1731)); `build.yml`
sets `TAURI_BUNDLER_DMG_IGNORE_CI=true` because GitHub's macOS runners allow `osascript` to
control Finder, and then checks the stored layout in the mounted DMG. If Finder ever refuses,
the macOS build fails rather than producing a DMG without the layout.

## Licence

MIT, see [`LICENSE`](LICENSE).
