# Pipeline state

Where the autonomous review/remediation loop stands, recorded here rather than
left in whatever conversation happened to be open. Written 2026-08-27.

## Reviewer quota: probe, do not read the reset time

The independent reviewer (Codex CLI, `gpt-5.6-luna`, effort `xhigh`) exhausts its
quota regularly, and there appear to be two ceilings: a short rolling one that
resets in a few hours, and a weekly one.

The reported reset time is not evidence. On 2026-08-27 a refusal named
"Sep 1st, 2026 5:43 PM" and the reviewer was available again the same evening;
another the same night named a time three hours out and was accurate. Recording
the first as fact would have idled the pipeline for five days over nothing.

**Probe instead.** One read-only call answers the only question that matters.
`scratchpad/review_scheduler5.sh` does it on a five-minute loop and runs the
queued reviews the moment it succeeds — which is how every queue here has
eventually run unattended.

Not worked around, and this stands whenever the quota is genuinely out:

- Buying credits or upgrading is a purchase. `AUTONOMOUS_SPEND_LIMIT = 0`.
- No alternative reviewer exists on this machine (`gemini`, `ollama`,
  `opencode` are all absent). Installing a weaker local model and letting it
  stand in for the configured acceptance reviewer would be weakening reviewer
  independence to manufacture progress. An ADDITIONAL reviewer could only help;
  a SUBSTITUTE one is a different decision and belongs to the user.

While the quota is out, ADR-0002 condition 3 cannot be satisfied and **no branch
may be integrated**. That is the gate working, not a failure.

## Branches, all pushed and matching origin

| Branch | Head | State |
|---|---|---|
| `feat/executor-isolation` | `507e30e` | TASK-011 + TASK-008 + TASK-012 + register. Round-16 findings addressed. Awaiting round 17. |
| `fix/verify-path-equivalence` | `fd626a5` | Verification harness + register. Round-13 findings addressed. Awaiting round 14. |
| `feat/state-integrity-rebased` | `c4e4054` | An ancestor of `feat/executor-isolation`; not reviewed separately any more. |
| `docs/known-limitations` | see below | The register and this file. An ancestor of both branches above. |
| `main` | `0087787` | Untouched. |

`main` has not moved. Every branch merges onto it cleanly.

Sixteen review rounds on the supervisor work, thirteen on the verification
harness. Every round has found something real. Nothing has been integrated,
because no round has yet returned PASS with an explicit "Safe to commit: YES" —
which is the gate working, not the loop stalling.

## What the rounds have actually been finding

Early rounds found defects in the CODE. The last several have almost entirely
found defects in the EVIDENCE — tests that pass for a reason other than the one
they name. That shift is worth knowing before reading any verdict here.

Four shapes recur, and the fourth is mine:

1. A control TRUE of the mechanism and FALSE of the system — a subset described
   as the whole. Suffix-filtered link scans, hard-coded then unnormalised scan
   roots, an audit inspecting only files whose names said `test`.
2. A control that can be switched off by DELETING something — an absent anchor
   read as silence, an empty chain excusing a forged completion.
3. A CLAIM a change has made false, left standing because nothing tests prose.
   Including, twice, entries in the limitations register itself.
4. A fixture that refuses for ANY reason satisfying an assertion that only checks
   THAT it refused. Found nine times in my own tests, mostly by the reviewer.

## Working discipline these rounds produced

- **Assert the specific refusal, not that something refused.** A regex broad
  enough to accept every refusal accepts the wrong one, and a fixture that fails
  catalog reconciliation looks identical to one that fails the guard under test.
- **A negative control must succeed, not merely fail to refuse.**
  `notEqual(WAITING_FOR_HUMAN)` is satisfied by `WAITING_FOR_RESOURCE`.
- **Confirm a mutation LANDED before believing a survivor.** Three of mine were
  no-ops — a wrong anchor, a second call site, and once a check written the wrong
  way round that printed "applied" for an untouched tree.
- **"A mutation shows this is redundant" means redundant for the cases the suite
  covers.** Deleting a guard on that basis cost a CRITICAL; the question that has
  to follow is *what case would make it necessary?*
- **Measure order, not wall-clock duration.** A timing threshold is a bet about
  the machine, and it will eventually be lost under load.

## One finding answered with a limit rather than a fix

Round-10 review showed that deleting an item's implementer history, its
`lastRunConfig`, the provenance chain and the anchor lets the resource that
reviewed it review it again. It is not closed, and the reasoning is in L-4 of
`docs/KNOWN-LIMITATIONS.md` together with the survivors that were tried and
rejected — `lastSuccessAt` is written by a successful probe, `attempts` by a
claim that may never have launched, `detail` is free text.

The round-11 prompt asks the reviewer to JUDGE that answer rather than take it.
If a survivor exists that was dismissed too quickly, it is blocking again. That
question is open and should not be treated as settled.
