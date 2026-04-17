# Designer Universal Platform-Compat Unlock

Five IL patches in `tools/dll-patcher/DllPatcher/Program.cs` that make every device
model, link type, and user-channel combination report compatible. Result: models
from any product line (RA3, HW, Athena, etc.) show up in every toolbox and attach to
any link, without touching the SQLMODELINFO or SQLREFERENCEINFO databases.

All patches use the common `StubReturnInt(method, value, out msg)` helper and are
idempotent — re-running the patcher reports `already stubbed → <value>`.

## Patches

### 1. `GetSupportedToolboxPlatformTypesForChannelType` → `ToolboxPlatformTypes.All`

- **Assembly**: `Lutron.Gulliver.InfoObjects.dll`
- **Type**: `Lutron.Gulliver.InfoObjects.ModelInfo.ToolboxPlatformTypesExtenstionMethods`
- **Signature**: `static ToolboxPlatformTypes (this ChannelTypes)`
- **Return**: `0x10FFFF` (`ToolboxPlatformTypes.All`)

Maps a user's channel bitmask to the set of toolbox platforms whose `[Channel(...)]`
attribute overlaps. `ChannelManager.GetChannelCompatibleModels()` feeds the result
into `sel_ModelInfoForToolboxPlatformTypes` — returning `All` makes the SQL return
every model with any platform bit set.

### 2. `ProductInfoHelper.GetLocationBasedToolboxPlatformTypesForModel(ModelInfo)` → `ToolboxPlatformTypes.All`

- **Assembly**: `Lutron.Gulliver.DomainObjects.dll`
- **Type**: `Lutron.Gulliver.DomainObjects.ProductInfoHelper`
- **Signature**: `static ToolboxPlatformTypes (ModelInfo)` (1-arg overload only — not
  the 2-arg `(uint, uint)` overload on `InfoObjects.ReferenceInfo.ProductInfo`, which
  this method wraps)
- **Return**: `0x10FFFF`

The original looks up the country-override row, falls back to
`modelInfo.ToolboxPlatformTypes` (per-model/family `TBLMODELINFOTOOLBOXPLATFORMTYPEMAP`
and `TBLFAMILYCATEGORYINFO` bits), then strips not-available-for-location bits.

Callers: `FamilyCategoryInfoModelView.GetCompatibleToolboxPlatformTypes(ModelInfo)` →
consumed by `DevicePickerViewModel.MatchFilter` and `IsModelInfoAllowed` via a bitwise
AND with the user's platform filter. Returning `All` makes every model pass the
visibility filter no matter which project or user is active.

### 3. `ChannelManager.IsModelCompatiblewithUserChannels(uint)` → `true`

- **Assembly**: `Lutron.Gulliver.DomainObjects.dll`
- **Type**: `Lutron.Gulliver.DomainObjects.Database.ChannelManager`
- **Signature**: `bool (uint modelInfoId)`

Belt-and-suspenders for patch #1. Thin wrapper around
`ListOfChannelCompatibleModels.Contains(id)` — stubbing short-circuits every caller
regardless of the SQL list contents, catching models with `TOOLBOXPLATFORMTYPES = 0`.

### 4. `ModelInfoExtensionMethods.IsCompatibleWithLinkType(ModelInfo, LinkType)` → `true`

- **Assembly**: `Lutron.Gulliver.DomainObjects.dll`
- **Type**: `Lutron.Gulliver.DomainObjects.ModelInfoExtensionMethods`
- **Signature**: `static bool (this ModelInfo, LinkType)`

The original enumerates `modelInfo.LinkNodeInfoList → LinkInfoList → LinkType` (from
`TBLLINKNODEINFOLINKTYPEMAP`) and checks for a match. Stubbing to `true` means any
device model reports compatible with any link type.

### 5. `LinkNode.IsCompatibleWithLinkType(LinkType)` → `true`

- **Assembly**: `Lutron.Gulliver.DomainObjects.dll`
- **Type**: `Lutron.Gulliver.DomainObjects.LinkNode`
- **Signature**: `bool (LinkType)`

Same check as #4 but on the instance `LinkNode` type used by link-picker UI (rather
than the extension method used by programmatic callers). Both paths exist; stubbing
both keeps behavior consistent.

## Deployment

The DLL patcher runs as part of the normal Designer deploy workflow — see the
Designer VM section of `CLAUDE.md`. Reversible by copying stock DLLs from
`/tmp/designer-rox/` back to the MSIX directory.

## Investigation

2026-04-17. RE via `ilspy-mcp` against the 26.2.0.113 MSIX DLLs cached at
`/tmp/designer-rox/`.
