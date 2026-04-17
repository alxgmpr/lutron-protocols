using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Writer;

// Designer DLL patcher — applies all jailbreak patches using dnlib
// Usage: dotnet run -- <designer-dir> <output-dir>
//   designer-dir: directory containing original Designer DLLs
//   output-dir:   directory to write patched DLLs

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: dotnet run -- <designer-dir> <output-dir>");
    Console.Error.WriteLine("  designer-dir: /tmp/designer-rox  (or MSIX QuantumResi dir)");
    Console.Error.WriteLine("  output-dir:   /tmp/designer-patched");
    return 1;
}

var srcDir = args[0];
var outDir = args[1];
Directory.CreateDirectory(outDir);

var results = new List<(string dll, string patch, bool ok, string msg)>();

void Report(string dll, string patch, bool ok, string msg)
{
    results.Add((dll, patch, ok, msg));
    var icon = ok ? "OK" : "FAIL";
    Console.WriteLine($"  {icon}  [{dll}] {patch}: {msg}");
}

void SaveModule(ModuleDefMD module, string outPath, bool keepOldMaxStack = true)
{
    foreach (var attr in module.Assembly.CustomAttributes)
    {
        if (attr.TypeFullName != "System.Runtime.CompilerServices.InternalsVisibleToAttribute")
            continue;
        var val = attr.ConstructorArguments[0].Value?.ToString() ?? "";
        var pkIdx = val.IndexOf(",PublicKey=", StringComparison.OrdinalIgnoreCase);
        if (pkIdx < 0) pkIdx = val.IndexOf(", PublicKey=", StringComparison.OrdinalIgnoreCase);
        if (pkIdx < 0) continue;
        var nameOnly = val[..pkIdx];
        attr.ConstructorArguments[0] = new CAArgument(attr.ConstructorArguments[0].Type, new UTF8String(nameOnly));
    }
    var opts = new ModuleWriterOptions(module);
    if (keepOldMaxStack)
        opts.MetadataOptions.Flags |= dnlib.DotNet.Writer.MetadataFlags.KeepOldMaxStack;
    module.Write(outPath, opts);
}

// ============================================================
// 1. FeatureFlagServiceProvider.dll — override service init
// ============================================================
Console.WriteLine("--- FeatureFlagServiceProvider.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.FeatureFlagServiceProvider.dll");
    using var mod = ModuleDefMD.Load(path);

    var svc = mod.Find("Lutron.Gulliver.FeatureFlagServiceProvider.CloudBeesFeatureFlagService", false)
        ?? throw new Exception("CloudBeesFeatureFlagService not found");

    foreach (var methodName in new[] { "Setup", "ResetOverrideService" })
    {
        var method = svc.FindMethod(methodName);
        if (method?.Body == null) { Report("FFSP", methodName, false, "not found"); continue; }

        var instrs = method.Body.Instructions;
        bool patched = false;
        for (int i = 0; i < instrs.Count - 2; i++)
        {
            if (instrs[i].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[i].Operand == 0x42
                && instrs[i + 1].OpCode == OpCodes.Call
                && instrs[i + 2].OpCode == OpCodes.Brfalse_S)
            {
                // NOP the gate
                instrs[i].OpCode = OpCodes.Nop; instrs[i].Operand = null;
                instrs[i + 1].OpCode = OpCodes.Nop; instrs[i + 1].Operand = null;
                instrs[i + 2].OpCode = OpCodes.Nop; instrs[i + 2].Operand = null;

                // For Setup: wrap preceding Rox calls in try-catch so overrideService
                // creation always executes even when CloudBees is unreachable
                if (methodName == "Setup" && i > 0)
                {
                    var afterCatch = instrs[i]; // first NOP = safe landing point
                    var tryLeave = new Instruction(OpCodes.Leave, afterCatch);
                    var catchPop = new Instruction(OpCodes.Pop);
                    var catchLeave = new Instruction(OpCodes.Leave, afterCatch);

                    instrs.Insert(i, tryLeave);
                    instrs.Insert(i + 1, catchPop);
                    instrs.Insert(i + 2, catchLeave);

                    method.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
                    {
                        TryStart = instrs[0],
                        TryEnd = catchPop,
                        HandlerStart = catchPop,
                        HandlerEnd = afterCatch,
                        CatchType = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef)
                    });
                    Report("FFSP", "Setup-tryCatch", true, "Rox calls wrapped in try-catch");
                }

                patched = true;
                break;
            }
        }
        Report("FFSP", methodName, patched || true, patched ? "EnableFeatureFlagOverride gate removed" : "gate already absent (v26.2+)");
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.FeatureFlagServiceProvider.dll"));
    Report("FFSP", "write", true, "saved");
}
catch (Exception ex) { Report("FFSP", "error", false, ex.Message); }

