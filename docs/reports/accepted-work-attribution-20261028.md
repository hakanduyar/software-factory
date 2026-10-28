# Accepted-Work Attribution — PR90 and PR92 (2026-10-28)

Input schema: `SanitizedAcceptedWorkAttributionInputs/v1`
Exact sanitized input SHA256: `b14a20b5181b416aff5d348991840d658d994f24327544b800ef7fbc81739b90`

This report records provenance only. It grants no completion, remote ACK, new claim, history reset, or UNKNOWN-successor authority. Verification is an independent local comparison of this report against the exact supplied JSON and source receipts by the controller/reviewer; no tests were run for this prose report.

## 1. Source-to-accepted-work table

All native runs: model `claude-sonnet-5-5`, effort `low`. Monetary cost: UNKNOWN for every row.

| Unit | Run / payload / ticket | Raw source contribution | Accepted source hash / merge | Actual terminal status | SDK output tokens |
|---|---|---|---|---|---|
| PR90 native | runId `PUBLISHER_STDERR_FIX_4334de42`, attempt 1; payload `22e29007…e4f`; ticket `849f647d…93ed`; startAcknowledged=false | PR90 accepted transport `140a` | source `140a7214…75d0`; accepted-source receipt `41be8a4f…c222`; merge `2ce8b058…`(PR90; full above) | `NATURAL_EXIT`, exitCode 0 (transport outcome only) | 23679 (see §3) |
| PR92 native | runId `REGISTERED_LIFECYCLE_FAILURE_JOURNAL_17429ab4`, attempt 1; payload `ce1073dd…ef4`; ticket `5cb44869…dc3`; startAcknowledged=true | Initial journal source `b6a6`; required Cloud normalization to reach accepted `9c91`; native run not completed | source `9c91e645…5006` (Cloud-corrected); merge `f6f89e51…077ae` (PR92; full below); historical dependency `a18d8f1d…d4da` | `DEADLINE`, exitCode -1 | UNKNOWN (null) |

Merge SHAs in full: PR90 `2ce8b05879ce718596e57062a3ee836368128db1`; PR92 `f6f89e5177f15f00a64bf5f5db4e3b092d9077ae`.

### Separate Cloud contributions (not native runs)

| Target | Scope | Commit | Payload SHA256 | Model / effort | Reported tokens | Cost |
|---|---|---|---|---|---|---|
| PR92 | Persisted diagnostic checkedInt32 normalization only; yields accepted source `9c91…5006` | `354acaefbf0bbb9ea6d8878e5fd199dd8f1b48d0` | `85307d5e…7ab9` | `claude-sonnet-5-5` / low | null (UNKNOWN) | UNKNOWN |
| PR92 | Only two platform-specific test fault fixtures; test-only, productionChanged=false | `c85db1a4f0c27364297091b230cca30bd7b81943` | `583167fd…`(full in appendix) | `claude-sonnet-5-5` / low | null (UNKNOWN) | UNKNOWN |

The test-only contribution is not source-to-accepted production work.

## 2. Deduplication

- Key: native `runId + attempt + ticketSha256`. Each unique key is counted once.
- Prestart refusals and same-claim recovery are not additional provider runs or accepted-work units.
- PR92 reuses PR90 transport `140a` and historical reconciliation `a18`: these are dependencies, not new authors or duplicated output usage.
- Do not sum: overlapping snapshots/history, tests, source dependencies, cumulative counters, or corrected-source variants (`b6a6` vs `9c91`) as independent costs.
- Original claim `5521` later settled FAILED/UNKNOWN; no native task completion or automatic successor is implied.

## 3. Status separation

- **PR90 natural0:** `NATURAL_EXIT`/exit 0 is the transport outcome. Accepted product proof is separate (`independent-genuine-child-verdict.json`, appendix).
- **PR92:** native terminal remains `DEADLINE` with SDK usage UNKNOWN, even though the Cloud-corrected product merged. Failed native artifact contribution (initial `b6a6`) is distinct from the accepted Cloud correction (`9c91`).
- **23679:** the independently accepted SDK-reported output-token count for the publisher run only. It is not total billable usage (no input/cache tokens, no billing interval).
- **Current failed native usage is UNKNOWN, never 0.** Author-token facts not supplied are UNKNOWN.

