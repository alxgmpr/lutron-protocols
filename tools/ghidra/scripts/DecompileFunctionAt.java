// Decompile the function containing the address passed via -postScript
// argument. Useful for headless triage when MCP is locked on another program.
//
// Usage:
//   tools/ghidra-headless.sh /tmp/proj name -process bin.bin -readOnly \
//     -postScript DecompileFunctionAt.java 0x0800bfec -scriptPath tools/ghidra-scripts
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;

public class DecompileFunctionAt extends GhidraScript {

    @Override
    public void run() throws Exception {
        String[] argv = getScriptArgs();
        if (argv == null || argv.length == 0) {
            println("usage: DecompileFunctionAt <addr-hex>");
            return;
        }
        Address addr = currentProgram.getAddressFactory().getAddress(argv[0]);
        Function fn = getFunctionContaining(addr);
        if (fn == null) {
            // Try create or look up nearest before
            fn = getFunctionAt(addr);
        }
        if (fn == null) {
            println("BEGIN_FN no function at " + addr);
            println("END_FN");
            return;
        }
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        DecompileResults res = ifc.decompileFunction(fn, 60, monitor);
        if (res == null || !res.decompileCompleted()) {
            println("BEGIN_FN decompile failed for " + fn.getName() + " @ " + fn.getEntryPoint());
            println("END_FN");
            return;
        }
        println("BEGIN_FN " + fn.getName() + " @ " + fn.getEntryPoint());
        println(res.getDecompiledFunction().getC());
        println("END_FN");
        ifc.dispose();
    }
}
