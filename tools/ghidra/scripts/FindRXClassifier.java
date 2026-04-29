// Find candidate CCA RX classifier functions.
//
// Heuristic: a "type-byte classifier" is any short window (~30 instructions)
// containing >=3 distinct compare-immediates against canonical CCA RX
// type bytes (0x80, 0x81, 0x88, 0x91, 0xA1, 0xB0, 0xB8, 0xC1, etc.) where
// the compared register can be traced back to a load (LDRB / LDR offset 0)
// from the same buffer pointer.
//
// We don't try to track dataflow precisely — instead we use a soft signal:
// presence of LDRB Rd,[Rn,#0] *near* the cmp cluster.
//
// Output:
//   CLASSIFIER <fn_addr> <inst_addr> <byte_set>
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

import java.util.*;

public class FindRXClassifier extends GhidraScript {

    private static final Set<Integer> RX_BYTES = new HashSet<>(Arrays.asList(
        0x80, 0x81, 0x82, 0x83,
        0x88, 0x89, 0x8A, 0x8B,
        0x91, 0x92, 0x93,
        0xA1, 0xA2, 0xA3,
        0xB0, 0xB2, 0xB8, 0xB9, 0xBA, 0xBB,
        0xC0, 0xC1, 0xC2, 0xC5, 0xC7, 0xC8,
        0xCD, 0xCE, 0xD3, 0xD4, 0xD9, 0xDA,
        0xDF, 0xE0
    ));

    @Override
    public void run() throws Exception {
        FunctionIterator fnIt = currentProgram.getFunctionManager().getFunctions(true);
        while (fnIt.hasNext()) {
            Function f = fnIt.next();
            scan(f);
        }
    }

    private void scan(Function f) {
        AddressSetView body = f.getBody();
        if (body == null) return;
        long size = body.getNumAddresses();
        if (size > 0x4000) return;
        InstructionIterator it = currentProgram.getListing().getInstructions(body, true);
        List<Instruction> instrs = new ArrayList<>();
        while (it.hasNext()) instrs.add(it.next());

        Set<Integer> typeHits = new TreeSet<>();
        boolean sawLoad = false;
        for (Instruction ins : instrs) {
            String mnem = ins.getMnemonicString().toUpperCase();
            if (mnem.startsWith("LDRB") || mnem.equals("LDR.W") || mnem.equals("LDR")) {
                sawLoad = true;
            }
            if (isCmpInsn(mnem)) {
                for (Object o : ins.getInputObjects()) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar) o).getUnsignedValue();
                        if (RX_BYTES.contains((int) v)) typeHits.add((int) v);
                    }
                }
            }
        }
        if (typeHits.size() < 3 || !sawLoad) return;

        StringBuilder sb = new StringBuilder();
        for (int b : typeHits) {
            if (sb.length() > 0) sb.append(",");
            sb.append(String.format("%02X", b));
        }
        println(String.format("CLASSIFIER %s hits=%d size=%d %s",
            f.getEntryPoint(), typeHits.size(), size, sb.toString()));
    }

    private static boolean isCmpInsn(String mnem) {
        return mnem.equals("CMP") || mnem.equals("CMP.W")
            || mnem.equals("SUBS") || mnem.equals("SUBS.W");
    }
}
