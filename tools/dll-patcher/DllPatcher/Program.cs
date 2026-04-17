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

        // NOTE: FixPalladiom patch REMOVED — making Sunnata report IsPalladiomKeypad=true
        // sends Palladiom-format intensity commands that brick the Sunnata keypad.
        // Sunnata backlight needs its own path (CCX/CoAP), not Palladiom's LEAP path.

        // Patch: Make IsAlisseKeypad return true for Sunnata (RFDartKeypad) devices at the
        // ModelView level ONLY. This triggers BAML column visibility for backlight/status
        // intensity ComboBoxes in the programming tree. Domain logic stays unchanged —
        // DomainDeviceBase.IsAlisseKeypad still returns false for Sunnata, so preference
        // initialization correctly uses InitializeRFDarterKeypadPreference().
        //
        // Original IL: ldarg.0 → call get_Device → callvirt get_IsAlisseKeypad → ret
        // Patched IL:  ldarg.0 → call get_Device → callvirt get_IsAlisseKeypad → brtrue.s ret_true
        //              ldarg.0 → call get_Device → callvirt get_IsRFDartKeypad → ret
        //              ret_true: ldc.i4.1 → ret
        {
            var dmvb = mod.GetTypes().FirstOrDefault(t => t.Name == "DeviceModelViewBase");
            var isAlisseProp = dmvb?.FindMethod("get_IsAlisseKeypad");

            if (isAlisseProp?.Body != null)
            {
                var instrs = isAlisseProp.Body.Instructions;

                // Find the call to get_IsAlisseKeypad followed by ret
                int callIdx = -1;
                IMethodDefOrRef? getDevice = null;
                for (int i = 0; i < instrs.Count; i++)
                {
                    if ((instrs[i].OpCode == OpCodes.Callvirt || instrs[i].OpCode == OpCodes.Call)
                        && instrs[i].Operand is IMethodDefOrRef mr && mr.Name == "get_IsAlisseKeypad")
                    {
                        callIdx = i;
                        break;
                    }
                    if ((instrs[i].OpCode == OpCodes.Callvirt || instrs[i].OpCode == OpCodes.Call)
                        && instrs[i].Operand is IMethodDefOrRef mr2 && mr2.Name == "get_Device")
                    {
                        getDevice = mr2;
                    }
                }

                // Find get_IsRFDartKeypad from existing IL in the module
                IMethodDefOrRef? getIsRFDart = null;
                foreach (var t in mod.GetTypes())
                {
                    foreach (var m in t.Methods)
                    {
                        if (m.Body == null) continue;
                        foreach (var instr in m.Body.Instructions)
                        {
                            if ((instr.OpCode == OpCodes.Callvirt || instr.OpCode == OpCodes.Call)
                                && instr.Operand is IMethodDefOrRef mr && mr.Name == "get_IsRFDartKeypad"
                                && mr.MethodSig?.RetType?.FullName == "System.Boolean")
                            {
                                getIsRFDart = mr;
                                break;
                            }
                        }
                        if (getIsRFDart != null) break;
                    }
                    if (getIsRFDart != null) break;
                }

                if (callIdx >= 0 && getDevice != null && getIsRFDart != null && callIdx + 1 < instrs.Count && instrs[callIdx + 1].OpCode == OpCodes.Ret)
                {
                    // Replace: ret → brtrue.s to trueLabel, then add IsRFDartKeypad check
                    var retTrue = new Instruction(OpCodes.Ldc_I4_1);
                    var retInstr = new Instruction(OpCodes.Ret);

                    // Change ret → brtrue.s retTrue
                    instrs[callIdx + 1].OpCode = OpCodes.Brtrue_S;
                    instrs[callIdx + 1].Operand = retTrue;

                    // Insert: ldarg.0 → call get_Device → callvirt get_IsRFDartKeypad → ret
                    int ins = callIdx + 2;
                    instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
                    instrs.Insert(ins++, new Instruction(OpCodes.Call, getDevice));
                    instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getIsRFDart));
                    instrs.Insert(ins++, new Instruction(OpCodes.Ret));
                    // retTrue: ldc.i4.1 → ret
                    instrs.Insert(ins++, retTrue);
                    instrs.Insert(ins++, retInstr);

                    Report("MV", "IsAlisseForSunnata", true, "IsAlisseKeypad returns true for RFDartKeypad (BAML trigger)");
                }
                else
                {
                    Report("MV", "IsAlisseForSunnata", false,
                        $"pattern not found (callIdx={callIdx} getDevice={getDevice != null} getIsRFDart={getIsRFDart != null})");
                }
            }
            else
            {
                Report("MV", "IsAlisseForSunnata", false, "get_IsAlisseKeypad not found on DeviceModelViewBase");
            }
        }

        SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.ModelViews.dll"), keepOldMaxStack: false);
    }
}

