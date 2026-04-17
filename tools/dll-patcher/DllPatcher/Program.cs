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
        Report("FFSP", methodName, patched, patched ? "EnableFeatureFlagOverride gate removed" : "pattern not found");
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
            Report("QR", "MenuVisibility", patched, patched ? "brfalse→pop" : "pattern not found");
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
            Report("QR", "NavBypass", patched, patched ? "IsEnabled(0x42) gate removed" : "pattern not found");
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
// 3. DomainObjects.dll — Sunnata keypad backlight support
// ============================================================
Console.WriteLine("--- DomainObjects.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.DomainObjects.dll");
    using var mod = ModuleDefMD.Load(path);

    var csd = mod.Find("Lutron.Gulliver.DomainObjects.ControlStationDevice", false)
        ?? throw new Exception("ControlStationDevice not found");
    var deviceBase = mod.Find("Lutron.Gulliver.DomainObjects.DomainDeviceBase", false)
        ?? throw new Exception("DomainDeviceBase not found");

    var supportsMethod = csd.FindMethod("get_SupportsActiveInactiveIntensity")
        ?? throw new Exception("get_SupportsActiveInactiveIntensity not found");
    var sunnataGetter = deviceBase.FindMethod("get_IsHybridKeypad")
        ?? throw new Exception("get_IsHybridKeypad not found");

    if (supportsMethod.Body == null) throw new Exception("method has no body");

    var instrs = supportsMethod.Body.Instructions;

    // Check if already patched
    if (instrs.Any(i => i.OpCode == OpCodes.Call && i.Operand is IMethodDefOrRef m && m.Name == "get_IsHybridKeypad"))
    {
        Report("DO", "SunnataBacklight", true, "already patched");
    }
    else
    {
        // Find: call get_IsSunnataFanControl; ret; ldc.i4.1; ret
        // Replace ret with brtrue.s to the ldc.i4.1, then insert ldarg.0 + call IsSunnataOrViertiKeypads + ret
        int fanIdx = -1;
        for (int i = instrs.Count - 1; i >= 0; i--)
        {
            if (instrs[i].OpCode == OpCodes.Call
                && instrs[i].Operand is IMethodDefOrRef m
                && m.Name == "get_IsSunnataFanControl")
            {
                fanIdx = i;
                break;
            }
        }

        if (fanIdx < 0 || fanIdx + 1 >= instrs.Count)
            throw new Exception("IsSunnataFanControl call not found");

        // Find the true label (ldc.i4.1)
        Instruction? trueLabel = null;
        for (int i = fanIdx + 2; i < instrs.Count; i++)
        {
            if (instrs[i].OpCode == OpCodes.Ldc_I4_1) { trueLabel = instrs[i]; break; }
        }
        if (trueLabel == null) throw new Exception("true label (ldc.i4.1) not found");

        // Convert ret → brtrue.s trueLabel
        instrs[fanIdx + 1].OpCode = OpCodes.Brtrue_S;
        instrs[fanIdx + 1].Operand = trueLabel;

        // Insert new check after
        int ins = fanIdx + 2;
        instrs.Insert(ins, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins + 1, new Instruction(OpCodes.Call, sunnataGetter));
        instrs.Insert(ins + 2, OpCodes.Ret.ToInstruction());

        Report("DO", "SunnataBacklight", true, "added IsSunnataOrViertiKeypads check");
    }

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

    // ModelViews — strip IVT + add trigger-condition diagnostics
    {
        var mvPath = Path.Combine(srcDir, "Lutron.Gulliver.ModelViews.dll");
        using var mod = ModuleDefMD.Load(mvPath);

        var corlib = mod.CorLibTypes.AssemblyRef;
        var sysRuntime = mod.GetAssemblyRef(new UTF8String("System.Runtime")) ?? corlib;
        var fileType = new TypeRefUser(mod, "System.IO", "File", sysRuntime);
        var appendAllText = new MemberRefUser(mod, "AppendAllText",
            MethodSig.CreateStatic(mod.CorLibTypes.Void, mod.CorLibTypes.String, mod.CorLibTypes.String), fileType);
        var objToString = new MemberRefUser(mod, "ToString",
            MethodSig.CreateInstance(mod.CorLibTypes.String),
            new TypeRefUser(mod, "System", "Object", corlib));
        var strConcat4 = new MemberRefUser(mod, "Concat",
            MethodSig.CreateStatic(mod.CorLibTypes.String,
                new SZArraySig(mod.CorLibTypes.String)),
            new TypeRefUser(mod, "System", "String", corlib));

        // Find get_ObjectType from existing IL in the module
        IMethodDefOrRef? getObjectType = null;
        IMethodDefOrRef? getControlType = null;
        IMethodDefOrRef? getIsPalladiomKeypad = null;
        foreach (var t in mod.GetTypes())
        {
            foreach (var m in t.Methods)
            {
                if (m.Body == null) continue;
                foreach (var instr in m.Body.Instructions)
                {
                    if ((instr.OpCode == OpCodes.Callvirt || instr.OpCode == OpCodes.Call) && instr.Operand is IMethodDefOrRef mr)
                    {
                        if (mr.Name == "get_ObjectType" && mr.MethodSig?.RetType?.FullName?.Contains("ObjectType") == true && getObjectType == null)
                            getObjectType = mr;
                        if (mr.Name == "get_ControlType" && mr.MethodSig?.RetType?.FullName?.Contains("ControlType") == true && getControlType == null)
                            getControlType = mr;
                        if (mr.Name == "get_IsPalladiomKeypad" && mr.MethodSig?.RetType?.FullName == "System.Boolean" && getIsPalladiomKeypad == null)
                            getIsPalladiomKeypad = mr;
                    }
                }
            }
        }

        var csdMV = mod.GetTypes().FirstOrDefault(t => t.Name == "ControlStationDeviceModelView");
        var supProp = csdMV?.FindMethod("get_SupportsActiveInactiveIntensity");

        if (supProp?.Body != null && getObjectType != null)
        {
            // Log: "MV.SupportsAII: OT=<ObjectType> CT=<ControlType> Pall=<IsPalladiomKeypad>\r\n"
            var instrs = supProp.Body.Instructions;
            int ins = 0;
            var firstOriginal = instrs[0];

            instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));

            // Build string array with 7 elements
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_7));
            instrs.Insert(ins++, new Instruction(OpCodes.Newarr, mod.CorLibTypes.String.ToTypeDefOrRef()));
            // [0] = "MV.SupportsAII: OT="
            instrs.Insert(ins++, new Instruction(OpCodes.Dup));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_0));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "MV.SupportsAII: OT="));
            instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            // [1] = this.ObjectType.ToString()
            instrs.Insert(ins++, new Instruction(OpCodes.Dup));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_1));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldarg_0));
            instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getObjectType));
            instrs.Insert(ins++, new Instruction(OpCodes.Box, getObjectType.MethodSig.RetType.ToTypeDefOrRef()));
            instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, objToString));
            instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            // [2] = " CT="
            instrs.Insert(ins++, new Instruction(OpCodes.Dup));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_2));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, " CT="));
            instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            // [3] = this.ControlType.ToString()
            if (getControlType != null)
            {
                instrs.Insert(ins++, new Instruction(OpCodes.Dup));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_3));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldarg_0));
                instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getControlType));
                instrs.Insert(ins++, new Instruction(OpCodes.Box, getControlType.MethodSig.RetType.ToTypeDefOrRef()));
                instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, objToString));
                instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            }
            else
            {
                instrs.Insert(ins++, new Instruction(OpCodes.Dup));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_3));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "?"));
                instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            }
            // [4] = " Pall="
            instrs.Insert(ins++, new Instruction(OpCodes.Dup));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_4));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, " Pall="));
            instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            // [5] = this.IsPalladiomKeypad.ToString()  (on DeviceModelViewBase)
            if (getIsPalladiomKeypad != null)
            {
                instrs.Insert(ins++, new Instruction(OpCodes.Dup));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_5));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldarg_0));
                instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getIsPalladiomKeypad));
                instrs.Insert(ins++, new Instruction(OpCodes.Box, mod.CorLibTypes.Boolean.ToTypeDefOrRef()));
                instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, objToString));
                instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            }
            else
            {
                instrs.Insert(ins++, new Instruction(OpCodes.Dup));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_5));
                instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "?"));
                instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            }
            // [6] = "\r\n"
            instrs.Insert(ins++, new Instruction(OpCodes.Dup));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_6));
            instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "\r\n"));
            instrs.Insert(ins++, new Instruction(OpCodes.Stelem_Ref));
            // String.Concat(string[])
            instrs.Insert(ins++, new Instruction(OpCodes.Call, strConcat4));
            instrs.Insert(ins++, new Instruction(OpCodes.Call, appendAllText));

            // Wrap in try-catch
            var tryStart = instrs[0];
            var tryLeave = new Instruction(OpCodes.Leave, firstOriginal);
            var catchPop = new Instruction(OpCodes.Pop);
            var catchLeave = new Instruction(OpCodes.Leave, firstOriginal);
            instrs.Insert(ins++, tryLeave);
            instrs.Insert(ins++, catchPop);
            instrs.Insert(ins++, catchLeave);
            supProp.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
            {
                TryStart = tryStart, TryEnd = catchPop,
                HandlerStart = catchPop, HandlerEnd = firstOriginal,
                CatchType = new TypeRefUser(mod, "System", "Exception", corlib)
            });

            Report("SN", "ModelViews.dll", true, "IVT stripped + SupportsAII diagnostic (OT+CT+Pall)");
        }
        else
        {
            Report("SN", "ModelViews.dll", true, "IVT stripped (no diagnostic - method/refs not found)");
        }

        // FIX: Patch get_IsPalladiomKeypad on DeviceModelViewBase to also return true for RFDart (Sunnata)
        // Original: return DomainDevice.IsPalladiomKeypad (delegates to ModelInfo.IsPalladiomKeypad())
        // Patched:  if (original) return true; return DomainDevice.IsRFDartKeypad;
        var devMVBase = mod.GetTypes().FirstOrDefault(t => t.Name == "DeviceModelViewBase");
        var pallProp = devMVBase?.FindMethod("get_IsPalladiomKeypad");
        if (pallProp?.Body != null)
        {
            var pInstrs = pallProp.Body.Instructions;

            // Find get_IsRFDartKeypad from DomainDeviceBase (referenced in existing IL somewhere)
            IMethodDefOrRef? getIsRFDart = null;
            foreach (var t in mod.GetTypes())
            {
                foreach (var m in t.Methods)
                {
                    if (m.Body == null) continue;
                    foreach (var instr in m.Body.Instructions)
                    {
                        if ((instr.OpCode == OpCodes.Callvirt || instr.OpCode == OpCodes.Call)
                            && instr.Operand is IMethodDefOrRef mr && mr.Name == "get_IsRFDartKeypad")
                        {
                            getIsRFDart = mr;
                            break;
                        }
                    }
                    if (getIsRFDart != null) break;
                }
                if (getIsRFDart != null) break;
            }

            if (getIsRFDart != null)
            {
                // The method IL is roughly: ldarg.0, call get_DomainDevice, callvirt get_IsPalladiomKeypad, ret
                // Find the ret instruction
                var retInstr = pInstrs.Last(i => i.OpCode == OpCodes.Ret);
                int retIdx = pInstrs.IndexOf(retInstr);

                // Insert before ret: if result is true, return true. Otherwise, check IsRFDartKeypad.
                // Stack at this point has the bool result from IsPalladiomKeypad.
                // brtrue.s trueLabel  (if IsPalladiomKeypad was true, skip to return true)
                // ldarg.0
                // call/callvirt get_DomainDevice (find from existing IL)
                // callvirt get_IsRFDartKeypad
                // ret
                // trueLabel: ldc.i4.1
                // ret

                // Find get_DomainDevice or the property accessor used to get the domain device
                // Look at the existing IL: it should be ldarg.0, call get_X, callvirt get_IsPalladiomKeypad
                IMethodDefOrRef? getDomainDevice = null;
                for (int i = 0; i < pInstrs.Count; i++)
                {
                    if ((pInstrs[i].OpCode == OpCodes.Call || pInstrs[i].OpCode == OpCodes.Callvirt)
                        && pInstrs[i].Operand is IMethodDefOrRef mr
                        && (mr.Name == "get_IsPalladiomKeypad" || mr.Name == "get_DomainDevice"
                            || mr.Name == "get_AssignableObject"))
                    {
                        // The instruction before this should load the domain device
                        if (mr.Name == "get_IsPalladiomKeypad" && i > 0
                            && (pInstrs[i - 1].OpCode == OpCodes.Call || pInstrs[i - 1].OpCode == OpCodes.Callvirt))
                        {
                            getDomainDevice = pInstrs[i - 1].Operand as IMethodDefOrRef;
                        }
                    }
                }

                if (getDomainDevice != null)
                {
                    // Before the ret, the stack has: bool (IsPalladiomKeypad result)
                    // Insert: brtrue trueLabel; ldarg.0; call getDomainDevice; callvirt get_IsRFDartKeypad; ret; trueLabel: ldc.i4.1; ret
                    var trueLabel = new Instruction(OpCodes.Ldc_I4_1);
                    var newRet = new Instruction(OpCodes.Ret);

                    pInstrs.Insert(retIdx, new Instruction(OpCodes.Brtrue, trueLabel));
                    pInstrs.Insert(retIdx + 1, new Instruction(OpCodes.Ldarg_0));
                    pInstrs.Insert(retIdx + 2, new Instruction(getDomainDevice.ResolveMethodDef()?.IsVirtual == true ? OpCodes.Callvirt : OpCodes.Call, getDomainDevice));
                    pInstrs.Insert(retIdx + 3, new Instruction(OpCodes.Callvirt, getIsRFDart));
                    // retInstr is now at retIdx + 4
                    pInstrs.Insert(retIdx + 5, trueLabel);
                    pInstrs.Insert(retIdx + 6, newRet);

                    Report("SN", "FixPalladiom", true, "get_IsPalladiomKeypad: added || IsRFDartKeypad for Sunnata");
                }
                else
                {
                    Report("SN", "FixPalladiom", false, "could not find getDomainDevice accessor in IsPalladiomKeypad IL");
                }
            }
            else
            {
                Report("SN", "FixPalladiom", false, "get_IsRFDartKeypad not found in module");
            }
        }

        SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.ModelViews.dll"), keepOldMaxStack: false);
    }
}

