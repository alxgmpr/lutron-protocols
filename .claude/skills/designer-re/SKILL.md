---
name: designer-re
description: "Decompile and analyze Lutron Designer .NET DLLs. Use when investigating how Designer implements a feature (account gating, channel entitlements, device model rules, toolbox platform filtering, protocol handlers), tracing an enum/attribute through the assembly stack, or cross-referencing SQLMODELINFO against in-DLL metadata. Complements designer-feature-flags (flag-specific tracing) and designer-project (project-file/DB queries)."
metadata:
  author: alex
  version: "1.1"
user_invocable: false
---

# Reverse Engineering Lutron Designer Libraries

Decompile and analyze .NET DLLs from Lutron Designer to understand internal systems (account gating, device models, protocol handling, feature flags, etc.).

## MSIX Extraction

The Designer app is packaged as an MSIX (zip). Extract to get the DLLs:

```bash
mkdir -p /tmp/lutron-designer && unzip -o "/Users/user/lutron-tools/Lutron Designer 26.0.2.100.msix" -d /tmp/lutron-designer
```

App DLLs are in `/tmp/lutron-designer/QuantumResi/`. If already extracted, reuse that directory.

## Decompilation

Use `ilspycmd` to decompile .NET assemblies to readable C#:

```bash
# Set env for every ilspycmd call (dotnet 10 with roll-forward for net8 tool)
export DOTNET_ROOT=/opt/homebrew/Cellar/dotnet/10.0.103/libexec
export DOTNET_ROLL_FORWARD=LatestMajor
ILSPY=~/.dotnet/tools/ilspycmd
```

### Common Operations

```bash
# List all classes in a DLL
$ILSPY <dll> -l c

# List all enums
$ILSPY <dll> -l e

# List all interfaces
$ILSPY <dll> -l i

# Decompile a specific type (must use fully-qualified name)
$ILSPY <dll> -t "Namespace.TypeName"

# Decompile entire DLL to a directory as a project
$ILSPY -p -o /tmp/decompiled <dll>
```

### Finding Types

If you don't know where a type lives, use `strings` across DLLs:

```bash
cd /tmp/lutron-designer/QuantumResi
strings Lutron.Gulliver.*.dll | grep -i "SearchTerm" | sort -u

# Or search for a specific type name across all DLLs
for dll in Lutron.Gulliver.*.dll; do
  result=$($ILSPY "$dll" -l c 2>&1 | grep -i "TypeName")
  if [ -n "$result" ]; then echo "=== $dll ==="; echo "$result"; fi
done
```

## Key DLLs

| DLL | Contains |
|-----|----------|
| `Lutron.Gulliver.Infrastructure.dll` | ChannelTypes enum, UserManager, auth service, ProductType, crypto, HTTP clients |
| `Lutron.Gulliver.InfoObjects.dll` | ToolboxPlatformTypes enum, ModelInfo, device metadata |
| `Lutron.Gulliver.FeatureFlagServiceProvider.dll` | FeatureFlagType enum, Rollout.io integration |
| `Lutron.Gulliver.DomainObjects.dll` | Domain model, device types, programming model |
| `Lutron.Gulliver.DBDataProviders.dll` | SQL queries, data readers, DB schema knowledge |
| `Lutron.Gulliver.CommonServices.dll` | Shared services, utilities |
| `Lutron.PCDesigner.SystemSync.dll` | Processor sync/transfer logic |
| `Lutron.ProcessorTransfer.dll` | Transfer protocol, activation |
| `Lutron.Services.Core.LeapClientFramework.dll` | LEAP client implementation |
| `Lutron.Gulliver.LutronCloudApiIntegration.dll` | Cloud API integration |

## Pattern: Enums with Attributes

Lutron heavily uses enums decorated with custom attributes. These are the key patterns:

- **`[Display(Name = "...")]`** — maps enum values to API string representations
- **`[Channel(ChannelTypes.X)]`** — gates features behind channel entitlements
- **`[ValidProductTypes(ProductTypes = new[] { ... })]`** — restricts to specific product types
- **`[DefaultValueForProductType(...)]`** — feature flag defaults per product
- **`[FeatureFlagNamespace("LutronDesigner")]`** — Rollout.io namespace
- **`[I18NInformation(VisualId.X, id)]`** — UI string localization IDs
- **`[Sorting(n)]`** — display order in toolbox

When reverse engineering a gating system, always check: the enum definition, its attributes, and the extension methods class that operates on it.

## Cross-Referencing with DB

The SQLMODELINFO database stores device metadata that maps to these enums. Use the `designer-db` MCP tool (`mcp__designer-db__query`) to query when Designer is running:

```sql
-- Find what platforms a device family supports
SELECT m.LUTRONMODELNUMBERBASE, f.TOOLBOXPLATFORMTYPES
FROM TBLMODELINFO m
JOIN TBLFAMILYCATINFOMODELINFOMAP fm ON fm.MODELINFOID = m.MODELINFOID
JOIN TBLFAMILYCATEGORYINFO f ON f.FAMILYCATEGORYINFOID = fm.FAMILYCATEGORYINFOID
WHERE m.LUTRONMODELNUMBERBASE LIKE 'RR%';
```

## Existing Analysis

Documented findings (channels, auth flow, toolbox platform bitfields, RA3-in-HW unlock):
- `docs/security/designer-auth-bypass.md` — RefreshToken/AuthenticateCode → SetUserChannels flow
- `docs/security/designer-jailbreak.md` — channel/platform enum details
- `docs/infrastructure/designer-universal-unlock.md` — cross-platform unlock (e.g., RA3 in HW toolbox) baked into the DLL patcher