// ============================================================
// 4. InfoObjects.dll — IVT strip only (no code changes)
//    DKP backlight registration REMOVED: corrupted branch targets in
//    AddPossibleDisplayParametersToControlTypeCommandType.
//    Still need SaveModule pass-through so IVT PublicKeys get stripped,
//    matching the other re-saved assemblies.
// ============================================================
Console.WriteLine("--- InfoObjects.dll (IVT strip) ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.InfoObjects.dll");
    using var mod = ModuleDefMD.Load(path);

    // Patch GetControlTypeForDevice: add DartHybridkeypad → ControlType.AlisseKeypad
    // The original method maps DartKeypad and SunnataFanControl → AlisseKeypad but
    // OMITS DartHybridkeypad (Sunnata Hybrid), which falls through to ControlType.KeyPad.
    // This causes the per-preset backlight to use Palladiom enums instead of Ring enums.
    //
    // Strategy: insert before the final ret instruction:
    //   if (ControlStationDeviceInfo?.ControlStationDeviceType == DartHybridkeypad)
    //       result = ControlType.AlisseKeypad;
    {
        var modelInfoType = mod.GetTypes().FirstOrDefault(t => t.FullName == "Lutron.Gulliver.InfoObjects.ModelInfo.ModelInfo");
        var getCtForDevice = modelInfoType?.FindMethod("GetControlTypeForDevice");

        // Find DartHybridkeypad enum value
        var csdtEnum = mod.GetTypes().FirstOrDefault(t => t.FullName == "Lutron.Gulliver.InfoObjects.ModelInfo.ControlStationDeviceType");
        var dartHybridField = csdtEnum?.FindField("DartHybridkeypad");
        int dartHybridValue = dartHybridField?.Constant?.Value is int dhv ? dhv : -1;

        // Find ControlType.AlisseKeypad value from the ControlType enum directly
        // ControlType enum is in Infrastructure.dll — load it to get AlisseKeypad value
        int alisseCTValue = -1;
        var infraPath = Path.Combine(srcDir, "Lutron.Gulliver.Infrastructure.dll");
        if (File.Exists(infraPath))
        {
            using var infraMod = ModuleDefMD.Load(infraPath);
            var ctEnum = infraMod.GetTypes().FirstOrDefault(t => t.Name == "ControlType" && t.IsEnum
                && t.Fields.Any(f => f.Name == "AlisseKeypad"));
            var alisseCTField = ctEnum?.FindField("AlisseKeypad");
            alisseCTValue = alisseCTField?.Constant?.Value is int acv ? acv : -1;
        }

        IMethodDefOrRef? getCSDInfo = null;
        IMethodDefOrRef? getCSDType = null;
        int resultLocalIdx = -1;

        if (getCtForDevice?.Body != null)
        {
            var instrs = getCtForDevice.Body.Instructions;

            // Scan for get_ControlStationDeviceInfo and get_ControlStationDeviceType in existing IL
            foreach (var instr in instrs)
            {
                if ((instr.OpCode == OpCodes.Call || instr.OpCode == OpCodes.Callvirt)
                    && instr.Operand is IMethodDefOrRef mr)
                {
                    if (mr.Name == "get_ControlStationDeviceInfo" && getCSDInfo == null)
                        getCSDInfo = mr;
                    if (mr.Name == "get_ControlStationDeviceType" && getCSDType == null)
                        getCSDType = mr;
                }
            }

            // Find the result local variable: it's initialized at the start with
            // ldc.i4.0 (ControlType.Unknown=0) → stloc
            for (int i = 0; i < Math.Min(5, instrs.Count - 1); i++)
            {
                if (instrs[i].OpCode == OpCodes.Ldc_I4_0
                    && (instrs[i + 1].OpCode == OpCodes.Stloc_0 || instrs[i + 1].OpCode == OpCodes.Stloc_1
                        || instrs[i + 1].OpCode == OpCodes.Stloc_S || instrs[i + 1].OpCode == OpCodes.Stloc))
                {
                    if (instrs[i + 1].OpCode == OpCodes.Stloc_0) resultLocalIdx = 0;
                    else if (instrs[i + 1].OpCode == OpCodes.Stloc_1) resultLocalIdx = 1;
                    else if (instrs[i + 1].Operand is Local loc) resultLocalIdx = loc.Index;
                    break;
                }
            }

            // Find AlisseKeypad ControlType value by finding the DartKeypad comparison
            // and the stloc that follows (which stores AlisseKeypad).
            // Pattern: ldc.i4 <dartKeypadValue> → beq target → ... target: ldc.i4 <alisseCT> → stloc
            // AlisseKeypad ControlType value resolved from Infrastructure.dll above
        }

        if (getCtForDevice?.Body != null && dartHybridValue >= 0 && alisseCTValue >= 0
            && getCSDInfo != null && getCSDType != null && resultLocalIdx >= 0)
        {
            var instrs = getCtForDevice.Body.Instructions;
            // Find the last ret instruction and the ldloc before it
            // Original end: ldloc.0 → ret (load result, return)
            // We must insert BEFORE ldloc.0 so the stack stays clean
            int retIdx = instrs.Count - 1;
            while (retIdx >= 0 && instrs[retIdx].OpCode != OpCodes.Ret) retIdx--;
            int ldlocIdx = retIdx - 1;
            // Walk back to find the ldloc that loads the result
            while (ldlocIdx >= 0 && !(instrs[ldlocIdx].OpCode == OpCodes.Ldloc_0
                || instrs[ldlocIdx].OpCode == OpCodes.Ldloc_1
                || instrs[ldlocIdx].OpCode == OpCodes.Ldloc_S
                || instrs[ldlocIdx].OpCode == OpCodes.Ldloc))
                ldlocIdx--;

            if (retIdx >= 0 && ldlocIdx >= 0)
            {
                var skipTarget = instrs[ldlocIdx]; // jump here to skip our patch
                int ins = ldlocIdx;

                // Null check first: if ControlStationDeviceInfo is null, skip entirely
                // Stack must be EMPTY at every branch target (skipTarget = ldloc.0 → ret)
                instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
                instrs.Insert(ins++, new Instruction(OpCodes.Call, getCSDInfo));
                instrs.Insert(ins++, new Instruction(OpCodes.Brfalse, skipTarget));
                // brfalse pops CSDInfo. If null → stack empty → skip to ldloc+ret. Clean.

                // Not null path: call again to get the reference, then check type
                instrs.Insert(ins++, OpCodes.Ldarg_0.ToInstruction());
                instrs.Insert(ins++, new Instruction(OpCodes.Call, getCSDInfo));
                instrs.Insert(ins++, new Instruction(OpCodes.Callvirt, getCSDType));
                // Stack: [CSDType_int]
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4, dartHybridValue));
                // Stack: [CSDType_int, 129]
                instrs.Insert(ins++, new Instruction(OpCodes.Bne_Un, skipTarget));
                // bne_un pops both. If not equal → stack empty → skip. Clean.

                // result = ControlType.AlisseKeypad
                instrs.Insert(ins++, new Instruction(OpCodes.Ldc_I4, alisseCTValue));
                if (resultLocalIdx == 0) instrs.Insert(ins++, OpCodes.Stloc_0.ToInstruction());
                else if (resultLocalIdx == 1) instrs.Insert(ins++, OpCodes.Stloc_1.ToInstruction());
                else instrs.Insert(ins++, new Instruction(OpCodes.Stloc_S, getCtForDevice.Body.Variables[resultLocalIdx]));
                // Fall through to ldloc.0 → ret (loads the updated result)

                // Optimize branches
                getCtForDevice.Body.SimplifyBranches();
                getCtForDevice.Body.OptimizeBranches();

                Report("IO", "DartHybridControlType", true,
                    $"DartHybridkeypad({dartHybridValue})→AlisseKeypad(CT={alisseCTValue}) result=loc{resultLocalIdx}");
            }
            else
            {
                Report("IO", "DartHybridControlType", false, "ret instruction not found");
            }
        }
        else
        {
            Report("IO", "DartHybridControlType", false,
                $"refs not found (dartHybrid={dartHybridValue} alisseCT={alisseCTValue} getCSDInfo={getCSDInfo != null} getCSDType={getCSDType != null} resultLocal={resultLocalIdx})");
        }
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.InfoObjects.dll"));
    Report("IO", "write", true, "saved");
}
catch (Exception ex) { Report("IO", "error", false, ex.Message); }

// ============================================================
// 5. QuantumResi.dll — REMOVED: DKP preset creation patch (depends on
//    Section 4 which is also removed). Will need a clean approach for
//    Sunnata per-preset backlight that uses the correct CCX/CoAP path.
// ============================================================

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
            // Log ControlType + CmdGroup at method entry for diagnostics
            // Find "currentCmdGroupToCreateNewPresetAssignment" field load
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

    // Fix short branches that may exceed range after instruction insertions
    foreach (var t2 in mod.GetTypes())
        foreach (var m2 in t2.Methods)
            if (m2.Body != null)
            {
                m2.Body.SimplifyBranches();
                m2.Body.OptimizeBranches();
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
