# Admitted lifecycle UPDATE consumer

`task-lifecycle-mirror-consumer.ps1` provides `Invoke-AdmittedTaskLifecycleUpdate` for an explicitly admitted UPDATE packet targeting the mapped GitHub issue and an owned note. It does not authorize publication by itself. CREATE and COMPLETE remain unsupported by this consumer.

The caller supplies exact release, independent review and native-request hashes, plus the pinned `lifecycle-compat/continuity/reconcile.ps1` path. The sibling transport is the existing `github-cli-transport216.ps1`. The historical compatibility declarations retain their original bytes; they are not replacements for current runtime receipt validation.

The journal reads legacy five-field events and writes version 2 with a nullable, strictly validated `lastFailure` on the current event. Failure records retain only allowlisted code, phase, destination, operation and sanitized diagnostic fields. Sent-before-edit ordering, partial destination acknowledgements and refusal to repeat ambiguous edits remain intact. Failure to persist evidence is reported separately from the original operation failure.

The portable test uses injected process runners and temporary fixtures. It does not publish to GitHub or a live vault. Packaging this consumer does not migrate existing runtime callers, replace their pinned releases, or reuse prior remote-write authorizations. Such migration needs an explicit new caller release with its actual input and dependency pins.

The originating native author run ended at its deadline. Independent source review and offline checks accepted these product artifacts separately; they do not turn that run into a completed operational receipt.
