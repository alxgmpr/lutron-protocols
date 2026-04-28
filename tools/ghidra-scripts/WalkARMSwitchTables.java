// Walks every Cortex-M switch dispatch (TBB/TBH or PC-relative LDR) in the
// program and emits one row per (dispatch_addr, op_byte, handler_addr).
//
// Detection rules:
//
//   1) TBB [PC, Rm]   — opcode 0xE8DF + 0xF000|Rm. The byte table
//      immediately follows the instruction; each byte is a half-word offset
//      from PC (= insn end + offset*2). Walk until the offsets stop forming
//      a plausible target (out-of-section / code-touching).
//
//   2) TBH [PC, Rm]   — opcode 0xE8DF + 0xF010|Rm. Half-word entries;
//      target = PC + 2 * half-word.
//
//   3) ADR + LDR + BX  cmp-cascade fallback: a chain of CMP rN,#imm + BEQ
//      label patterns where imm < 0x100. Emitted as 'cmpchain'.
//
// Output is TSV on println:
//   PATTERN <tbb|tbh|cmpchain> <dispatch_addr> <op_byte> <target_addr>
//
// Set the `BOUND_GAP` parameter via -postScript "WalkARMSwitchTables.java 32"
// to override max table length (default 64).
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;

public class WalkARMSwitchTables extends GhidraScript {

    private int boundGap = 64;

    @Override
    public void run() throws Exception {
        String[] argv = getScriptArgs();
        if (argv != null && argv.length > 0) {
            try { boundGap = Integer.parseInt(argv[0]); } catch (Exception ignored) {}
        }
        Memory mem = currentProgram.getMemory();
        Listing listing = currentProgram.getListing();
        InstructionIterator it = listing.getInstructions(true);

        Instruction prev = null;
        while (it.hasNext()) {
            Instruction ins = it.next();
            String mnem = ins.getMnemonicString();

            if (mnem.equals("tbb") || mnem.equals("TBB")) {
                walkTbb(ins, mem, false);
            } else if (mnem.equals("tbh") || mnem.equals("TBH")) {
                walkTbb(ins, mem, true);
            } else if (mnem.equals("b.eq") || mnem.equals("BEQ") || mnem.equals("beq.w")) {
                if (prev != null) {
                    String pmn = prev.getMnemonicString();
                    if (pmn.equals("cmp") || pmn.equals("CMP")) {
                        emitCmpBeq(prev, ins);
                    }
                }
            }
            prev = ins;
        }
    }

    private void walkTbb(Instruction ins, Memory mem, boolean isHalf) {
        // Table starts at end of TBB instruction (PC = ins.next).
        Address tableStart = ins.getMaxAddress().add(1);
        // Heuristic upper bound: stop at first invalid offset or first code reference.
        int maxEntries = boundGap;
        try {
            Function fn = getFunctionContaining(ins.getAddress());
            for (int i = 0; i < maxEntries; i++) {
                Address entryAddr = tableStart.add(isHalf ? i * 2 : i);
                int v;
                if (isHalf) {
                    v = mem.getShort(entryAddr) & 0xFFFF;
                } else {
                    v = mem.getByte(entryAddr) & 0xFF;
                }
                if (v == 0 && i > 4) break; // common terminator
                Address target = tableStart.add(2 * v);
                // Sanity: target must be inside the same function, or at least within program memory.
                if (!mem.contains(target)) break;
                if (fn != null) {
                    if (target.compareTo(fn.getEntryPoint()) < 0) break;
                }
                println(String.format("PATTERN %s %s %02x %s",
                        isHalf ? "tbh" : "tbb",
                        ins.getAddress(), i & 0xFF, target));
            }
        } catch (Exception e) {
            println("ERR walking " + ins.getAddress() + ": " + e.getMessage());
        }
    }

    private void emitCmpBeq(Instruction cmp, Instruction br) {
        Object[] cmpOps = cmp.getInputObjects();
        Long imm = null;
        for (Object o : cmpOps) {
            if (o instanceof Scalar) { imm = ((Scalar) o).getUnsignedValue(); break; }
        }
        Address tgt = null;
        for (Reference r : br.getReferencesFrom()) {
            if (r.getReferenceType().isFlow() || r.getReferenceType().isJump()) {
                tgt = r.getToAddress();
                break;
            }
        }
        if (imm == null || tgt == null) return;
        if (imm < 0 || imm > 0xFF) return;
        println(String.format("PATTERN cmpchain %s %02x %s",
                cmp.getAddress(), imm.intValue(), tgt));
    }
}
