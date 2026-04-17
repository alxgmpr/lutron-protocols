---
name: designer-feature-flags
description: "Investigate, trace, and patch Lutron Designer feature flags — find what a flag controls, trace through UI/ViewModel/Domain layers, patch DLLs to enable"
metadata:
  author: alex
  version: "1.0"
user_invocable: false
---

# Designer Feature Flag Investigation

Systematic methodology for investigating what a Designer feature flag controls, tracing its effect through the .NET UI stack, and patching DLLs to enable hidden functionality.

## Prerequisites

- ILSpy MCP server connected (tools: `mcp__ilspy-mcp__decompile_type`, `mcp__ilspy-mcp__decompile_method`, `mcp__ilspy-mcp__search_members_by_name`, `mcp__ilspy-mcp__list_assembly_types`)
- DLLs available at `/tmp/designer-rox/` (copy from VM if needed)
- Python venv with dnfile at `/tmp/dnfile-env/` for IL byte-level analysis
- VM at 192.168.64.4 (`sshpass -p alex ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password alex@192.168.64.4`)

### Getting DLLs from the VM

```bash
# Copy a DLL from the Designer MSIX directory to VM Desktop, then SCP to Mac
sshpass -p alex ssh ... 'powershell -Command "Get-ChildItem \"C:\Program Files\WindowsApps\LutronElectronics.LutronDesigner26.2.0.113_26.2.0.113_x86__hb4qhwkzq4pcy\QuantumResi\Lutron.Gulliver.DLLNAME.dll\" | Copy-Item -Destination C:\Users\alex\Desktop\"'
sshpass -p alex scp ... alex@192.168.64.4:Desktop/Lutron.Gulliver.DLLNAME.dll /tmp/designer-rox/
```

## The DLL Stack

Feature flags flow through 4 layers. Always trace top-down (UI → ViewModel → ModelView → Domain):

| Layer | DLL | What lives here |
|-------|-----|-----------------|
| **UI** | `QuantumResi.dll` (29MB) | WPF Views, XAML templates, DataTemplateSelectors, ViewModels |
| **ViewModel** | `QuantumResi.dll` | ViewModels that bind to Views, contain flag-gated visibility logic |
| **ModelView** | `ModelViews.dll` (~3MB) | Thin wrappers around domain objects, property delegation |
| **Domain** | `DomainObjects.dll` (~9MB) | Business logic, device type predicates (`IsXxx`), property storage |
| **Flag Defs** | `FeatureFlagServiceProvider.dll` (100KB) | FeatureFlagType enum, FlagsContainer Rox properties, CloudBeesFeatureFlagService |
| **Infra** | `Infrastructure.dll` (~8MB) | PreferenceInfoType, ObjectType, RuntimePropertyNumberEnum |

## Step 1: Understand the Flag

### Get flag metadata from the enum

```
mcp__ilspy-mcp__decompile_type
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.FeatureFlagServiceProvider.dll
  typeName: Lutron.Gulliver.FeatureFlagServiceProvider.FeatureFlagType
  query: "attributes for FlagNameHere"
```

Key attributes on each enum member:
- `[DefaultValueForProductType(false)]` — default when Rollout is unreachable
- `[DefaultValueForProductType(ProductType = "RadioRA3", Value = true)]` — per-product override
- `[FeatureFlagNamespace("LutronDesigner")]` — Rollout namespace prefix
- `[ToProperty(typeof(FlagsContainer), typeof(RoxString))]` — registered as Rox property

### Check if Rollout controls it remotely

```bash
source /tmp/dnfile-env/bin/activate && python3 -c "
import json
raw = json.loads(open('/tmp/designer-rox/rox-config.json', encoding='utf-8-sig').read())
data = json.loads(raw['data'])
for exp in data.get('experiments', []):
    for ff in exp.get('featureFlags', []):
        if 'FlagName' in ff['name']:
            print(json.dumps(exp, indent=2))
"
```

If no experiment references the flag, it's client-only (controlled solely by the default value and local overrides). If it has an experiment, check the `deploymentConfiguration.condition` for `isInTargetGroup` references to understand who gets it.

### Key target group patterns

Flags gated by `613284d4ad80af9adc351d99` = internal Lutron engineering only.
Flags with no target groups in their condition = generally available (already enabled for everyone).
Flags with multiple target groups = phased rollout.

## Step 2: Find How the Flag Is Consumed

Feature flags are checked in 3 ways. Search all three:

### Pattern A: Extension method call (most common)

```csharp
FeatureFlagType.FlagName.IsFeatureFlagEnabled()
```

Search for the enum value loaded before a call to `IsFeatureFlagEnabled`:

```bash
# Find the IsFeatureFlagEnabled MemberRef tokens in the target DLL
source /tmp/dnfile-env/bin/activate && python3 -c "
import dnfile
dn = dnfile.dnPE('/tmp/designer-rox/TARGET.dll')
for i, row in enumerate(dn.net.mdtables.MemberRef.rows):
    if 'IsFeatureFlagEnabled' in str(row.Name) or str(row.Name) == 'IsEnabled':
        token = 0x0A000001 + i
        print(f'token=0x{token:08x}: {row.Name}')
"
```

