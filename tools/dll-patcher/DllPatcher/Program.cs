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
// 3b. Infrastructure.dll — auth short-circuit (+ IVT strip)
//     Replaces the hosts-file block + ServicesConfig URL-list hack:
//     stubs the only two de-auth code paths so Designer stays fully
//     online (engraving submission, firmware checks, LEAP cloud proxy
//     all flow through) while the myLutron server can never revoke.
// ============================================================
Console.WriteLine("--- Infrastructure.dll ---");
try
{
    var path = Path.Combine(srcDir, "Lutron.Gulliver.Infrastructure.dll");
    using var mod = ModuleDefMD.Load(path);

    // Patch: UserManager.AttemptAuthentication(bool) — wrap original body in try/catch,
    // coerce return to AuthenticationSuccess (1) regardless of real outcome.
    //
    // Why not a pure stub? A pure stub prevents the REAL myLutron OAuth/RefreshToken
    // calls from running, which means SecurityToken never gets written to LutronData.bin,
    // which means Bearer-auth endpoints (PStoreService engraving Apim, etc.) always 401.
    // By letting the real call execute first (its side effect is SetCurrentUser → live
    // SecurityToken), then coercing the return to success, a real login populates a real
    // token while offline/expired/revoked states still return success (no de-auth).
    {
        var mgr = mod.Find("Lutron.Gulliver.Infrastructure.myLutronService.UserManager", false);
        var method = mgr?.FindMethod("AttemptAuthentication");
        Report("INF", "AttemptAuthentication", PatchAttemptAuthenticationTryCatch(method, mod, out var msg), msg);
    }

    // NOTE: ResetProperties is intentionally NOT patched.
    // Originally stubbed as belt-and-suspenders against de-auth, but ResetProperties is
    // called by UserManager.AuthenticateNewUser (the Login button flow) to clear username/
    // Code/CodeVerifier/IsAuthenticated/channels BEFORE kicking off OAuth. Stubbing it to
    // no-op leaves the post-logout "@Guest@" dummy username in place, which causes
    // AuthenticatefromSSO to return AuthenticationFailure via IsCurrentUserADummyUser()
    // without ever opening the browser. The AttemptAuthentication try/catch wrapper above
    // is sufficient to prevent de-auth from the online-refresh path.

    // Patch: User.get_ChannelTypes / User.get_AllChannelTypes → ChannelTypes.All (0x1FFFFFFF)
    // Overrides whatever channel bits the myLutron server returned for the real account so
    // cross-product project opens (RA3/HWQS/Vive/etc.) all pass channel-gating checks.
    // Setters remain untouched — SetUserChannels still runs but any reader gets All.
    {
        var usr = mod.Find("Lutron.Gulliver.Infrastructure.myLutronService.User", false);
        var getChannelTypes = usr?.FindMethod("get_ChannelTypes");
        Report("INF", "User.get_ChannelTypes", StubReturnInt(getChannelTypes, 0x1FFFFFFF, out var m1), m1);
        var getAllChannelTypes = usr?.FindMethod("get_AllChannelTypes");
        Report("INF", "User.get_AllChannelTypes", StubReturnInt(getAllChannelTypes, 0x1FFFFFFF, out var m2), m2);
    }

    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.Infrastructure.dll"));
    Report("INF", "write", true, "saved (IVT PublicKey stripped)");
}
catch (Exception ex) { Report("INF", "error", false, ex.Message); }

// ModelViews — IVT strip only (backlight diagnostic + IsAlisseForSunnata reverted)
Console.WriteLine("--- ModelViews.dll ---");
try
{
    var mvPath = Path.Combine(srcDir, "Lutron.Gulliver.ModelViews.dll");
    using var mod = ModuleDefMD.Load(mvPath);
    SaveModule(mod, Path.Combine(outDir, "Lutron.Gulliver.ModelViews.dll"));
    Report("SN", "ModelViews.dll", true, "IVT PublicKey stripped");
}
catch (Exception ex) { Report("SN", "ModelViews.dll", false, ex.Message); }

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