// ============================================================
// 4. InfoObjects.dll — register DKP for per-preset backlight intensity
// ============================================================
Console.WriteLine("--- InfoObjects.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.InfoObjects.dll");
    using var mod = ModuleDefMD.Load(path);

    var ctRef = mod.Find("Lutron.Gulliver.InfoObjects.ReferenceInfo.ControlTypeCommandTypeParameterTypeReference", false)
        ?? throw new Exception("ControlTypeCommandTypeParameterTypeReference not found");

    // --- Patch 4a: LoadControlTypeCommandGroupDictionary — add DKP + BacklightIntensity/StatusIntensity ---
    {
        var method = ctRef.FindMethod("LoadControlTypeCommandGroupDictionary")
            ?? throw new Exception("LoadControlTypeCommandGroupDictionary not found");
        if (method.Body == null) throw new Exception("method has no body");

        var addMethod = ctRef.FindMethod("AddListOfCommandGroupsToControlTypeDictionary")
            ?? throw new Exception("AddListOfCommandGroupsToControlTypeDictionary not found");

        // Find the ControlType.DKP enum value and AssignmentCommandGroup values
        // from existing IL: DKP=0x22(34), BacklightIntensity=0x27(39), StatusIntensity=0x28(40)
        var instrs = method.Body.Instructions;
        var retInstr = instrs.Last(i => i.OpCode == OpCodes.Ret);
        int retIdx = instrs.IndexOf(retInstr);

        // Insert before ret: ldarg.0, ldc.i4.s DKP, ldc.i4.s BacklightIntensity, call
        instrs.Insert(retIdx, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(retIdx + 1, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));   // DKP
        instrs.Insert(retIdx + 2, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x27));   // BacklightIntensity
        instrs.Insert(retIdx + 3, new Instruction(OpCodes.Call, addMethod));
        // Insert: ldarg.0, ldc.i4.s DKP, ldc.i4.s StatusIntensity, call
        instrs.Insert(retIdx + 4, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(retIdx + 5, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));   // DKP
        instrs.Insert(retIdx + 6, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x28));   // StatusIntensity
        instrs.Insert(retIdx + 7, new Instruction(OpCodes.Call, addMethod));

        Report("IO", "CmdGroupDict", true, "added DKP BacklightIntensity+StatusIntensity");
    }

    // --- Patch 4b: LoadMappingInformation — register DKP command params + display values ---
    {
        var method = ctRef.FindMethod("LoadMappingInformation")
            ?? throw new Exception("LoadMappingInformation not found");
        if (method.Body == null) throw new Exception("method has no body");

        var addCmdParams = ctRef.Methods.First(m => m.Name == "AddCommandParametersToCommandType");
        var addDisplayParams = ctRef.Methods.First(m => m.Name == "AddPossibleDisplayParametersToControlTypeCommandType");
        var addDisplayValues = ctRef.Methods.First(m => m.Name == "AddListOfDisplayValuesToControlCommandDictionary");

        var instrs = method.Body.Instructions;

        // Find the last AddListOfDisplayValuesToControlCommandDictionary call for AlisseKeypad(0x30)
        // Search backwards for the last such call with AlisseKeypad as a ControlType arg
        int insertIdx = -1;
        int lastAlisseDisplayCall = -1;
        for (int i = instrs.Count - 1; i >= 0; i--)
        {
            if (instrs[i].OpCode == OpCodes.Call && instrs[i].Operand is IMethodDefOrRef m
                && m.Name == "AddListOfDisplayValuesToControlCommandDictionary")
            {
                bool hasAlisse = false;
                for (int j = i - 1; j >= i - 6 && j >= 0; j--)
                {
                    if (instrs[j].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[j].Operand == 0x30)
                        hasAlisse = true;
                }
                if (hasAlisse && lastAlisseDisplayCall < 0)
                {
                    lastAlisseDisplayCall = i;
                    insertIdx = i + 1;
                    break;
                }
            }
        }

        if (insertIdx < 0) throw new Exception("AlisseKeypad+SetStatusIntensity insertion point not found");

        // The local variable 'val' (parameter list) is still valid here.
        // Find which local holds 'val' and 'parameterValueDisplayList' by looking at the preceding stloc/ldloc
        // val is the List<AssignmentCommandParameterType> — find from AddCommandParametersToCommandType call for AlisseKeypad
        Local? valLocal = null;
        Local? displayListLocal = null;
        for (int i = insertIdx - 1; i >= insertIdx - 30 && i >= 0; i--)
        {
            if (instrs[i].OpCode == OpCodes.Call && instrs[i].Operand is IMethodDefOrRef m2)
            {
                if (m2.Name == "AddCommandParametersToCommandType")
                {
                    // The 3rd arg (val) is the ldloc right before this call - 1 position
                    for (int j = i - 1; j >= i - 4; j--)
                    {
                        if ((instrs[j].OpCode == OpCodes.Ldloc || instrs[j].OpCode == OpCodes.Ldloc_S
                            || instrs[j].OpCode == OpCodes.Ldloc_0 || instrs[j].OpCode == OpCodes.Ldloc_1
                            || instrs[j].OpCode == OpCodes.Ldloc_2 || instrs[j].OpCode == OpCodes.Ldloc_3)
                            && valLocal == null)
                        {
                            valLocal = instrs[j].GetLocal(method.Body.Variables);
                            break;
                        }
                    }
                    break;
                }
            }
        }
        // Find displayListLocal from the stloc after AddPossibleDisplayParametersToControlTypeCommandType
        for (int i = insertIdx - 1; i >= insertIdx - 15 && i >= 0; i--)
        {
            if (instrs[i].OpCode == OpCodes.Call && instrs[i].Operand is IMethodDefOrRef m3
                && m3.Name == "AddPossibleDisplayParametersToControlTypeCommandType")
            {
                // Next instruction should be stloc for displayListLocal
                if (i + 1 < instrs.Count)
                {
                    var stloc = instrs[i + 1];
                    if (stloc.IsStloc())
                        displayListLocal = stloc.GetLocal(method.Body.Variables);
                }
                break;
            }
        }

        if (valLocal == null) throw new Exception("val local variable not found");
        if (displayListLocal == null) throw new Exception("displayListLocal variable not found");

        // AssignmentCommandType.SetBacklightIntensity and SetStatusIntensity enum values
        // Find from IL: the two calls to AddCommandParametersToCommandType with AlisseKeypad(0x30)
        // Pattern: ldarg.0, ldc.i4.s 0x30, ldc.i4.s ACT, ldloc val, call AddCommandParametersToCommandType
        var alisseCmdTypes = new List<sbyte>();
        for (int i = 0; i < instrs.Count; i++)
        {
            if (instrs[i].OpCode == OpCodes.Call && instrs[i].Operand is IMethodDefOrRef m4
                && m4.Name == "AddCommandParametersToCommandType")
            {
                // Scan back for AlisseKeypad(0x30) and the command type
                for (int j = i - 1; j >= i - 5 && j >= 0; j--)
                {
                    if (instrs[j].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[j].Operand == 0x30)
                    {
                        // The next ldc after AlisseKeypad is the CommandType
                        if (j + 1 < i && instrs[j + 1].OpCode == OpCodes.Ldc_I4_S)
                            alisseCmdTypes.Add((sbyte)instrs[j + 1].Operand);
                        break;
                    }
                }
            }
        }

        // SetBacklightIntensity=0x3c(60), SetStatusIntensity=0x3d(61) — from AddPossibleDisplayParametersToControlTypeCommandType
        // Verify by checking the AddListOfDisplayValues calls for KeyPad(0x13) near the end of the method
        sbyte setBacklightIntensityVal = 0x3c;
        sbyte setStatusIntensityVal = 0x3d;
        bool verified = false;
        for (int i = 0; i < instrs.Count; i++)
        {
            if (instrs[i].OpCode == OpCodes.Call && instrs[i].Operand is IMethodDefOrRef m5
                && m5.Name == "AddListOfDisplayValuesToControlCommandDictionary")
            {
                // Look for KeyPad(0x13) + 0x3c pattern
                bool hasKeyPad = false, hasTarget = false;
                for (int j = i - 1; j >= i - 6 && j >= 0; j--)
                {
                    if (instrs[j].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[j].Operand == 0x13) hasKeyPad = true;
                    if (instrs[j].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[j].Operand == 0x3c) hasTarget = true;
                }
                if (hasKeyPad && hasTarget) { verified = true; break; }
            }
        }
        if (!verified) throw new Exception("SetBacklightIntensity(0x3c) command type not verified in IL");

        // Now insert 6 calls for DKP at insertIdx
        int ins = insertIdx;

        // AddCommandParametersToCommandType(DKP, SetBacklightIntensity, val)
        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));  // DKP
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setBacklightIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldloc, valLocal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addCmdParams));

        // parameterValueDisplayList = AddPossibleDisplayParametersToControlTypeCommandType(DKP, SetBacklightIntensity)
        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setBacklightIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addDisplayParams));
        instrs.Insert(ins++, new Instruction(OpCodes.Stloc, displayListLocal));

        // AddListOfDisplayValuesToControlCommandDictionary(list, DKP, SetBacklightIntensity)
        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldloc, displayListLocal));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setBacklightIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addDisplayValues));

        // Same 3 calls for SetStatusIntensity
        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setStatusIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldloc, valLocal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addCmdParams));

        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setStatusIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addDisplayParams));
        instrs.Insert(ins++, new Instruction(OpCodes.Stloc, displayListLocal));

        instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
        instrs.Insert(ins++, new Instruction(OpCodes.Ldloc, displayListLocal));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4_S, setStatusIntensityVal));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, addDisplayValues));

        Report("IO", "MappingInfo", true, $"added DKP SetBacklightIntensity({setBacklightIntensityVal})+SetStatusIntensity({setStatusIntensityVal})");
    }

    // --- Patch 4c: AddPossibleDisplayParametersToControlTypeCommandType — treat DKP like AlisseKeypad ---
    {
        var method = ctRef.FindMethod("AddPossibleDisplayParametersToControlTypeCommandType")
            ?? throw new Exception("AddPossibleDisplayParametersToControlTypeCommandType not found");
        if (method.Body == null) throw new Exception("method has no body");

        var instrs = method.Body.Instructions;
        // The switch statement has: case ControlType.AlisseKeypad (0x30)
        // Inside SetBacklightIntensity and SetStatusIntensity: if (controlType == AlisseKeypad)
        // Change these to: if (controlType == AlisseKeypad || controlType == DKP)
        //
        // IL pattern: ldarg.1, ldc.i4.s 0x30, beq/bne.un target
        // Change to: ldarg.1, ldc.i4.s 0x30, beq OK, ldarg.1, ldc.i4.s 0x22, beq OK, br original_else
        int patchCount = 0;
        for (int i = 0; i < instrs.Count - 2; i++)
        {
            // Look for: ldarg.1, ldc.i4.s 0x30, bne.un.s (skip Alisse path)
            // This is the "if (controlType == AlisseKeypad)" check in SetBacklightIntensity/SetStatusIntensity
            if (instrs[i].OpCode == OpCodes.Ldarg_1
                && instrs[i + 1].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[i + 1].Operand == 0x30
                && (instrs[i + 2].OpCode == OpCodes.Bne_Un_S || instrs[i + 2].OpCode == OpCodes.Bne_Un))
            {
                // This is: if (controlType != AlisseKeypad) goto elseLabel
                // We want: if (controlType != AlisseKeypad && controlType != DKP) goto elseLabel
                // Rewrite as: if (controlType == AlisseKeypad) goto thenLabel; if (controlType != DKP) goto elseLabel; thenLabel:
                var elseTarget = (Instruction)instrs[i + 2].Operand;
                var thenTarget = instrs[i + 3]; // the instruction after the branch = start of Alisse path

                // Replace: ldarg.1, ldc.i4.s 0x30, bne.un.s elseTarget
                // With:    ldarg.1, ldc.i4.s 0x30, beq.s thenTarget, ldarg.1, ldc.i4.s 0x22, bne.un.s elseTarget
                instrs[i + 2].OpCode = OpCodes.Beq_S;
                instrs[i + 2].Operand = thenTarget;
                instrs.Insert(i + 3, OpCodes.Ldarg_1.ToInstruction());
                instrs.Insert(i + 4, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));  // DKP
                instrs.Insert(i + 5, new Instruction(OpCodes.Bne_Un_S, elseTarget));
                patchCount++;
                i += 5; // skip inserted instructions
            }
        }

        // Also add DKP to the outer switch case list (where AlisseKeypad falls through)
        // Find: ldc.i4.s 0x30 followed by br/beq to the common handler
        // This is in the main switch statement. The switch case for AlisseKeypad jumps to the same handler
        // as KeyPad, Dimmer, Switch, etc. We need DKP to also jump there.
        // Actually, DKP (0x22) already has KeyPadLockState in the switch, so it might already be in the right case.
        // The switch handles GoToLockState for DKP already. We just need the SetBacklightIntensity/SetStatusIntensity
        // branches inside to treat DKP like AlisseKeypad, which the above patches handle.

        Report("IO", "DisplayParams", patchCount > 0, $"patched {patchCount} AlisseKeypad conditions to include DKP");
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.InfoObjects.dll"));
    Report("IO", "write", true, "saved");
}
catch (Exception ex) { Report("IO", "error", false, ex.Message); }