Then search for the enum value + call pattern:

```bash
python3 -c "
import struct
data = open('/tmp/designer-rox/TARGET.dll', 'rb').read()
enum_val = 99  # the flag's enum integer value
token = 0x0a0003b0  # IsFeatureFlagEnabled MemberRef token

# Short form (values 0-127): ldc.i4.s N + call
if enum_val <= 127:
    pattern = bytes([0x1f, enum_val, 0x28]) + struct.pack('<I', token)
    idx = data.find(pattern)
    while idx != -1:
        print(f'HIT at 0x{idx:x}')
        idx = data.find(pattern, idx + 1)

# Long form (values > 127): ldc.i4 N + call  
pattern2 = bytes([0x20]) + struct.pack('<i', enum_val) + bytes([0x28]) + struct.pack('<I', token)
idx = data.find(pattern2)
while idx != -1:
    print(f'HIT (long) at 0x{idx:x}')
    idx = data.find(pattern2, idx + 1)
"
```

**Warning:** `ldc.i4.s` with small values produces false positives (e.g., value 99 appears as high-end trim percentage). Always verify by checking the call target token.

### Pattern B: FeatureFlagTypeAttribute on a class

A View or ViewModel class is decorated with `[FeatureFlagType(FeatureFlagType.FlagName)]`. The framework checks the attribute at runtime to show/hide the UI element. The flag value is embedded in the CustomAttribute blob in metadata, NOT as IL instructions. This is why byte-pattern searches for the enum value in IL miss it.

To find these, search for class names related to the feature, then check their custom attributes via ILSpy.

### Pattern C: Not consumed at all

The flag exists in the enum and FlagsContainer but no code reads it. This means Lutron created the flag for a future feature that hasn't been implemented yet. The enum entry and Rox property exist but the consuming code was never written.

## Step 3: Trace the UI Path

When the flag check doesn't directly explain the UI behavior, trace from the visible UI backwards:

### Find the View

Search QuantumResi.dll for UI text strings (dialog titles, label text, checkbox captions):

```
mcp__ilspy-mcp__search_members_by_name
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.QuantumResi.dll
  searchTerm: "StatusIntensity" (or whatever UI text/property is visible)
```

### Find what controls visibility

WPF visibility is typically driven by:
1. **ViewModel bool properties** — bound to `Visibility` via BoolToVisibility converter
2. **DataTemplateSelector** — selects different XAML templates based on device type
3. **Triggers/DataTriggers** — conditional styling in XAML
4. **Code-behind** — ViewModel checks device predicates and sets properties

Decompile the ViewModel and look for properties like `IsXxxVisible`, `ShowXxx`, `SupportsXxx`:

```
mcp__ilspy-mcp__decompile_type
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.QuantumResi.dll
  typeName: Lutron.Gulliver.QuantumResi.Namespace.ViewModelName
  query: "visibility properties, feature flag checks"
```

### Trace through ModelView to Domain

ModelView properties usually delegate directly to domain objects:

```csharp
// ModelView (thin wrapper)
public bool SupportsFeature => ControlStationDevice.SupportsFeature;
```

Decompile the domain object to find the actual logic:

```
mcp__ilspy-mcp__decompile_method
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.DomainObjects.dll
  typeName: Lutron.Gulliver.DomainObjects.ControlStationDevice
  methodName: get_SupportsFeature
```

### Device type predicates

ControlStationDevice has many `IsXxx` predicates that gate functionality. Key ones:

```
mcp__ilspy-mcp__search_members_by_name
  assemblyPath: /tmp/designer-rox/Lutron.Gulliver.DomainObjects.dll
  searchTerm: "IsSunnata"  (or IsPalladiom, IsAlisse, IsRFDart, etc.)
```

These check `ModelInfo` properties (model ID, device class, link type) to determine device type.

## Step 4: Patch a DLL

### IL byte-level patching with dnfile

For understanding method structure:

```bash
source /tmp/dnfile-env/bin/activate && python3 -c "
import dnfile
dn = dnfile.dnPE('/tmp/designer-rox/TARGET.dll')

# Find method RVA
typedefs = list(dn.net.mdtables.TypeDef.rows)
for td in typedefs:
    tname = f'{td.TypeNamespace}.{td.TypeName}'
    ml = td.MethodList
    if ml:
        for entry in ml:
            m = entry.row
            if 'MethodName' in str(m.Name):
                print(f'{tname}.{m.Name} RVA=0x{m.Rva:x}')
"
```

### Converting RVA to file offset

```python
# For .text section: typically VA=0x2000, Raw=0x200
file_offset = rva - text_va + text_raw
# Verify by checking section headers:
for section in dn.sections:
    if b'.text' in section.Name:
        text_va = section.VirtualAddress
        text_raw = section.PointerToRawData
```

### Method header formats

- **Tiny header** (1 byte): `header & 0x03 == 0x02`, body size = `header >> 2` (max 63 bytes, no locals, max stack 8)
- **Fat header** (12 bytes): `header_word & 0x0003 == 0x0003`, code size at bytes 4-7, local var sig at bytes 8-11