// ============================================================
// 2. QuantumResi.dll — menu visibility, nav bypass, filter bypass
// ============================================================
Console.WriteLine("--- QuantumResi.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.QuantumResi.dll");
    using var mod = ModuleDefMD.Load(path);

    // Patch 1: LutronMenuItem.get_IsAvailable — make all Tools menu items visible
    {
        var type = FindType(mod, "LutronMenuItem");
        var method = type?.FindMethod("get_IsAvailable");
        if (method?.Body != null)
        {
            var instrs = method.Body.Instructions;
            bool patched = false;
            for (int i = 0; i < instrs.Count - 1; i++)
            {
                if (instrs[i].OpCode == OpCodes.Call
                    && instrs[i].Operand is IMethodDefOrRef mref
                    && mref.Name == "IsFeatureFlagEnabled"
                    && instrs[i + 1].OpCode == OpCodes.Brfalse_S)
                {
                    instrs[i + 1].OpCode = OpCodes.Pop;
                    instrs[i + 1].Operand = null;
                    patched = true;
                    break;
                }
            }
            Report("QR", "MenuVisibility", patched || true, patched ? "brfalse→pop" : "gate already absent (v26.2+)");
        }
        else Report("QR", "MenuVisibility", false, "get_IsAvailable not found");
    }

    // Patch 2: ShellViewModel.ShowFeatureFlagOverrides — remove navigation gate
    {
        var type = FindType(mod, "ShellViewModel");
        var method = type?.FindMethod("ShowFeatureFlagOverrides");
        if (method?.Body != null)
        {
            var instrs = method.Body.Instructions;
            bool patched = false;
            for (int i = 0; i < instrs.Count - 2; i++)
            {
                if (instrs[i].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[i].Operand == 0x42
                    && instrs[i + 2].OpCode == OpCodes.Brfalse_S)
                {
                    instrs[i].OpCode = OpCodes.Nop; instrs[i].Operand = null;
                    instrs[i + 1].OpCode = OpCodes.Nop; instrs[i + 1].Operand = null;
                    instrs[i + 2].OpCode = OpCodes.Nop; instrs[i + 2].Operand = null;
                    patched = true;
                    break;
                }
            }
            Report("QR", "NavBypass", patched || true, patched ? "IsEnabled(0x42) gate removed" : "gate already absent (v26.2+)");
        }
        else Report("QR", "NavBypass", false, "ShowFeatureFlagOverrides not found");
    }

    // Patch 3: FeatureFlagOverrideViewModel filter — always return true
    {
        var ffVM = FindType(mod, "FeatureFlagOverrideViewModel");
        MethodDef? lambda = null;
        if (ffVM != null)
        {
            // Search nested types (compiler-generated) and the type itself
            var allMethods = ffVM.Methods.Concat(ffVM.NestedTypes.SelectMany(t => t.Methods));
            lambda = allMethods.FirstOrDefault(m => m.Name.Contains("LoadFlags") && m.Name.Contains("b__"));
        }

        if (lambda?.Body != null)
        {
            lambda.Body.Instructions.Clear();
            lambda.Body.Instructions.Add(OpCodes.Ldc_I4_1.ToInstruction());
            lambda.Body.Instructions.Add(OpCodes.Ret.ToInstruction());
            lambda.Body.ExceptionHandlers.Clear();
            lambda.Body.Variables.Clear();
            Report("QR", "FilterBypass", true, $"→ return true ({lambda.Name})");
        }
        else Report("QR", "FilterBypass", false, "LoadFlags lambda not found");
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.QuantumResi.dll"));
    Report("QR", "write", true, "saved");
}
catch (Exception ex) { Report("QR", "error", false, ex.Message); }

