// Find functions that compare against 0xFADE or 0xDEFA (the CCA sync delimiter).
//
// In ARM Thumb, comparing against 0xFADE typically appears as:
//   movw r3, #0xfade (or movt r3, ...)
//   cmp.w r0, r3
// OR as a sign-extended 16-bit short check, e.g. -0x522 (= 0xFADE as int16).
//
// Output:
//   FADE <fn_addr> <ins_addr> <imm>
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.scalar.Scalar;

public class FindFADESync extends GhidraScript {

    @Override
    public void run() throws Exception {
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
                        long v = ((Scalar) o).getSignedValue();
                        if (v == 0xFADEL || v == 0xDEFAL || v == -0x522L) {
                            println(String.format("FADE %s %s val=%04X mnem=%s",
                                f.getEntryPoint(), ins.getAddress(),
                                ((int) v) & 0xFFFF, ins.getMnemonicString()));
                        }
                    }
                }
            }
        }
    }
}