### Common IL opcodes

```
00 = nop          02 = ldarg.0      03 = ldarg.1      06 = ldloc.0
14 = ldnull       16 = ldc.i4.0     17 = ldc.i4.1     1f XX = ldc.i4.s
20 XX XX XX XX = ldc.i4             25 = dup           26 = pop
28 XX XX XX XX = call               2a = ret           2c XX = brfalse.s
2d XX = brtrue.s   38 XX XX XX XX = br
60 = or           6f XX XX XX XX = callvirt
73 XX XX XX XX = newobj             7b XX XX XX XX = ldfld
7d XX XX XX XX = stfld
```

Branch offsets are signed, relative to the NEXT instruction (not the branch itself).

### Patching technique: in-place (when space allows)

```python
import shutil
shutil.copy2(original, patched)
data = bytearray(open(patched, 'rb').read())
# Modify bytes
data[offset] = new_value
with open(patched, 'wb') as f:
    f.write(data)
```

### Patching technique: code cave (when method needs to grow)

When a method body needs more bytes than available (next method starts immediately after):

1. Find padding at end of `.text` section:
```python
# .text virtual size < raw size → zero-padding at end
cave_offset = text_raw + text_vsize  # file offset of padding start
cave_rva = cave_offset - text_raw + text_va
```

2. Write the new method body (header + IL) at the cave.

3. Update the MethodDef RVA in the metadata tables:
```python
# Find the row by searching for the old RVA bytes in the metadata area
old_rva_bytes = struct.pack('<I', old_rva)
# Search in the second half of the file (metadata is after code)
idx = data.find(old_rva_bytes, len(data) // 3)
# Verify by checking adjacent rows have plausible RVAs
struct.pack_into('<I', data, idx, new_rva)
```

### Always clear STRONGNAMESIGNED

Any modified .NET assembly with `CLR_STRONGNAMESIGNED` set will fail to load. Clear bit 3 of the CLR Flags field:

```python
import struct
e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
opt_hdr = e_lfanew + 24
magic = struct.unpack_from('<H', data, opt_hdr)[0]
dd_start = opt_hdr + (96 if magic == 0x10b else 112)
clr_rva = struct.unpack_from('<I', data, dd_start + 14 * 8)[0]
clr_file = clr_rva - text_va + text_raw
flags_offset = clr_file + 16
flags = struct.unpack_from('<I', data, flags_offset)[0]
flags &= ~0x08
struct.pack_into('<I', data, flags_offset, flags)
```

## Step 5: Deploy and Test

```bash
# Kill Designer and ConnectSyncService (holds DLLs open)
sshpass -p alex ssh ... 'taskkill /F /IM QuantumResi.exe & taskkill /F /IM ConnectSyncService.exe'

# SCP patched DLL to VM
sshpass -p alex scp ... /tmp/designer-rox/PATCHED.dll alex@192.168.64.4:Desktop/

# Copy into MSIX directory
sshpass -p alex ssh ... 'powershell -ExecutionPolicy Bypass -Command "Copy-Item C:\Users\alex\Desktop\PATCHED.dll \"C:\Program Files\WindowsApps\LutronElectronics.LutronDesigner26.2.0.113_26.2.0.113_x86__hb4qhwkzq4pcy\QuantumResi\ORIGINAL_NAME.dll\" -Force"'

# Launch Designer
sshpass -p alex ssh ... 'powershell -Command "Start-Process shell:AppsFolder\LutronElectronics.LutronDesigner26.2.0.113_hb4qhwkzq4pcy!App"'
```

Designer takes ~15 seconds to fully load. ConnectSyncService may also lock DLLs — kill it before copying.

## Patched DLLs Reference

Currently patched DLLs (all at `/tmp/designer-rox/`):

| DLL | Patch | Purpose |
|-----|-------|---------|
| `FeatureFlagServiceProvider-patched.dll` | 2 patches (Setup 0x43d, ResetOverrideService 0x515) | Override service always initializes |
| `QuantumResi-v8.dll` | 3 patches (menu vis, nav bypass, filter bypass) | Feature Flag Override UI visible and populated |
| `DomainObjects-patched.dll` | SupportsActiveInactiveIntensity code cave | Sunnata keypads report backlight support |

## Lessons Learned

- **Flags can be unimplemented.** The enum entry and FlagsContainer property exist, but no code reads them. Check for consumers before assuming a flag toggle will have any effect.
- **UI visibility has multiple gates.** A domain predicate returning true is necessary but not sufficient. The View layer may have additional template selection logic, data triggers, or separate ViewModel properties that also gate visibility.
- **Trace from the UI, not the flag.** When a flag toggle doesn't produce visible change, start from the working UI (e.g., what Palladiom shows) and trace what makes it appear. Then compare to what the broken path (Sunnata) does differently.
- **`ldc.i4.s N` false positives are common.** Small enum values (< 128) share their byte encoding with literal constants (percentages, timeouts, counts). Always verify the call target after the load.
- **ConnectSyncService locks DLLs.** Kill it before deploying, not just QuantumResi.exe.
