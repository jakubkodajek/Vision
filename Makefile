# Single entry point for humans, agents and CI.
.PHONY: setup lint test e2e check dev build audit icons agents placeholders

setup: ## Install dependencies (npm + cargo)
	npm ci
	cargo fetch --locked

lint: ## Format check, clippy, typecheck, eslint
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	npx tsc --noEmit
	npx eslint .

test: ## Rust and UI unit tests
	cargo test --workspace --locked
	npx vitest run

e2e: ## End-to-end tests (none yet)
	@echo "No end-to-end suite yet: Tauri WebDriver tests arrive with F-020/F-022. Nothing to run."

check: agents placeholders lint test ## Everything CI runs

dev: ## Run the desktop app with hot reload
	npx tauri dev

# Extra arguments for `tauri build`, e.g. TAURI_BUILD_ARGS="--target aarch64-apple-darwin".
TAURI_BUILD_ARGS ?=

build: ## Build release installers for this OS (output in target/**/release/bundle/)
ifeq ($(shell uname -s),Darwin)
	mkdir -p target/dmg
	tiffutil -cathidpicheck src-tauri/icons/dmg/background.png src-tauri/icons/dmg/background@2x.png -out target/dmg/background.tiff
	npx tauri build --config '{"bundle":{"macOS":{"dmg":{"background":"../target/dmg/background.tiff"}}}}' $(TAURI_BUILD_ARGS)
else
	npx tauri build $(TAURI_BUILD_ARGS)
endif

audit: ## RustSec advisory check (needs cargo-deny)
	cargo deny --locked check advisories

icons: ## Regenerate app icons and the DMG background from src-tauri/icons/source/vision-mark.svg
	python3 scripts/make_icons.py

agents: ## Verify generated agent files are in sync
	@python3 scripts/sync_agents.py --check

placeholders: ## Fail if bootstrap placeholders remain
	@bash scripts/check_placeholders.sh
