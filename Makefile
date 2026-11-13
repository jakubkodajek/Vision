# Single entry point for humans, agents and CI. Replace the TODO commands with
# real ones for your stack (the bootstrap-project skill does this).
.PHONY: setup lint test e2e check dev agents

setup: ## Install dependencies
	@echo "TODO(bootstrap): e.g. npm ci  |  uv sync"

lint: ## Lint, format check and typecheck
	@echo "TODO(bootstrap): e.g. npm run lint && npm run typecheck  |  ruff check . && mypy ."

test: ## Unit and integration tests
	@echo "TODO(bootstrap): e.g. npm test  |  pytest"

e2e: ## End-to-end / UI tests
	@echo "TODO(bootstrap): e.g. npx playwright test"

check: agents lint test ## Everything CI runs

dev: ## Run the app locally
	@echo "TODO(bootstrap): e.g. npm run dev  |  uvicorn app.main:app --reload"

agents: ## Verify generated agent files are in sync
	@python3 scripts/sync_agents.py --check
