# Handoff

## State
Confirmed `IsPalladiomKeypad` is the BAML gate for per-preset backlight columns (26 WPF calls in diag). Patched `DeviceModelViewBase.get_IsPalladiomKeypad` to return true for RFDart — columns appeared, DB got `SetBacklightIntensity`(60)/`SetStatusIntensity`(61) preset assignments. But transfer BROKE the Sunnata keypad (unresponsive even before triggering preset). Root cause: Palladiom-format intensity commands are incompatible with Sunnata firmware. `tblBacklightComponent` exists but was never populated (0 rows). Reverted IsPalladiomKeypad patch is needed — the current deployed DLLs still have it.

## Next
1. Revert the `IsPalladiomKeypad` patch from ModelViews.dll, delete the bad preset assignments (CmdGroup 39/40), re-transfer to recover the keypad
2. Investigate proper Sunnata per-preset backlight: Sunnata DOES accept backlight commands over CCX/CoAP. Need to find what DB format + transfer command format Sunnata expects vs Palladiom, then either adapt the existing Palladiom template or create a Sunnata-specific path
3. `tblBacklightComponent` (ActiveBacklightIntensity, IdleBacklightIntensity, ActiveBacklightTimeout) may be the right storage — investigate how Palladiom populates it

## Context
- Patcher at `tools/dll-patcher/DllPatcher/Program.cs` — Section 3b `FixPalladiom` patch must be reverted/removed
- 14 bad preset assignments on device 483 (Sunnata keypad, ModelInfoID 5194) across presets 3660, 11949-11956
- Sunnata uses `RingInactiveIntensityLevel` + `CCXDeviceRingIntensityLevelAttribute` for backlight (see `InitializeRFDarterKeypadPreference`), NOT Palladiom's `PalladiomBacklightIntensity`
- Deploy: kill ConnectSyncService, upload to `C:\temp-patch\`, run deploy.ps1, verify with hash-check.ps1
- The BAML trigger at offset 0x15d58 in `programming/assignableobjecttreeviewresources.baml` checks `IsPalladiomKeypad` — this is the confirmed gate
