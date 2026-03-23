#!/usr/bin/env python3
"""
Extract .NET metadata from Designer DLLs using dnfile.
Dumps types with methods, user strings, and embedded resources.
"""

import sys
import os
import dnfile

def get_user_strings(pe):
    """Extract user strings from #US heap."""
    md = pe.net.metadata
    us_heap = md.streams.get(b"#US")
    if not us_heap or not us_heap.__data__:
        return []

    strings = []
    offset = 1
    data = us_heap.__data__
    while offset < len(data):
        b0 = data[offset]
        if b0 == 0:
            offset += 1
            continue
        if b0 < 0x80:
            length = b0
            offset += 1
        elif b0 < 0xC0:
            if offset + 1 >= len(data): break
            length = ((b0 & 0x3F) << 8) | data[offset + 1]
            offset += 2
        else:
            if offset + 3 >= len(data): break
            length = ((b0 & 0x1F) << 24) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3]
            offset += 4
        if length <= 0 or offset + length > len(data):
            break
        raw = data[offset:offset + length]
        if length > 1:
            try:
                val = raw[:length-1].decode('utf-16-le', errors='replace').strip('\x00')
                if val.strip() and len(val) > 1:
                    strings.append(val)
            except:
                pass
        offset += length
    return strings


def dump_assembly(path, string_filter=None):
    pe = dnfile.dnPE(path)
    name = os.path.basename(path)

    if not pe.net or not pe.net.metadata:
        print(f"ERROR: {name} has no .NET metadata")
        return

    md = pe.net.metadata
    tbl = md.streams_list[0]  # MetaDataTables

    # --- Types with methods ---
    print(f"\n{'='*80}")
    print(f"# {name} — Types & Methods")
    print(f"{'='*80}")

    typedef_rows = list(tbl.TypeDef) if tbl.TypeDef else []
    methoddef_rows = list(tbl.MethodDef) if tbl.MethodDef else []

    for ti, trow in enumerate(typedef_rows):
        ns = str(trow.TypeNamespace) if trow.TypeNamespace else ""
        tn = str(trow.TypeName) if trow.TypeName else ""
        full = f"{ns}.{tn}" if ns else tn

        # Skip compiler-generated types
        if tn.startswith("<>") or tn.startswith("<") or tn == "<Module>":
            continue

        # Get methods - MethodList may be a list of MDTableIndex or a single one
        methods = []
        ml = trow.MethodList
        if ml:
            if isinstance(ml, list):
                for mref in ml:
                    idx = mref.row_index - 1 if hasattr(mref, 'row_index') else 0
                    if 0 <= idx < len(methoddef_rows):
                        mname = str(methoddef_rows[idx].Name) if methoddef_rows[idx].Name else f"m{idx}"
                        if not mname.startswith("."):
                            methods.append(mname)
            elif hasattr(ml, 'row_index'):
                start_idx = ml.row_index - 1
                if ti + 1 < len(typedef_rows):
                    next_ml = typedef_rows[ti+1].MethodList
                    if isinstance(next_ml, list) and next_ml:
                        end_idx = next_ml[0].row_index - 1 if hasattr(next_ml[0], 'row_index') else len(methoddef_rows)
                    elif hasattr(next_ml, 'row_index'):
                        end_idx = next_ml.row_index - 1
                    else:
                        end_idx = len(methoddef_rows)
                else:
                    end_idx = len(methoddef_rows)
                for mi in range(start_idx, min(end_idx, len(methoddef_rows))):
                    mname = str(methoddef_rows[mi].Name) if methoddef_rows[mi].Name else f"m{mi}"
                    if not mname.startswith("."):
                        methods.append(mname)

        if methods:
            print(f"\n  {full}:")
            for m in methods:
                print(f"    {m}")
        else:
            print(f"\n  {full}: (no public methods)")

    print(f"\n  Total types: {len(typedef_rows)}, methods: {len(methoddef_rows)}")

    # --- User Strings ---
    strings = get_user_strings(pe)
    print(f"\n{'='*80}")
    print(f"# {name} — User Strings ({len(strings)} total)")
    print(f"{'='*80}")

    if string_filter:
        filters = [f.lower() for f in string_filter]
        filtered = [s for s in strings if any(f in s.lower() for f in filters)]
        print(f"  Filtered for: {string_filter}")
        for s in filtered:
            print(f"  > {s[:500]}")
        print(f"\n  Matched: {len(filtered)} / {len(strings)}")
    else:
        for s in strings:
            print(f"  {s[:500]}")

    # --- Embedded Resources ---
    print(f"\n{'='*80}")
    print(f"# {name} — Embedded Resources")
    print(f"{'='*80}")

    if tbl.ManifestResource:
        for row in tbl.ManifestResource:
            rname = str(row.Name) if row.Name else "?"
            print(f"  {rname}")
        print(f"  Total: {len(list(tbl.ManifestResource))}")
    else:
        print("  None")

    # --- MemberRef (external references) ---
    if tbl.MemberRef:
        print(f"\n{'='*80}")
        print(f"# {name} — Key External Refs")
        print(f"{'='*80}")

        interesting = set()
        for row in tbl.MemberRef:
            ref_name = str(row.Name) if row.Name else ""
            for kw in ["Save", "Open", "Attach", "Detach", "Lut", "Mdf",
                       "Zip", "Database", "SqlLocal", "Validate", "Verify",
                       "Hash", "Checkpoint", "Product", "Backup", "Restore",
                       "Encrypt", "Decrypt", "FileStream", "BinaryReader",
                       "BinaryWriter", "Compress", "Decompress", "Archive"]:
                if kw.lower() in ref_name.lower():
                    interesting.add(ref_name)
                    break
        for ref in sorted(interesting):
            print(f"  {ref}")
        print(f"  ({len(interesting)} matched / {len(list(tbl.MemberRef))} total)")

    pe.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 dotnet-decompile.py <dll> [--filter kw1,kw2,...]")
        sys.exit(1)

    string_filter = None
    paths = []
    for arg in sys.argv[1:]:
        if arg.startswith("--filter="):
            string_filter = arg.split("=", 1)[1].split(",")
        else:
            paths.append(arg)

    for path in paths:
        dump_assembly(path, string_filter)