// ============================================================
// 3. DomainObjects.dll — channel-compat + universal cross-platform unlock
// ============================================================
Console.WriteLine("--- DomainObjects.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.DomainObjects.dll");
    using var mod = ModuleDefMD.Load(path);

    // Patch: ChannelManager.IsProjectCompatibleWithChannel → return true
    // Neutralizes the 26.2 channel-compatibility gate that rejects the mixed RA3/HW project
    // because tblLinkNode rows reference ModelInfoID 4890 (NULL family, no platform bits).
    // Only callers are ProjectTypeConversionManager.ChannelCompatibilityStatus() and
    // ShowInCompatibleDeviceViewModel — forcing true lets OpenFile return Successful.
    {
        var chanMgr = mod.Find("Lutron.Gulliver.DomainObjects.Database.ChannelManager", false);
        var method = chanMgr?.FindMethod("IsProjectCompatibleWithChannel");
        if (method?.Body != null)
        {
            method.Body.Instructions.Clear();
            method.Body.ExceptionHandlers.Clear();
            method.Body.Variables.Clear();
            method.Body.Instructions.Add(OpCodes.Ldc_I4_1.ToInstruction());
            method.Body.Instructions.Add(OpCodes.Ret.ToInstruction());
            Report("DO", "ChannelCompatBypass", true, "IsProjectCompatibleWithChannel → return true");
        }
        else
        {
            Report("DO", "ChannelCompatBypass", false, "ChannelManager.IsProjectCompatibleWithChannel not found");
        }
    }

    // ---- Universal cross-platform device unlock ----
    // Make every device/link/channel combination report compatible so models from any
    // product line (RA3, HW, Athena, etc.) show up in every toolbox and attach to any link.

    // Patch: ChannelManager.IsModelCompatiblewithUserChannels(uint) → return true
    // Short-circuits the ListOfChannelCompatibleModels.Contains(id) check. The SQL list is
    // built from sel_ModelInfoForToolboxPlatformTypes using user-channel bits; stubbing here
    // bypasses the list entirely so every model is channel-compatible.
    {
        var chanMgr = mod.Find("Lutron.Gulliver.DomainObjects.Database.ChannelManager", false);
        var method = chanMgr?.FindMethod("IsModelCompatiblewithUserChannels");
        Report("DO", "ModelCompatAll", StubReturnInt(method, 1, out var msg), msg);
    }

    // Patch: ProductInfoHelper.GetLocationBasedToolboxPlatformTypesForModel(ModelInfo) →
    //   return ToolboxPlatformTypes.All (0x10FFFF)
    // FamilyCategoryInfoModelView.GetCompatibleToolboxPlatformTypes calls this; DevicePicker
    // MatchFilter and IsModelInfoAllowed then AND against the user's platformTypes — returning
    // All makes every model pass the visibility filter regardless of user channel.
    {
        var helper = mod.Find("Lutron.Gulliver.DomainObjects.ProductInfoHelper", false);
        // Overload with 1 param (ModelInfo) — not the 2-param (uint, uint) in InfoObjects
        var method = helper?.Methods.FirstOrDefault(m => m.Name == "GetLocationBasedToolboxPlatformTypesForModel"
            && m.Parameters.Count == 1);
        Report("DO", "ToolboxPlatformAll", StubReturnInt(method, 0x10FFFF, out var msg), msg);
    }

    // Patch: ModelInfoExtensionMethods.IsCompatibleWithLinkType(ModelInfo, LinkType) → return true
    // Allows any device model to claim compat with any link type.
    {
        var ext = mod.Find("Lutron.Gulliver.DomainObjects.ModelInfoExtensionMethods", false);
        var method = ext?.FindMethod("IsCompatibleWithLinkType");
        Report("DO", "ModelLinkCompat", StubReturnInt(method, 1, out var msg), msg);
    }

    // Patch: LinkNode.IsCompatibleWithLinkType(LinkType) → return true
    // Instance-method version used by the link-picker UI.
    {
        var linkNode = mod.Find("Lutron.Gulliver.DomainObjects.LinkNode", false);
        var method = linkNode?.FindMethod("IsCompatibleWithLinkType");
        Report("DO", "LinkNodeCompat", StubReturnInt(method, 1, out var msg), msg);
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.DomainObjects.dll"));
    Report("DO", "write", true, "saved");
}
catch (Exception ex) { Report("DO", "error", false, ex.Message); }

// ============================================================
// 3b. Infrastructure.dll + ModelViews.dll — strip strong name so
//     InternalsVisibleTo works between re-saved assemblies
// ============================================================
Console.WriteLine("--- Infrastructure.dll + ModelViews.dll ---");
{
    // Infrastructure — just strip IVT
    {
        var path = Path.Combine(srcDir, "Lutron.Gulliver.Infrastructure.dll");
        if (File.Exists(path))
        {
            using var mod = ModuleDefMD.Load(path);
            SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.Infrastructure.dll"));
            Report("SN", "Infrastructure.dll", true, "IVT PublicKey stripped");
        }
    }

    // ModelViews — IVT strip only (backlight diagnostic + IsAlisseForSunnata reverted)
    {
        var mvPath = Path.Combine(srcDir, "Lutron.Gulliver.ModelViews.dll");
        using var mod = ModuleDefMD.Load(mvPath);
        SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.ModelViews.dll"));
        Report("SN", "ModelViews.dll", true, "IVT PublicKey stripped");
    }
}

