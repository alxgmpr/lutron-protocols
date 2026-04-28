// Heuristic enumerator for the CCA radio packet-type dispatch.
//
// Originally targeted HCS08 (CMPA / CBEQA). The real CCA dispatch lives in the
// EFR32 (Cortex-M) coproc, so we now also handle ARM Thumb mnemonics.
//
// Two structural patterns are recognised:
//
//   1. Cmp-cascade. A chain of  CMP rN, #imm  +  B(EQ|NE) tgt  for imm < 0x100.
//      Operand extraction: the branch target comes from the instruction's
//      flow references (getReferencesFrom() filtered to flow/jump types) NOT
//      from getInputObjects() - that was the bug in the prior version. We
//      also accept HCS08 CBEQA / DBEQA single-insn compare-and-branch.
//
//   2. Jump table fingerprint: a JMP / JSR / BX / BLX whose primary reference
//      is computed. Cortex-M typically uses TBB/TBH and PC-relative LDRs;
//      see WalkARMSwitchTables.java for that path.
//
// Output: TSV via println:
//   PATTERN <cmpchain|jumptable> <addr> <op_byte> <target>
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

public class EnumerateCCAOpcodes extends GhidraScript {

    @Override
    public void run() throws Exception {
        Listing listing = currentProgram.getListing();
        InstructionIterator it = listing.getInstructions(true);

        Instruction prev1 = null;
        while (it.hasNext()) {
            Instruction ins = it.next();
            String mnem = ins.getMnemonicString().toUpperCase();

            // Heuristic A: HCS08 single-insn compare-and-branch.
            if (mnem.startsWith("CBEQ") || mnem.startsWith("DBEQ")) {
                emitCmpChain(ins);
            } else if (prev1 != null && isBranchEq(mnem)) {
                String prevMnem = prev1.getMnemonicString().toUpperCase();
                if (isCompareInsn(prevMnem)) {
                    emitCmpFollowedByBranch(prev1, ins);
                }
            }

            // Heuristic B: jump-table fingerprint via computed call/jump.
            if (mnem.equals("JMP") || mnem.equals("JSR")
                    || mnem.equals("BX") || mnem.equals("BLX")) {
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.isPrimary() && r.getReferenceType().isComputed()) {
                        println(String.format("PATTERN jumptable %s ? %s",
                                ins.getAddress(), r.getToAddress()));
                    }
                }
            }

            prev1 = ins;
        }
    }

    private static boolean isBranchEq(String mnem) {
        return mnem.equals("BEQ") || mnem.equals("BNE")
                || mnem.equals("B.EQ") || mnem.equals("B.NE")
                || mnem.equals("BEQ.W") || mnem.equals("BNE.W");
    }

    private static boolean isCompareInsn(String mnem) {
        return mnem.equals("CMPA") || mnem.equals("CMP")
                || mnem.equals("CPHX") || mnem.equals("CPX")
                || mnem.equals("CMP.W") || mnem.equals("CMPB");
    }

    private void emitCmpFollowedByBranch(Instruction cmp, Instruction br) {
        Long imm = scalarOperand(cmp);
        Address tgt = flowTarget(br);
        if (imm != null && tgt != null && imm >= 0 && imm < 0x100) {
            println(String.format("PATTERN cmpchain %s %02x %s",
                    cmp.getAddress(), imm.intValue(), tgt));
        }
    }

    private void emitCmpChain(Instruction ins) {
        Long imm = scalarOperand(ins);
        Address tgt = flowTarget(ins);
        if (imm != null && tgt != null && imm >= 0 && imm < 0x100) {
            println(String.format("PATTERN cmpchain %s %02x %s",
                    ins.getAddress(), imm.intValue(), tgt));
        }
    }

    private static Long scalarOperand(Instruction ins) {
        for (Object o : ins.getInputObjects()) {
            if (o instanceof Scalar) return ((Scalar) o).getUnsignedValue();
        }
        return null;
    }

    private static Address flowTarget(Instruction ins) {
        // Prefer the flow reference from this instruction (jump / cond jump);
        // operand list never carries the resolved target on Thumb branches.
        for (Reference r : ins.getReferencesFrom()) {
            RefType rt = r.getReferenceType();
            if (rt.isJump() || rt.isFlow() || rt.isConditional()) {
                return r.getToAddress();
            }
        }
        Address[] flows = ins.getFlows();
        if (flows != null && flows.length > 0) return flows[0];
        return null;
    }
}
