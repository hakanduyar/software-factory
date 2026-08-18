# Roadmap — Build the Factory with the Factory

## Phase 0 — Bootstrap documents
Goal: repository rules, architecture, domain model and first tasks exist.
Human-driven.

## Phase 1 — Local Core
Build a TypeScript CLI and core domain/workflow engine. No Telegram, n8n or server.

## Phase 2 — Persistence + Run Ledger
Persist projects/work items/runs/evidence and recover after restart.

## Phase 3 — Provider/Worker Interface
Implement provider-neutral worker contract plus a deterministic/mock worker for tests.

## Phase 4 — GitHub Adapter
Create/read/update Issues and later Project fields; branch/PR integration follows.

## Phase 5 — Claude Code Worker
Factory can assign one bounded implementation task to Claude Code and capture its result.

## Phase 6 — Verification + Independent Review
Deterministic checks plus a second-agent reviewer and protected human gates.

## Phase 7 — Self-hosting milestone
Factory receives one of its own GitHub Issues and carries it from READY through implementation, verification and review to WAITING_FOR_HUMAN without manual orchestration.

## Phase 8 — Remote Control
Add HTTP API + Telegram text/voice/file/link inbox. Local polling can be used for development; deploy always-on service only when stable.

## Phase 9 — Server deployment
Move Control Plane to an always-on environment. Add proper secret storage, durable DB, backups and observability.

## Phase 10 — Model expansion
Gemini, OpenCode free models, Ollama/local and benchmark-driven routing.

## Phase 11 — Content Factory
Evidence -> source packet -> article/LinkedIn/video script -> review -> publish approval.

## Phase 12 — n8n integrations
Use n8n for notifications and external service glue, while the Factory retains workflow authority.
