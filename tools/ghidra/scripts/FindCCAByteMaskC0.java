// Find functions that AND a byte with 0xC0 *and* compare to specific values
// (0x40, 0x80, 0xC0). This is the runtime CCA RX classifier signature
// discovered in 801FB08 binary at FUN_0800CC74.
//
// Output: TSV
//   CLASS_FN <fn_addr> ldrb_count cmp_c0 cmp_80 cmp_40
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.scalar.Scalar;

public class FindCCAByteMaskC0 extends GhidraScript {

    @Override
    public void run() throws Exception {
        FunctionIterator fnIt = currentProgram.getFunctionManager().getFunctions(true);
        while (fnIt.hasNext()) {
            Function f = fnIt.next();
            AddressSetView body = f.getBody();
            if (body == null) continue;
            long size = body.getNumAddresses();
            if (size > 0x4000) continue;
            boolean has_c0_and = false;
            int c80 = 0, c40 = 0, cc0 = 0;
            int ldrb_count = 0;
            InstructionIterator it = currentProgram.getListing().getInstructions(body, true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                String mnem = ins.getMnemonicString().toUpperCase();
                if (mnem.startsWith("LDRB")) ldrb_count++;
                for (Object o : ins.getInputObjects()) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar) o).getUnsignedValue();
                        if (v == 0xC0L && (mnem.equals("AND") || mnem.equals("AND.W")
                                || mnem.equals("ANDS") || mnem.equals("ANDS.W")
                                || mnem.equals("TST") || mnem.equals("TST.W")
                                || mnem.equals("UBFX") || mnem.equals("BIC"))) {
                            has_c0_and = true;
                        }
                        if (mnem.equals("CMP") || mnem.equals("CMP.W")
                            || mnem.equals("CMPS")) {
                            if (v == 0xC0L) cc0++;
                            if (v == 0x80L) c80++;
                            if (v == 0x40L) c40++;
                        }
                    }
                }
            }
            if (has_c0_and && (c80 + c40 + cc0) >= 2) {
                println(String.format("CLASS_FN %s ldrb=%d c40=%d c80=%d cC0=%d size=%d",
                    f.getEntryPoint(), ldrb_count, c40, c80, cc0, size));
            }
        }
    }
}
