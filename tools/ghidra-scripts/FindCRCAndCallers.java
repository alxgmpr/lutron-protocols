// Find functions that contain the CCA CRC polynomial (0xCA0F) as a literal
// constant, then dump their callers.
//
// Strategy:
//   1. Walk all instructions; flag functions whose body contains MOV/MOVW
//      with immediate 0xCA0F.
//   2. For each such function, dump direct callers.
//
// Output:
//   CRC_FN <fn_addr> <ins_addr>
//   CALLER <crc_fn_addr> <caller_addr>
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.ReferenceManager;

import java.util.*;

public class FindCRCAndCallers extends GhidraScript {

    @Override
    public void run() throws Exception {
        Set<Function> crcFns = new LinkedHashSet<>();
        FunctionIterator fnIt = currentProgram.getFunctionManager().getFunctions(true);
        while (fnIt.hasNext()) {
            Function f = fnIt.next();
            AddressSetView body = f.getBody();
            if (body == null) continue;
            InstructionIterator it = currentProgram.getListing().getInstructions(body, true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                for (Object o : ins.getInputObjects()) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar) o).getUnsignedValue();
                        // 0xCA0F or its mirror 0xF053 (reflected)
                        if (v == 0xCA0FL || v == 0xF053L) {
                            println(String.format("CRC_FN %s %s val=%04X mnem=%s",
                                f.getEntryPoint(), ins.getAddress(), (int) v, ins.getMnemonicString()));
                            crcFns.add(f);
                        }
                    }
                }
            }
        }
        // Dump callers for each CRC function.
        ReferenceManager rm = currentProgram.getReferenceManager();
        for (Function f : crcFns) {
            for (Reference r : rm.getReferencesTo(f.getEntryPoint())) {
                RefType rt = r.getReferenceType();
                if (rt.isCall()) {
                    Function callerFn = currentProgram.getFunctionManager()
                        .getFunctionContaining(r.getFromAddress());
                    Address callerAddr = callerFn != null ? callerFn.getEntryPoint() : null;
                    println(String.format("CALLER %s %s callerFn=%s",
                        f.getEntryPoint(), r.getFromAddress(), callerAddr));
                }
            }
        }
    }
}
