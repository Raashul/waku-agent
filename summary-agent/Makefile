# summary-agent — dev tasks.  Run `make` or `make help` for the list.
# Config comes from .env (Postgres, S3/AWS, LLM). See README.md.

.DEFAULT_GOAL := help
NODE_BIN := ./node_modules/.bin

.PHONY: help install run dev seed upload test test-watch typecheck migrate psql clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

run: ## Start the app: migrate + poller + HTTP API on $PORT (default 8088)
	npm start

dev: ## Same as run, with reload on file change
	npm run dev

seed: ## Offline demo: upload docs/<TICKER>/*.md with the mock LLM, print the summary
	LLM_DRIVER=mock npm run seed:demo

upload: ## Upload one article to the configured store. make upload FILE=docs/NVDA/article1.md [TICKER=NVDA]
	@test -n "$(FILE)" || { echo "usage: make upload FILE=path/to/article.md [TICKER=SYM]"; exit 2; }
	$(NODE_BIN)/tsx scripts/put-article.ts "$(FILE)" "$(TICKER)"

test: ## Run the test suite (needs Postgres; real-LLM tests skip without a key)
	npm test

test-watch: ## Run tests in watch mode
	npm run test:watch

typecheck: ## Type-check without emitting
	npm run typecheck

migrate: ## Create/update the database schema (idempotent)
	$(NODE_BIN)/tsx scripts/migrate.ts

clean: ## Remove local scratch (.data/)
	rm -rf .data
