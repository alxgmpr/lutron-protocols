// Dump every caller of a target function with its decompiled C body. Useful
// for enumerating the wrappers around a CCA packet allocator (FUN_0800fbd4)
// to reverse the (op, format, type, len) tuple each one writes.
//
// Usage:
//   ... -postScript DumpCallers.java <target-fn-addr-hex>
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.RefType;

import java.util.LinkedHashSet;
import java.util.Set;

public class DumpCallers extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] argv = getScriptArgs();
        if (argv == null || argv.length == 0) {
            println("usage: DumpCallers <addr>");
            return;
        }
        Address target = currentProgram.getAddressFactory().getAddress(argv[0]);
        FunctionManager fm = currentProgram.getFunctionManager();
        Function fn = fm.getFunctionContaining(target);
        if (fn == null) fn = fm.getFunctionAt(target);
        if (fn == null) { println("no function at " + target); return; }

        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);

        Set<Address> callers = new LinkedHashSet<>();
        ReferenceIterator refs = currentProgram.getReferenceManager().getReferencesTo(fn.getEntryPoint());
        while (refs.hasNext()) {
            Reference r = refs.next();
            RefType rt = r.getReferenceType();
            if (rt.isCall()) {
                Function callerFn = fm.getFunctionContaining(r.getFromAddress());
                if (callerFn != null) callers.add(callerFn.getEntryPoint());
            }
        }
        println("CALLERS_OF " + fn.getName() + "@" + fn.getEntryPoint() + ": " + callers.size());
        for (Address ca : callers) {
            Function cf = fm.getFunctionAt(ca);
            DecompileResults res = ifc.decompileFunction(cf, 60, monitor);
            String c = (res != null && res.decompileCompleted()) ? res.getDecompiledFunction().getC() : "<decomp failed>";
            println("CALL_BEGIN " + cf.getName() + "@" + cf.getEntryPoint());
            println(c);
            println("CALL_END");
        }
        ifc.dispose();
    }
}
