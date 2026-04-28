// Heuristic enumerator for the CCA radio packet-type dispatch in Phoenix coproc
// firmware. Looks for two structural patterns:
//
//   1. A jump table: an instruction that loads a pointer indexed by a single byte,
//      then JSR/JMP through it. Walks the table and dumps (index, target).
//
//   2. Cmp-cascades: a chain of CMPA/BEQ comparisons against constants 0x00-0xFF.
//      Records each (constant, target_after_BEQ) pair as a candidate (op, handler).
//
// Output: TSV on stdout (via println):
//   PATTERN <jumptable|cmpchain> <dispatch_addr> <op_byte> <target_addr>
//
// Caveats:
//   - This is a coarse first pass. Some dispatch loops are nested or driven by
//     state-machine flags; those won't show up cleanly.
//   - It runs against whatever program is open. Run with -process to target one,
//     or wrap in a loop over project files.
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;

public class EnumerateCCAOpcodes extends GhidraScript {

    @Override
    public void run() throws Exception {
        Listing listing = currentProgram.getListing();
        InstructionIterator it = listing.getInstructions(true);

        Instruction prev1 = null, prev2 = null;
        while (it.hasNext()) {
            Instruction ins = it.next();

            // Heuristic A: cmp-cascade.
            // CMPA #imm  +  BEQ target   --or--  CBEQA #imm,target
            String mnem = ins.getMnemonicString();
            if (mnem.startsWith("CBEQ") || mnem.startsWith("DBEQ")) {
                emitCmpChain(ins);
            } else if (prev1 != null && (mnem.equals("BEQ") || mnem.equals("BNE"))) {
                String prevMnem = prev1.getMnemonicString();
                if (prevMnem.equals("CMPA") || prevMnem.equals("CMP") || prevMnem.equals("CPHX")
                        || prevMnem.equals("CPX")) {
                    emitCmpFollowedByBranch(prev1, ins);
                }
            }

            // Heuristic B: jump table fingerprint.
            // LSLA / LSLA  (multiply by 2 or 4)  followed shortly by indirect call.
            if (mnem.equals("JMP") || mnem.equals("JSR")) {
                Reference[] refs = ins.getReferencesFrom();
                for (Reference r : refs) {
                    if (r.isPrimary() && r.getReferenceType().isComputed()) {
                        println(String.format("PATTERN jumptable %s ? %s",
                                ins.getAddress(), r.getToAddress()));
                    }
                }
            }

            prev2 = prev1;
            prev1 = ins;
        }
    }

    private void emitCmpFollowedByBranch(Instruction cmp, Instruction br) {
        Object[] cmpOps = cmp.getInputObjects();
        Object[] brOps = br.getInputObjects();
        Long imm = null;
        for (Object o : cmpOps) if (o instanceof Scalar) { imm = ((Scalar) o).getUnsignedValue(); break; }
        Address tgt = null;
        for (Object o : brOps) if (o instanceof Address) { tgt = (Address) o; break; }
        if (imm != null && tgt != null && imm < 0x100) {
            println(String.format("PATTERN cmpchain %s %02x %s",
                    cmp.getAddress(), imm.intValue(), tgt));
        }
    }

    private void emitCmpChain(Instruction ins) {
        // CBEQA #imm,target  — single-instruction compare-and-branch.
        Object[] ops = ins.getInputObjects();
        Long imm = null; Address tgt = null;
        for (Object o : ops) {
            if (o instanceof Scalar && imm == null) imm = ((Scalar) o).getUnsignedValue();
            if (o instanceof Address) tgt = (Address) o;
        }
        if (imm != null && tgt != null && imm < 0x100) {
            println(String.format("PATTERN cmpchain %s %02x %s",
                    ins.getAddress(), imm.intValue(), tgt));
        }
    }
}
