// Dump all readable strings (>= 4 chars).
//
// @category Lutron
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;

public class DumpStrings extends GhidraScript {
    @Override
    public void run() throws Exception {
        DataIterator it = currentProgram.getListing().getDefinedData(true);
        while (it.hasNext()) {
            Data d = it.next();
            String type = d.getDataType().getName();
            if (type.contains("string") || type.contains("char") || type.equals("ds")) {
                Object v = d.getValue();
                if (v instanceof String) {
                    String s = (String) v;
                    if (s.length() >= 4 && s.length() < 200 && isPrintable(s)) {
                        println(String.format("STR %s %s", d.getAddress(), s.replace("\n", "\\n").replace("\r", "\\r")));
                    }
                }
            }
        }
    }
    private static boolean isPrintable(String s) {
        for (char c : s.toCharArray()) {
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }
}
