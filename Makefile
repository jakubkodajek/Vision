# Single entry point for humans, agents and CI.
.PHONY: setup lint test e2e check dev agents placeholders

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

agents: ## Verify generated agent files are in sync
	@python3 scripts/sync_agents.py --check

placeholders: ## Fail if bootstrap placeholders remain
	@bash scripts/check_placeholders.sh
