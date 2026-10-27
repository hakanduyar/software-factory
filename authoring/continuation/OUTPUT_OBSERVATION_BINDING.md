# Output observation binding: inactive declaration

`dispatch/managed-native-output-observation.ps1` defines a read-only composition function. It is not connected to a live collector, receipt producer, dispatcher, or accepted-usage ledger.

The host must independently review and load `Get-ManagedNativeCapturedFacts` with the `-ForOutputObservation` contract and `Get-ManagedNativeSdkObservation` before invoking it. Function-name discovery is not authentication. The observation capture implementation is not delivered by this change and remains a separately reviewed candidate. The SDK observer is already available in this directory.

The binding copies the eight-field evidence tuple, derives stdout/session from capture, observes that verified stdout, and recaptures the same evidence. It compares typed identity, transport fields, authority, budgets and inventories. Its result always declares `NoAcceptedUsage`, `NoReceipt`, `NoCompletion`, and `NoDispatch`.

The portable tests use explicitly labelled capture and SDK doubles. Seven cases cover an unchanged control, changed PID/run directory/exit code, missing required start/request pins, ordinal dictionary keys, and changed authority. They verify composition behavior only. A genuine complete managed capture and authenticated end-to-end runtime remain unverified; passing CI does not enable operational adoption.

Run the isolated tests in a fresh PowerShell process, supplying an absolute source path and a new output directory:

```powershell
pwsh -NoProfile -File authoring/continuation/tests/output-observation-binding.tests.ps1 -SourcePath <absolute-module-path> -OutputDirectory <new-absolute-output-directory>
```
