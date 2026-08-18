# Domain Model — v0

## Project
A product or production stream, e.g. Software Factory, Kıvılcım, JointLedger, Portfolio.

## Intent
Raw user request before it becomes approved work.

## Plan
A versioned interpretation of an Intent: goals, boundaries, assumptions, decisions and proposed work breakdown.

## WorkItem
The atomic tracked unit that can later map to a GitHub Issue.

Minimum fields:
- id
- projectId
- title
- type
- status
- priority
- planVersion
- dependencies
- acceptanceCriteriaIds
- assignedRole
- runIds

## AcceptanceCriterion
A behavior/condition that must be proven, not merely claimed.

## Run
One attempt by one worker/provider/model to perform a defined role on a defined WorkItem/spec version.

## Review
A deterministic or semantic evaluation of outputs from a Run.

## Approval
A human decision at a protected gate.

Initial protected gates:
- PLAN_APPROVAL
- RELEASE_APPROVAL
- PUBLISH_APPROVAL
- CONSTITUTION_CHANGE

## Evidence
Verifiable artifacts produced by work:
- commit/PR reference
- test output
- lint/typecheck/build output
- screenshot/demo
- benchmark result
- review report
- decision record
- source notes

## Status proposal
IDEA -> ANALYSIS -> PLAN_REVIEW -> READY -> IMPLEMENTING -> VERIFYING -> REVIEW -> WAITING_FOR_HUMAN -> DONE

Additional: BLOCKED, CANCELLED.