// ============================================================
// 5. QuantumResi.dll — add DKP to preset assignment creation
// ============================================================
Console.WriteLine("--- QuantumResi.dll (preset creation) ---");
try
{
    // Reload since we already saved it above for other patches
    var path = Path.Combine(outDir, "Lutron.Gulliver.QuantumResi.dll");
    if (!File.Exists(path))
        path = Path.Combine(srcDir, "Lutron.Gulliver.QuantumResi.dll");
    using var mod = ModuleDefMD.Load(path);

    var treeVM = FindType(mod, "AssignableObjectTreeViewModel")
        ?? throw new Exception("AssignableObjectTreeViewModel not found");
    var method = treeVM.FindMethod("GetNewPresetAssignmentForAssignableObject")
        ?? throw new Exception("GetNewPresetAssignmentForAssignableObject not found");
    if (method.Body == null) throw new Exception("method has no body");

    var instrs = method.Body.Instructions;

    // Find: controlType == KeyPad(0x13) || controlType == AlisseKeypad(0x30)
    // IL pattern: ldXXX (controlType), ldc.i4.s 0x13, beq target, ldXXX, ldc.i4.s 0x30, beq/bne target
    // Add: || controlType == DKP(0x22)
    bool patched = false;
    for (int i = 0; i < instrs.Count - 5; i++)
    {
        if (instrs[i].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[i].Operand == 0x13  // KeyPad
            && (instrs[i + 1].OpCode == OpCodes.Beq_S || instrs[i + 1].OpCode == OpCodes.Beq))
        {
            var passTarget = (Instruction)instrs[i + 1].Operand;

            // Find the AlisseKeypad check nearby (within next 5 instructions)
            for (int j = i + 2; j < i + 8 && j < instrs.Count - 1; j++)
            {
                if (instrs[j].OpCode == OpCodes.Ldc_I4_S && (sbyte)instrs[j].Operand == 0x30  // AlisseKeypad
                    && (instrs[j + 1].OpCode == OpCodes.Bne_Un_S || instrs[j + 1].OpCode == OpCodes.Bne_Un))
                {
                    var failTarget = (Instruction)instrs[j + 1].Operand;

                    // Change AlisseKeypad bne_un to beq passTarget, then add DKP check
                    // Use long branches to avoid "too far for short branch" errors
                    instrs[j + 1].OpCode = OpCodes.Beq;
                    instrs[j + 1].Operand = passTarget;

                    // Insert after: load object + callvirt ControlType, ldc.i4.s 0x22, bne.un failTarget
                    // j-2 = load assignableObjectModelView (ldarg.1), j-1 = callvirt get_ControlType
                    instrs.Insert(j + 2, new Instruction(instrs[j - 2].OpCode, instrs[j - 2].Operand));
                    instrs.Insert(j + 3, new Instruction(instrs[j - 1].OpCode, instrs[j - 1].Operand));
                    instrs.Insert(j + 4, new Instruction(OpCodes.Ldc_I4_S, (sbyte)0x22));  // DKP
                    instrs.Insert(j + 5, new Instruction(OpCodes.Bne_Un, failTarget));

                    patched = true;
                    break;
                }
            }
            if (patched) break;
        }
    }

    Report("QR", "PresetCreation", patched, patched ? "added DKP to KeyPad||AlisseKeypad condition" : "pattern not found");

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.QuantumResi.dll"));
    Report("QR", "write(2)", true, "saved with preset creation patch");
}
catch (Exception ex) { Report("QR", "PresetCreation", false, ex.Message); }

