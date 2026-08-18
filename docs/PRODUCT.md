# Product Definition — Personal Software Factory

## Product goal
Create a location-independent personal production system that can turn a natural-language intent into a controlled production workflow for:

- software/applications,
- bugs/refactors,
- technical research,
- articles and LinkedIn content,
- video scripts/storyboards,
- proof/evidence records,
- later additional media outputs.

## Target user experience
The user can eventually send a text/voice/file/link from Telegram or the Control Room, discuss and revise the proposed plan, approve it, and then let the Factory create work items and execute them through specialized AI workers.

Example:
1. User: "Kıvılcım'a haftalık AI review özelliği planla."
2. Factory returns scope, assumptions, architecture proposal and open decisions.
3. User edits through dialogue.
4. User approves the plan.
5. Factory creates GitHub work items.
6. Workers implement/test/review.
7. Factory asks for release approval.
8. Evidence is stored and optional content outputs are drafted.

## Product boundaries
- Factory is not Claude Code, Codex, Gemini, OpenCode, Ollama, GitHub or n8n.
- Factory orchestrates those tools through adapters.
- n8n is an integration/automation layer, not the core state machine.
- GitHub is the persistent work/code collaboration surface.
- Telegram is a remote control/inbox, not the source of truth.
- Human approval remains mandatory at defined gates.
