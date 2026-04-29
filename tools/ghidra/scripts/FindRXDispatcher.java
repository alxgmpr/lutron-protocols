// Find candidate CCA RX dispatcher functions.
//
// Strategy: walk every function in the program and score it by how many of
// the canonical CCA RX type bytes appear as compare immediates within it.
//
// The TX path was found in PR #32 by walking jump tables, but RX is harder
// because it's typically a hand-rolled if/else cascade after FIFO drain. The
// classifier function will compare the FIRST byte of the just-received packet
// against the type-byte enum.
//
// Canonical RX type bytes (from protocol/cca.protocol.ts §"PACKET TYPES"):
//   STATE: 0x80, 0x81, 0x82, 0x83
//   BUTTON: 0x88, 0x89, 0x8A, 0x8B
//   BEACON: 0x91, 0x92, 0x93
//   CONFIG: 0xA1, 0xA2, 0xA3
//   PAIR: 0xB0, 0xB2, 0xB8, 0xB9, 0xBA, 0xBB
//   HANDSHAKE: 0xC0..0xE0 (every 6th)
//   OTA: 0x2A, 0x32, 0x33, 0x34, 0x35, 0x36, 0x3A, 0x3C, 0x41, 0x58
//
// Output: TSV via println:
//   FN <addr> <hits> <byte_set>
//   ... sorted by hits desc.
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

public class FindRXDispatcher extends GhidraScript {

    private static final Set<Integer> RX_TYPE_BYTES = new HashSet<>(Arrays.asList(
        0x80, 0x81, 0x82, 0x83,                    // STATE
        0x88, 0x89, 0x8A, 0x8B,                    // BUTTON
        0x91, 0x92, 0x93,                           // BEACON
        0xA1, 0xA2, 0xA3,                           // CONFIG
        0xB0, 0xB2, 0xB8, 0xB9, 0xBA, 0xBB,         // PAIR
        0xC0, 0xC1, 0xC2, 0xC5, 0xC7, 0xC8,         // HANDSHAKE 1-2
        0xCD, 0xCE, 0xD3, 0xD4, 0xD9, 0xDA,         // HANDSHAKE 3-5
        0xDF, 0xE0,                                  // HANDSHAKE 6
        0x2A, 0x32, 0x33, 0x34, 0x35, 0x36,         // OTA
        0x3A, 0x3C, 0x41, 0x58
    ));

    @Override
    public void run() throws Exception {
        FunctionIterator fnIt = currentProgram.getFunctionManager().getFunctions(true);
        List<FnHit> hits = new ArrayList<>();
        while (fnIt.hasNext()) {
            Function f = fnIt.next();
            FnHit h = scoreFn(f);
            if (h != null && h.bytes.size() >= 4) hits.add(h);
        }
        hits.sort((a, b) -> b.bytes.size() - a.bytes.size());
        for (FnHit h : hits) {
            StringBuilder sb = new StringBuilder();
            List<Integer> sorted = new ArrayList<>(h.bytes);
            Collections.sort(sorted);
            for (int b : sorted) {
                if (sb.length() > 0) sb.append(",");
                sb.append(String.format("%02X", b));
            }
            println(String.format("FN %s %d size=%d %s",
                h.addr, h.bytes.size(), h.size, sb.toString()));
        }
    }

    private FnHit scoreFn(Function f) {
        AddressSetView body = f.getBody();
        if (body == null) return null;
        long size = body.getNumAddresses();
        if (size > 0x4000) return null; // skip ridiculously large fns
        Set<Integer> seen = new HashSet<>();
        InstructionIterator it = currentProgram.getListing().getInstructions(body, true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            String mnem = ins.getMnemonicString().toUpperCase();
            if (!isCmpInsn(mnem)) continue;
            for (Object o : ins.getInputObjects()) {
                if (o instanceof Scalar) {
                    long v = ((Scalar) o).getUnsignedValue();
                    if (RX_TYPE_BYTES.contains((int) v)) {
                        seen.add((int) v);
                    }
                }
            }
        }
        FnHit h = new FnHit();
        h.addr = f.getEntryPoint();
        h.size = size;
        h.bytes = seen;
        return h;
    }

    private static boolean isCmpInsn(String mnem) {
        return mnem.equals("CMP") || mnem.equals("CMP.W")
            || mnem.equals("CMN") || mnem.equals("CMN.W")
            || mnem.startsWith("CBZ") || mnem.startsWith("CBNZ")
            || mnem.equals("SUB") || mnem.equals("SUBS")
            || mnem.equals("SUB.W") || mnem.equals("SUBS.W");
    }

    private static class FnHit {
        Address addr;
        long size;
        Set<Integer> bytes;
    }
}
