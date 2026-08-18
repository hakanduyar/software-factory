# ADR-0001 — Bootstrap locally before server deployment

Status: Accepted

## Decision
Build and validate the first Software Factory core locally before deploying an always-on server.

## Why
- Faster iteration and debugging.
- No premature infrastructure complexity.
- Approval/test/audit semantics can be proven before remote execution.
- Reduces risk while the Factory is able to modify its own codebase.

## Consequence
Telegram/WhatsApp and true location-independent execution are later phases, not bootstrap blockers. Architecture must still keep interfaces/adapters clean so migration does not require a rewrite.
