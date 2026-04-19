---
name: designer-feature-flags
description: "Investigate and patch Lutron Designer feature flags. Use when you need to find out what a named flag controls, locate where it is checked in the .NET DLLs, trace a gated UI element back through ViewModel/ModelView/Domain layers, determine whether a flag is consumed at all, or plan a new DLL patch to force-enable a flag. For the build/deploy cycle of patched DLLs, hand off to anthropic-skills:designer-deploy."
metadata:
  author: alex
  version: "2.0"
user_invocable: false
---

# Designer Feature Flag Investigation

Methodology for tracing what a named flag controls, through the .NET UI stack, and deciding whether a DLL patch will actually change observable behavior.

For actual patch implementation see [tools/dll-patcher/DllPatcher/Program.cs](../../../tools/dll-patcher/DllPatcher/Program.cs) (dnlib-based — do not hand-edit IL bytes). For deploy, use `anthropic-skills:designer-deploy`.

## Prerequisites

- ILSpy MCP connected (`mcp__ilspy-mcp__decompile_type`, `decompile_method`, `search_members_by_name`, `list_assembly_types`)
- DLLs on disk. Either:
  - Extract from the MSIX: `unzip -o <Designer>.msix -d /tmp/lutron-designer` (see `designer-re` skill), **or**
  - Pull from the VM into `/tmp/designer-rox/` (see `docs/infrastructure/designer-universal-unlock.md` for VM path)

No Python/dnfile environment is required for investigation — ILSpy covers it. Byte-level IL analysis is only needed when implementing a brand-new patch, and even then the patcher (`tools/DllPatcher`) uses dnlib, not raw bytes.

## The DLL Stack

Feature flags flow through 4 layers. Trace top-down (UI → ViewModel → ModelView → Domain):

| Layer | DLL | What lives here |
|-------|-----|-----------------|
| **UI** | `QuantumResi.dll` (~29MB) | WPF Views, XAML templates, DataTemplateSelectors |
| **ViewModel** | `QuantumResi.dll` | ViewModels — flag-gated visibility logic |
| **ModelView** | `ModelViews.dll` | Thin wrappers, property delegation to Domain |
| **Domain** | `DomainObjects.dll` | Device-type predicates (`IsXxx`), business rules |
| **Flag defs** | `FeatureFlagServiceProvider.dll` | `FeatureFlagType` enum, `FlagsContainer` Rox props, CloudBees service |
| **Infra** | `Infrastructure.dll` | `PreferenceInfoType`, `ObjectType`, `RuntimePropertyNumberEnum` |

## Step 1 — Understand the flag

Decompile the enum to read per-flag attributes:

```
mcp__ilspy-mcp__decompile_type
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.FeatureFlagServiceProvider.dll
  typeName:     Lutron.Gulliver.FeatureFlagServiceProvider.FeatureFlagType
  query:        "<FlagName>"
```

Attributes to read:
- `[DefaultValueForProductType(...)]` — per-product default when Rollout is unreachable
- `[FeatureFlagNamespace("LutronDesigner")]` — Rollout namespace
- `[ToProperty(typeof(FlagsContainer), typeof(RoxString))]` — flag is also a Rox property

If the shipped `rox-config.json` is on disk, grep it for the flag name to see experiment/target-group wiring. No experiment entry = client-only flag (controlled by defaults + local override). Target-group `613284d4ad80af9adc351d99` = internal Lutron engineers only.

## Step 2 — Find consumers

Flags are read in exactly three ways. Check all three — a flag that has an enum entry but zero consumers will not affect behavior no matter what you do.

**A. Extension-method call** (most common): `FeatureFlagType.FlagName.IsFeatureFlagEnabled()`.
Use ILSpy to search for `IsFeatureFlagEnabled` callers, or decompile suspected ViewModels and grep.

**B. `[FeatureFlagType(FeatureFlagType.FlagName)]` attribute** on a View/ViewModel class.
The framework reads the attribute at runtime. Flag value lives in the CustomAttribute blob — byte-pattern searches for the enum integer in IL will miss this.

**C. Not consumed at all.**
Enum entry and Rox property exist, but nothing reads them. Toggling does nothing. Bail out or accept the flag is a stub.

## Step 3 — Trace the UI

When a flag exists and is consumed but toggling it doesn't change what you see, the UI has additional gates. Trace from the visible UI backwards:

1. **Find the View** — search `QuantumResi.dll` for the visible UI string (dialog title, label, checkbox caption).
2. **Find visibility binding** — look for `IsXxxVisible`, `ShowXxx`, `SupportsXxx` ViewModel properties, BoolToVisibility converters, or DataTemplateSelector logic.
3. **Follow to ModelView** — it usually delegates: `SupportsFeature => Device.SupportsFeature`.
4. **Follow to Domain** — find the real predicate in `DomainObjects.dll`. Common gates live on `ControlStationDevice` (`IsSunnata`, `IsPalladiom`, `IsAlisse`, etc.), driven by `ModelInfo` (model ID, device class, link type).

The flag is one gate; the predicate chain is typically the rest. A flag toggle without a matching predicate change won't make the UI appear.

## Step 4 — Patching

Don't hand-edit IL bytes. All patches go through [tools/dll-patcher/DllPatcher/Program.cs](../../../tools/dll-patcher/DllPatcher/Program.cs) (dnlib-based). To add a new patch:

1. Add a new section in `Program.cs` that loads the target DLL, finds the method/type via dnlib, and rewrites it.
2. Clearing strong-name signing and stripping `InternalsVisibleTo` attributes is handled by the patcher — don't reimplement it.
3. Build, deploy, and verify via `anthropic-skills:designer-deploy`.

Existing patches (see `Program.cs` for authoritative list):

| DLL | Purpose |
|-----|---------|
| `FeatureFlagServiceProvider.dll` | Rox try/catch, override-gate removal — override service inits without CloudBees |
| `QuantumResi.dll` | Feature Flag Override UI + toolbox unlock + diagnostics |
| `DomainObjects.dll` | Sunnata keypad support predicates |
| `Infrastructure.dll`, `ModelViews.dll`, `InfoObjects.dll` | Strip `InternalsVisibleTo` for cross-assembly access |

## Lessons

- **Flags can be unimplemented.** Enum + Rox property can exist with no consumers. Always verify consumption before assuming a toggle matters.
- **UI visibility has multiple gates.** Domain predicate true ≠ UI appears. View layer may add template selectors, DataTriggers, or separate VM visibility props.
- **Trace from the UI, not the flag,** when a toggle produces no visible change. Compare a working path (e.g., Palladiom) to the broken one (e.g., Sunnata).
- **`ldc.i4.s N` false positives.** Small enum values (< 128) share bytes with unrelated constants in IL. Verify call-target tokens.
- **ConnectSyncService locks DLLs.** Kill it (not just QuantumResi.exe) before deploying — handled by the deploy skill, but worth knowing when a deploy fails silently.