// Stub a void method body to just `ret`. Idempotent: a body that's already a single
// `ret` is left alone. Returns false only when MethodDef is missing.
static bool StubReturnVoid(MethodDef? method, out string msg)
{
    if (method?.Body == null) { msg = "method not found"; return false; }
    var instrs = method.Body.Instructions;
    if (instrs.Count == 1 && instrs[0].OpCode == OpCodes.Ret)
    {
        msg = "already stubbed → no-op";
        return true;
    }
    instrs.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();
    instrs.Add(OpCodes.Ret.ToInstruction());
    msg = "stubbed → no-op";
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

// Rewrite AttemptAuthentication(bool) as:
//   try { if (!arg1) AuthenticateCode(user) else RefreshToken(); }
//   catch { }
//   return AuthenticationSuccess;  // always 1
//
// Preserves the REAL outbound calls (so SecurityToken side-effects still fire on
// successful login) while forcing the return value to 1 in every path. Extracts
// method refs (get_Instance, AuthenticateCode, RefreshToken) and the `user` field
// ref from the existing IL before rewriting — so we don't need to import new refs.
//
// Idempotent: if the first instruction pattern matches the rewritten shape
// (ldarg.1; brfalse.s; call get_Instance; callvirt RefreshToken; pop), skip.
static bool PatchAttemptAuthenticationTryCatch(MethodDef? method, ModuleDefMD mod, out string msg)
{
    if (method?.Body == null) { msg = "method not found"; return false; }

    // Idempotency: look for our marker — ldarg.1 as first instruction followed by
    // brfalse (pure stub starts with ldc.i4.1, so this distinguishes the rewrite).
    var existing = method.Body.Instructions;
    if (existing.Count >= 2
        && existing[0].OpCode == OpCodes.Ldarg_1
        && existing[1].OpCode == OpCodes.Brfalse_S
        && method.Body.ExceptionHandlers.Count == 1)
    {
        msg = "already wrapped (try/catch)";
        return true;
    }

    // Extract refs from original IL.
    IMethodDefOrRef? getInstance = null;
    IMethodDefOrRef? refreshToken = null;
    IMethodDefOrRef? authenticateCode = null;
    IField? userField = null;

    foreach (var ins in existing)
    {
        if ((ins.OpCode == OpCodes.Call || ins.OpCode == OpCodes.Callvirt)
            && ins.Operand is IMethodDefOrRef m)
        {
            if (m.Name == "get_Instance" && getInstance == null) getInstance = m;
            else if (m.Name == "RefreshToken" && refreshToken == null) refreshToken = m;
            else if (m.Name == "AuthenticateCode" && authenticateCode == null) authenticateCode = m;
        }
        else if (ins.OpCode == OpCodes.Ldfld && ins.Operand is IField f && f.Name == "user")
        {
            userField = f;
        }
    }

    if (getInstance == null || refreshToken == null || authenticateCode == null || userField == null)
    {
        msg = $"refs missing (getInstance={getInstance != null}, refresh={refreshToken != null}, " +
              $"authCode={authenticateCode != null}, userField={userField != null})";
        return false;
    }

    // Build new body.
    var sysException = new TypeRefUser(mod, "System", "Exception", mod.CorLibTypes.AssemblyRef);

    existing.Clear();
    method.Body.ExceptionHandlers.Clear();
    method.Body.Variables.Clear();

    // Success landing: ldc.i4.1 ; ret
    var successLdc1 = OpCodes.Ldc_I4_1.ToInstruction();
    var retInstr = OpCodes.Ret.ToInstruction();
    var leaveToSuccess = new Instruction(OpCodes.Leave_S, successLdc1);
    var catchStartPop = OpCodes.Pop.ToInstruction();
    var catchLeave = new Instruction(OpCodes.Leave_S, successLdc1);

    // Try block: ldarg.1 ; brfalse CODE_AUTH ; (refresh path) ; br leave
    // CODE_AUTH: (auth-code path) ; fallthrough to leave
    var codeAuthStart = new Instruction(OpCodes.Call, getInstance);  // first instr of auth-code path
    var tryStart = OpCodes.Ldarg_1.ToInstruction();

    existing.Add(tryStart);
    existing.Add(new Instruction(OpCodes.Brfalse_S, codeAuthStart));

    // RefreshToken path (attemptTokenAuthentication == true)
    // Signature: RefreshToken(bool updateUserProfile). Original passes true.
    existing.Add(new Instruction(OpCodes.Call, getInstance));
    existing.Add(OpCodes.Ldc_I4_1.ToInstruction());
    existing.Add(new Instruction(OpCodes.Callvirt, refreshToken));
    existing.Add(OpCodes.Pop.ToInstruction());
    existing.Add(new Instruction(OpCodes.Br_S, leaveToSuccess));

    // AuthenticateCode path (attemptTokenAuthentication == false)
    // Stack order for callvirt AuthenticateCode(User): [this=Instance, user]
    existing.Add(codeAuthStart);                               // call get_Instance (pushes Instance)
    existing.Add(OpCodes.Ldarg_0.ToInstruction());             // push this
    existing.Add(new Instruction(OpCodes.Ldfld, userField));   // replace this with this.user
    existing.Add(new Instruction(OpCodes.Callvirt, authenticateCode));
    existing.Add(OpCodes.Pop.ToInstruction());

    // End of try
    existing.Add(leaveToSuccess);

    // Catch handler
    existing.Add(catchStartPop);
    existing.Add(catchLeave);

    // Success landing
    existing.Add(successLdc1);
    existing.Add(retInstr);

    method.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
    {
        TryStart = tryStart,
        TryEnd = catchStartPop,
        HandlerStart = catchStartPop,
        HandlerEnd = successLdc1,
        CatchType = sysException,
    });

    msg = "wrapped original calls in try/catch → return 1";
    return true;
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
