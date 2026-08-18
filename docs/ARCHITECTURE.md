# Architecture — Bootstrap Direction

## Core idea
Start as a local TypeScript application with a CLI and explicit adapters. Do not begin with a distributed microservice architecture.

## Logical components

### 1. Control Plane
Receives intents, stores state, advances workflows, enforces gates.

Initial interface: local CLI.
Later interfaces: HTTP API, Control Room web UI, Telegram, optional WhatsApp.

### 2. Domain / Workflow Engine
Owns:
- Project
- WorkItem
- Plan/Spec
- AcceptanceCriteria
- Run
- Artifact/Evidence
- Review
- Approval
- ProviderExecution

### 3. Model Router
Selects a role/provider/model based on:
- task type,
- complexity,
- sensitivity,
- context size,
- prior success metrics,
- cost/usage policy,
- availability.

### 4. Worker Adapters
Planned adapters:
- Claude Code
- Codex
- Gemini API
- OpenCode
- Ollama/local

### 5. GitHub Adapter
Later handles:
- Issues
- Projects
- branches/worktrees
- pull requests
- statuses/comments

### 6. Verification
- deterministic test runner
- lint/typecheck/build
- acceptance checks
- independent AI review where useful

### 7. Evidence Store
Stores structured metadata and references to commits, diffs, tests, screenshots, decisions, reviews and generated outputs.

### 8. Integration Layer
n8n and channel adapters connect external triggers/services without owning the core workflow state.

## Initial deployment decision
Bootstrap locally first. Move to an always-on server only after the local workflow is stable and recoverable. Remote channels come after the state machine and approval gates work locally.

## Initial persistence
Use a simple local persistence implementation behind an interface. The implementation may start with filesystem/SQLite after TASK-001/002 analysis; do not couple domain logic to it. Server deployment may later switch to PostgreSQL without changing the domain API.