// ============================================================
// 6. QuantumResi.dll — diagnostic: log backlight intensity lookups
// ============================================================
Console.WriteLine("--- QuantumResi.dll (diagnostics) ---");
try
{
    var path = Path.Combine(outDir, "Lutron.Gulliver.QuantumResi.dll");
    using var mod = ModuleDefMD.Load(path);

    var handler = FindType(mod, "QSDevicesAssignableObjectHandler")
        ?? throw new Exception("QSDevicesAssignableObjectHandler not found");

    // Patch GetBacklightIntensityValues to log ControlType + result count
    var method = handler.Methods.First(m => m.Name == "GetBacklightIntensityValues");
    if (method.Body == null) throw new Exception("method has no body");

    var instrs = method.Body.Instructions;

    var corlib = mod.CorLibTypes.AssemblyRef;
    var systemRuntime = mod.GetAssemblyRef(new UTF8String("System.Runtime")) ?? corlib;

    // File.AppendAllText(string path, string contents)
    var fileType = new TypeRefUser(mod, "System.IO", "File", systemRuntime);
    var appendAllText = new MemberRefUser(mod, "AppendAllText",
        MethodSig.CreateStatic(mod.CorLibTypes.Void, mod.CorLibTypes.String, mod.CorLibTypes.String), fileType);

    // Object.ToString()
    var objectToString = new MemberRefUser(mod, "ToString",
        MethodSig.CreateInstance(mod.CorLibTypes.String),
        new TypeRefUser(mod, "System", "Object", corlib));

    // String.Concat(string, string, string)
    var stringConcat3 = new MemberRefUser(mod, "Concat",
        MethodSig.CreateStatic(mod.CorLibTypes.String, mod.CorLibTypes.String, mod.CorLibTypes.String, mod.CorLibTypes.String),
        new TypeRefUser(mod, "System", "String", corlib));

    // Find get_ControlType from existing IL references in the class
    // GetLevelValueCollectionInternal calls assignableObjectModelView.ControlType
    IMethodDefOrRef? getControlType = null;
    foreach (var m in handler.Methods)
    {
        if (m.Body == null) continue;
        foreach (var instr in m.Body.Instructions)
        {
            if ((instr.OpCode == OpCodes.Callvirt || instr.OpCode == OpCodes.Call)
                && instr.Operand is IMethodDefOrRef mref && mref.Name == "get_ControlType")
            {
                getControlType = mref;
                break;
            }
        }
        if (getControlType != null) break;
    }

    // Find the ControlType enum type for boxing from the method's return type
    TypeSig? controlTypeSig = getControlType?.MethodSig?.RetType;

    if (getControlType != null && controlTypeSig != null)
    {
        int ins = 0;
        var firstOriginal = instrs[0];

        // File.AppendAllText(@"C:\temp-patch\diag.txt", "BLI: CT=" + arg1.ControlType.ToString() + "\r\n")
        instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "BLI: CT="));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldarg_1));
        instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getControlType));
        instrs.Insert(ins++, new Instruction(OpCodes.Box, controlTypeSig.ToTypeDefOrRef()));
        instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, objectToString));
        instrs.Insert(ins++, new Instruction(OpCodes.Ldstr, "\r\n"));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, stringConcat3));
        instrs.Insert(ins++, new Instruction(OpCodes.Call, appendAllText));

        // Wrap in try-catch so diagnostics never crash the app
        var tryStart = instrs[0];
        var tryLeave = new Instruction(OpCodes.Leave, firstOriginal);
        var catchPop = new Instruction(OpCodes.Pop);
        var catchLeave = new Instruction(OpCodes.Leave, firstOriginal);
        instrs.Insert(ins++, tryLeave);
        instrs.Insert(ins++, catchPop);
        instrs.Insert(ins++, catchLeave);

        method.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
        {
            TryStart = tryStart,
            TryEnd = catchPop,
            HandlerStart = catchPop,
            HandlerEnd = firstOriginal,
            CatchType = new TypeRefUser(mod, "System", "Exception", corlib)
        });

        Report("QR", "DiagBLI", true, "GetBacklightIntensityValues logging added");
    }
    else
    {
        Report("QR", "DiagBLI", false, "could not resolve get_ControlType from existing IL");
    }

    var treeVM = FindType(mod, "AssignableObjectTreeViewModel")
        ?? throw new Exception("AssignableObjectTreeViewModel not found");

    // Instrument get_BacklightIntensityCollection to see if it's ever called
    {
        var bliProp = treeVM.FindMethod("get_BacklightIntensityCollection");
        if (bliProp?.Body != null)
        {
            var bInstrs = bliProp.Body.Instructions;
            var bFirst = bInstrs[0];
            int bi = 0;
            // Simple: File.AppendAllText(path, "BLI_PROP called\r\n")
            bInstrs.Insert(bi++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));
            bInstrs.Insert(bi++, new Instruction(OpCodes.Ldstr, "BLI_PROP: get_BacklightIntensityCollection called\r\n"));
            bInstrs.Insert(bi++, new Instruction(OpCodes.Call, appendAllText));
            // try-catch
            var bTryStart = bInstrs[0];
            var bTryLeave = new Instruction(OpCodes.Leave, bFirst);
            var bCatchPop = new Instruction(OpCodes.Pop);
            var bCatchLeave = new Instruction(OpCodes.Leave, bFirst);
            bInstrs.Insert(bi++, bTryLeave);
            bInstrs.Insert(bi++, bCatchPop);
            bInstrs.Insert(bi++, bCatchLeave);
            bliProp.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
            {
                TryStart = bTryStart, TryEnd = bCatchPop,
                HandlerStart = bCatchPop, HandlerEnd = bFirst,
                CatchType = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef)
            });
            Report("QR", "DiagBLIProp", true, "get_BacklightIntensityCollection logging added");
        }
    }

    // Patch GetNewPresetAssignmentForAssignableObject to log the ControlType and CmdGroup
    {
        var presetMethod = treeVM.FindMethod("GetNewPresetAssignmentForAssignableObject");
        if (presetMethod?.Body != null)
        {
            var pInstrs = presetMethod.Body.Instructions;
            // Find the ldc.i4.s 0x22 (DKP) we inserted in Section 5 — that's inside the KeyPad||AlisseKeypad||DKP block
            // Look for the first ldstr or ldc after the DKP check to insert our diagnostic
            // Actually, find "currentCmdGroupToCreateNewPresetAssignment" field load
            FieldDef? cmdGroupField = null;
            foreach (var f in treeVM.Fields)
            {
                if (f.Name == "currentCmdGroupToCreateNewPresetAssignment") { cmdGroupField = f; break; }
            }

            // Find get_ControlType from existing IL
            IMethodDefOrRef? getCT = null;
            foreach (var instr in pInstrs)
            {
                if ((instr.OpCode == OpCodes.Callvirt || instr.OpCode == OpCodes.Call)
                    && instr.Operand is IMethodDefOrRef mr && mr.Name == "get_ControlType")
                {
                    getCT = mr;
                    break;
                }
            }

            if (cmdGroupField != null && getCT != null)
            {
                // Find the start of the method body (after the first branch into the switch)
                // Insert at the very start of the method
                var firstInstr = pInstrs[0];
                int pi = 0;

                // File.AppendAllText(path, "PRESET: CT=" + arg1.ControlType + " CmdGrp=" + this.cmdGroup + "\r\n")
                var str5 = new MemberRefUser(mod, "Concat",
                    MethodSig.CreateStatic(mod.CorLibTypes.String,
                        new SZArraySig(mod.CorLibTypes.String)),
                    new TypeRefUser(mod, "System", "String", mod.CorLibTypes.AssemblyRef));

                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));

                // Build string array with 5 elements
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_5));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Newarr, mod.CorLibTypes.String.ToTypeDefOrRef()));
                // [0] = "PRESET: CT="
                pInstrs.Insert(pi++, new Instruction(OpCodes.Dup));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_0));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldstr, "PRESET: CT="));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Stelem_Ref));
                // [1] = arg1.ControlType.ToString()
                pInstrs.Insert(pi++, new Instruction(OpCodes.Dup));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_1));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldarg_1));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Callvirt, getCT));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Box, getCT.MethodSig.RetType.ToTypeDefOrRef()));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Callvirt, objectToString));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Stelem_Ref));
                // [2] = " CG="
                pInstrs.Insert(pi++, new Instruction(OpCodes.Dup));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_2));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldstr, " CG="));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Stelem_Ref));
                // [3] = this.currentCmdGroupToCreateNewPresetAssignment.ToString()
                pInstrs.Insert(pi++, new Instruction(OpCodes.Dup));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_3));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldarg_0));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldfld, cmdGroupField));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Box, cmdGroupField.FieldType.ToTypeDefOrRef()));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Callvirt, objectToString));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Stelem_Ref));
                // [4] = "\r\n"
                pInstrs.Insert(pi++, new Instruction(OpCodes.Dup));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldc_I4_4));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Ldstr, "\r\n"));
                pInstrs.Insert(pi++, new Instruction(OpCodes.Stelem_Ref));
                // String.Concat(string[])
                pInstrs.Insert(pi++, new Instruction(OpCodes.Call, str5));
                // File.AppendAllText
                pInstrs.Insert(pi++, new Instruction(OpCodes.Call, appendAllText));

                // try-catch
                var tryStart2 = pInstrs[0];
                var tryLeave2 = new Instruction(OpCodes.Leave, firstInstr);
                var catchPop2 = new Instruction(OpCodes.Pop);
                var catchLeave2 = new Instruction(OpCodes.Leave, firstInstr);
                pInstrs.Insert(pi++, tryLeave2);
                pInstrs.Insert(pi++, catchPop2);
                pInstrs.Insert(pi++, catchLeave2);

                presetMethod.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
                {
                    TryStart = tryStart2, TryEnd = catchPop2,
                    HandlerStart = catchPop2, HandlerEnd = firstInstr,
                    CatchType = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef)
                });

                Report("QR", "DiagPreset", true, "GetNewPresetAssignment logging added");
            }
        }
    }

    // Also patch RaisePropertyChangedEvents — insert BEFORE ldarg.0 so stack is empty
    var raiseMethod = treeVM.FindMethod("RaisePropertyChangedEvents");
    if (raiseMethod?.Body != null)
    {
        var rInstrs = raiseMethod.Body.Instructions;
        // Find "SelectedStatusIntensity" then walk backward to the ldarg.0 before it
        for (int i = 0; i < rInstrs.Count; i++)
        {
            if (rInstrs[i].OpCode == OpCodes.Ldstr && rInstrs[i].Operand is string s && s == "SelectedStatusIntensity")
            {
                // Walk back to find ldarg.0 (this) that precedes the RaisePropertyChangedEvent call
                int insertAt = i;
                for (int j = i - 1; j >= i - 3 && j >= 0; j--)
                {
                    if (rInstrs[j].OpCode == OpCodes.Ldarg_0) { insertAt = j; break; }
                }
                // Insert diagnostic BEFORE ldarg.0 so stack is empty
                rInstrs.Insert(insertAt, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));
                rInstrs.Insert(insertAt + 1, new Instruction(OpCodes.Ldstr, "RAISE: SupportsAII=true\r\n"));
                rInstrs.Insert(insertAt + 2, new Instruction(OpCodes.Call, appendAllText));

                // FIX: Also raise BacklightIntensityCollection and StatusIntensityCollection
                // The XAML binds to these but PropertyChanged is never raised, so WPF never re-reads them.
                // Find the RaisePropertyChangedEvent method reference from existing IL
                // (i shifted by 3 due to diagnostic insertion, search from insertAt+3 onward)
                IMethodDefOrRef? raiseEvent = null;
                for (int k = 0; k < rInstrs.Count; k++)
                {
                    if ((rInstrs[k].OpCode == OpCodes.Callvirt || rInstrs[k].OpCode == OpCodes.Call)
                        && rInstrs[k].Operand is IMethodDefOrRef mr
                        && mr.Name == "RaisePropertyChangedEvent")
                    {
                        raiseEvent = mr;
                        break;
                    }
                }

                if (raiseEvent != null)
                {
                    int fix = insertAt + 3; // after the diagnostic
                    // this.RaisePropertyChangedEvent("BacklightIntensityCollection")
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Ldarg_0));
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Ldstr, "BacklightIntensityCollection"));
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Callvirt, raiseEvent));
                    // this.RaisePropertyChangedEvent("StatusIntensityCollection")
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Ldarg_0));
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Ldstr, "StatusIntensityCollection"));
                    rInstrs.Insert(fix++, new Instruction(OpCodes.Callvirt, raiseEvent));

                    Report("QR", "FixCollectionNotify", true, "added BacklightIntensityCollection + StatusIntensityCollection PropertyChanged");
                }

                Report("QR", "DiagRaise", true, "RaisePropertyChangedEvents logging added (before ldarg.0)");
                break;
            }
        }
    }

    // Instrument get_SelectedProgramAction on AssignableObjectTreeViewModel
    {
        var spaProp = treeVM.FindMethod("get_SelectedProgramAction");
        if (spaProp?.Body != null)
        {
            var spaInstrs = spaProp.Body.Instructions;
            var spaFirst = spaInstrs[0];
            int si = 0;
            // Log: "SPA: <value>\r\n"
            // First call the original, then log the result. Actually, just log entry.
            spaInstrs.Insert(si++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));
            spaInstrs.Insert(si++, new Instruction(OpCodes.Ldstr, "SPA: get_SelectedProgramAction called\r\n"));
            spaInstrs.Insert(si++, new Instruction(OpCodes.Call, appendAllText));
            // try-catch
            var spaTryStart = spaInstrs[0];
            var spaTryLeave = new Instruction(OpCodes.Leave, spaFirst);
            var spaCatchPop = new Instruction(OpCodes.Pop);
            var spaCatchLeave = new Instruction(OpCodes.Leave, spaFirst);
            spaInstrs.Insert(si++, spaTryLeave);
            spaInstrs.Insert(si++, spaCatchPop);
            spaInstrs.Insert(si++, spaCatchLeave);
            spaProp.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
            {
                TryStart = spaTryStart, TryEnd = spaCatchPop,
                HandlerStart = spaCatchPop, HandlerEnd = spaFirst,
                CatchType = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef)
            });
            Report("QR", "DiagSPA", true, "get_SelectedProgramAction logging added");
        }
    }

    // Instrument get_SelectedAssignObjectType on AssignableObjectTreeViewModel
    {
        var saotProp = treeVM.FindMethod("get_SelectedAssignObjectType");
        if (saotProp?.Body != null)
        {
            var saotInstrs = saotProp.Body.Instructions;
            var saotFirst = saotInstrs[0];
            int si = 0;
            saotInstrs.Insert(si++, new Instruction(OpCodes.Ldstr, @"C:\temp-patch\diag.txt"));
            saotInstrs.Insert(si++, new Instruction(OpCodes.Ldstr, "SAOT: get_SelectedAssignObjectType called\r\n"));
            saotInstrs.Insert(si++, new Instruction(OpCodes.Call, appendAllText));
            var saotTryStart = saotInstrs[0];
            var saotTryLeave = new Instruction(OpCodes.Leave, saotFirst);
            var saotCatchPop = new Instruction(OpCodes.Pop);
            var saotCatchLeave = new Instruction(OpCodes.Leave, saotFirst);
            saotInstrs.Insert(si++, saotTryLeave);
            saotInstrs.Insert(si++, saotCatchPop);
            saotInstrs.Insert(si++, saotCatchLeave);
            saotProp.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
            {
                TryStart = saotTryStart, TryEnd = saotCatchPop,
                HandlerStart = saotCatchPop, HandlerEnd = saotFirst,
                CatchType = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef)
            });
            Report("QR", "DiagSAOT", true, "get_SelectedAssignObjectType logging added");
        }
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.QuantumResi.dll"), keepOldMaxStack: false);
    Report("QR", "write(3)", true, "saved with diagnostics (no KeepOldMaxStack)");
}
catch (Exception ex) { Report("QR", "diagnostics", false, ex.Message); }

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