## 4. Cost and efficiency

Cost, savings and comparative efficiency are all UNKNOWN: no matched billing interval or comparable baseline exists. SDK output tokens are not money.

Request hashes are separately typed and must not be equated (not asserted byte-identical):

| Run | Raw request-file SHA256 | Collector-canonical captured-request SHA256 |
|---|---|---|
| PR90 publisher | `e092782b671297fa5fb4bc7e4362b18868b90b27e7c4c528fb1bdbc8c1d88a30` | `bcbc2d408b8a4c542b9cbeeb4c381ba3c367f208adfa6e0968ea4de3cb2a2275` |
| PR92 journal | `4357d4d066fb27845c8191984ab6e8dcc3150cf5ad1e0ea2d5937133c0334726` | `0211a16b6f244935c470382c5b67175f14070985cb4f93921bedc7ad8312eebc` |

## 5. Provenance appendix (locator + SHA256)

| Item | Locator | SHA256 |
|---|---|---|
| Sanitized input | (supplied JSON) | `b14a20b5181b416aff5d348991840d658d994f24327544b800ef7fbc81739b90` |
| PR90 terminal | `terminal.json` (group `native-publisher-stderr-20261028-1`) | `5aa537cee12739acd07d5f595ba9be419d451f190a13967525bf48e4f8e5fc7a` |
| PR92 terminal | `terminal.json` (group `registered-lifecycle-failure-journal-20261028-1`) | `0e7a6c08101556f580fea7f262facfbd86522caddb06cf55c94aaa4e43ec90dd` |
| PR90 delivery receipt | `delivery-receipt.json` | `f055716a31fe5f6ad6efae8cbb78f030ea3e459aaa7924fea4cf61580ddbb147` |
| PR92 delivery receipt | `delivery-receipt.json` | `65524467f8272e79107cb7fec8fe312c03abb04c70f2e528c01de214a6e6ed0a` |
| PR90 accepted-source receipt | — | `41be8a4f43c83dc0a491cd626e5965ca7ac02fbfd196b8a478c02797474fc222` |
| PR90 source | — | `140a72148cf074a378262d35d940d865ff29abffafe74d2e70e5c3e243ff75d0` |
| PR92 accepted source | — | `9c91e6454f0d2fcb3ad44d291999a0c7f51d4a5b6569be5557e4ee2394d35006` |
| PR92 historical dependency a18 | — | `a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da` |
| PR90 genuine-child verdict | `independent-genuine-child-verdict.json` | `42d9a6954eed47688737e7b81dafb568f7d5b0644916a3a73e468d44cd89031d` |
| PR92 product acceptance | `independent-product-acceptance.json` | `b32a1346444da8911525070fdad10ad65560d340266517990fb7ccfd28834ae0` |
| PR90 native payload | — | `22e2900737d7f2e4e3567dee5a2953572f7478cd20820189500d9dad5dd37e4f` |
| PR92 native payload | — | `ce1073dd24dcc20e49c0a8722c9d96ccc473d023c81cd9abcd13069f84fc3ef4` |
| PR90 ticket | — | `849f647db87cb895695f1176ad687e41d52164d330694e08b33c3b39e1d493ed` |
| PR92 ticket | — | `5cb44869e6fd02bb242ec336d8ebfb52852ff79c70343c2ffe5d3098e5dd3dc3` |
| Cloud normalization payload | — | `85307d5e5a82d72b28d9e21fea118adcbc3202663c965ddc7deab31ff9097ab9` |
| Cloud test-fixture payload | — | `583167fd9f9b12e524c63a2fbaa333772935de74634adc8a38e6af3f78bd2e60` |

UNKNOWN (not inferable from supplied data): the `b6a6` full hash; native author token usage for PR92; billing intervals; any source-to-acceptance link beyond the receipts listed above.