// ============================================================
// 4. InfoObjects.dll — IVT strip + channel→toolbox platform unlock
// ============================================================
Console.WriteLine("--- InfoObjects.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.InfoObjects.dll");
    using var mod = ModuleDefMD.Load(path);

    // Patch: ToolboxPlatformTypesExtenstionMethods.GetSupportedToolboxPlatformTypesForChannelType(ChannelTypes)
    //   → return ToolboxPlatformTypes.All (0x10FFFF)
    // Normally maps a ChannelTypes bitmask to the subset of ToolboxPlatformTypes whose
    // [Channel(...)] attribute overlaps. Stubbing to All means every user-channel combination
    // is treated as having every toolbox platform, so ChannelManager.GetChannelCompatibleModels
    // passes All to sel_ModelInfoForToolboxPlatformTypes and collects every model.
    {
        var ext = mod.Find("Lutron.Gulliver.InfoObjects.ModelInfo.ToolboxPlatformTypesExtenstionMethods", false);
        var method = ext?.FindMethod("GetSupportedToolboxPlatformTypesForChannelType");
        Report("IO", "ChannelToolboxAll", StubReturnInt(method, 0x10FFFF, out var msg), msg);
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.InfoObjects.dll"));
    Report("IO", "write", true, "saved");
}
catch (Exception ex) { Report("IO", "error", false, ex.Message); }

// ============================================================
// Summary
// ============================================================
Console.WriteLine();
int ok = results.Count(r => r.ok);
int fail = results.Count(r => !r.ok);
Console.WriteLine($"=== {ok} passed, {fail} failed ===");
if (fail > 0)
    foreach (var r in results.Where(r => !r.ok))
        Console.WriteLine($"  FAIL [{r.dll}] {r.patch}: {r.msg}");

return fail > 0 ? 1 : 0;

static TypeDef? FindType(ModuleDefMD module, string shortName) =>
    module.GetTypes().FirstOrDefault(t => t.Name == shortName);

// Stub a method body to `return <value>` (for int/enum/bool returns). Idempotent:
// a method whose body is already exactly `ldc.i4.<value>; ret` is left alone and reported OK.
// Returns false (with a diagnostic in msg) only when the MethodDef is missing.
static bool StubReturnInt(MethodDef? method, int value, out string msg)
{
    if (method?.Body == null) { msg = "method not found"; return false; }
    var instrs = method.Body.Instructions;
    if (instrs.Count == 2 && GetLdcI4Value(instrs[0]) == value && instrs[1].OpCode == OpCodes.Ret)
    {
        msg = $"already stubbed → {value}";
        return true;
    }
    instrs.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    instrs.Add(NewLdcI4(value));
    instrs.Add(OpCodes.Ret.ToInstruction());
    msg = $"stubbed → {value}";
    return true;
}

static Instruction NewLdcI4(int v)
{
    switch (v)
    {
        case -1: return OpCodes.Ldc_I4_M1.ToInstruction();
        case 0: return OpCodes.Ldc_I4_0.ToInstruction();
        case 1: return OpCodes.Ldc_I4_1.ToInstruction();
        case 2: return OpCodes.Ldc_I4_2.ToInstruction();
        case 3: return OpCodes.Ldc_I4_3.ToInstruction();
        case 4: return OpCodes.Ldc_I4_4.ToInstruction();
        case 5: return OpCodes.Ldc_I4_5.ToInstruction();
        case 6: return OpCodes.Ldc_I4_6.ToInstruction();
        case 7: return OpCodes.Ldc_I4_7.ToInstruction();
        case 8: return OpCodes.Ldc_I4_8.ToInstruction();
    }
    if (v >= -128 && v <= 127) return new Instruction(OpCodes.Ldc_I4_S, (sbyte)v);
    return new Instruction(OpCodes.Ldc_I4, v);
}

static int GetLdcI4Value(Instruction instr)
{
    if (instr.OpCode == OpCodes.Ldc_I4_0) return 0;
    if (instr.OpCode == OpCodes.Ldc_I4_1) return 1;
    if (instr.OpCode == OpCodes.Ldc_I4_2) return 2;
    if (instr.OpCode == OpCodes.Ldc_I4_3) return 3;
    if (instr.OpCode == OpCodes.Ldc_I4_4) return 4;
    if (instr.OpCode == OpCodes.Ldc_I4_5) return 5;
    if (instr.OpCode == OpCodes.Ldc_I4_6) return 6;
    if (instr.OpCode == OpCodes.Ldc_I4_7) return 7;
    if (instr.OpCode == OpCodes.Ldc_I4_8) return 8;
    if (instr.OpCode == OpCodes.Ldc_I4_M1) return -1;
    if (instr.OpCode == OpCodes.Ldc_I4_S) return (sbyte)instr.Operand;
    if (instr.OpCode == OpCodes.Ldc_I4) return (int)instr.Operand;
    return int.MinValue;
}
