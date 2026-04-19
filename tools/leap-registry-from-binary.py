#!/usr/bin/env python3
"""
Extract LEAP endpoint registry and response schemas from the RA3 processor's
stripped Go server binary (multi-server-phoenix.gobin) using GoReSym output.

Usage:
  1. Install GoReSym: git clone https://github.com/mandiant/GoReSym && cd GoReSym && go build -o /tmp/GoReSym .
  2. /tmp/GoReSym -t -d -p /path/to/multi-server-phoenix.gobin > /tmp/goresym.json
  3. python3 tools/leap-registry-from-binary.py /tmp/goresym.json

Outputs:
  - data/firmware-re/leap-routes.json  (route -> verbs, handler symbols, response type name)
  - data/firmware-re/leap-types.json   (leapobj.* struct reconstructions)
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Route handlers live in leap/resource.* and follow verb-prefix naming.
VERB_PATTERNS = [
    (re.compile(r"^BodyAndMessageTypeFor(.+)$"), "GET"),
    (re.compile(r"^Subscribe(.+?)(?:\.func\d+.*)?$"), "SUBSCRIBE"),
    (re.compile(r"^Update(.+?)(?:\.func\d+.*)?$"), "UPDATE"),
    (re.compile(r"^Create(.+?)(?:\.func\d+.*)?$"), "CREATE"),
    (re.compile(r"^Add(.+?)(?:\.func\d+.*)?$"), "CREATE"),
    (re.compile(r"^Delete(.+?)(?:\.func\d+.*)?$"), "DELETE"),
]


def extract_routes(user_functions):
    routes = defaultdict(lambda: {"verbs": set(), "handlers": {}})
    for f in user_functions:
        fn = f.get("FullName", "")
        if not fn.startswith("leap/resource."):
            continue
        short = fn[len("leap/resource.") :]
        for pat, verb in VERB_PATTERNS:
            m = pat.match(short)
            if m:
                ident = re.sub(r"\.func\d+.*$", "", m.group(1))
                if ident:
                    routes[ident]["verbs"].add(verb)
                    routes[ident]["handlers"][verb] = fn
                break
    return routes


def extract_leapobj(types):
    """All leapobj.* struct types keyed by simple name -> reconstructed source."""
    out = {}
    for t in types:
        if t.get("Kind") != "Struct":
            continue
        s = t.get("Str", "")
        m = re.match(r"^leapobj\.([A-Z][\w]*)$", s)
        if m:
            out[m.group(1)] = t.get("Reconstructed", "")
    return out


def ident_to_path(ident, dictionary):
    """Convert CamelCase ident to LEAP URL path using dictionary-based segmentation."""
    # Step 1: split at ID/XID markers
    chunks = []
    cur = ""
    i = 0
    while i < len(ident):
        if ident[i : i + 3] == "XID" and (i + 3 == len(ident) or ident[i + 3].isupper()):
            if cur:
                chunks.append(("WORD", cur.lower()))
            chunks.append(("ID", "{xid}"))
            cur = ""
            i += 3
        elif ident[i : i + 2] == "ID" and (i + 2 == len(ident) or ident[i + 2].isupper()):
            if cur:
                chunks.append(("WORD", cur.lower()))
            chunks.append(("ID", "{id}"))
            cur = ""
            i += 2
        else:
            cur += ident[i]
            i += 1
    if cur:
        chunks.append(("WORD", cur.lower()))

    # Step 2: dictionary-segment each word chunk
    memo = {}

    def segment(s):
        if s in memo:
            return memo[s]
        if not s:
            return []
        for L in range(len(s), 0, -1):
            if s[:L] in dictionary:
                rest = segment(s[L:])
                if rest is not None:
                    memo[s] = [s[:L]] + rest
                    return memo[s]
        memo[s] = None
        return None

    out_segs = []
    for typ, val in chunks:
        if typ == "ID":
            out_segs.append(val)
        else:
            segs = segment(val)
            out_segs.extend(segs if segs else [val])
    return "/" + "/".join(out_segs)


def type_name_for_ident(ident):
    """Strip ID markers to get candidate leapobj type name."""
    return re.sub(r"X?ID(?=[A-Z]|$)", "", ident)


def build_dictionary(goresym):
    """Harvest likely LEAP path segments from strings + type names."""
    dictionary = set()
    # Pull segments from type names (e.g. leapobj.AreaScene -> 'area', 'scene' — but we want the full compound too)
    for t in goresym["Types"]:
        s = t.get("Str", "")
        m = re.match(r"^leapobj\.([A-Z][\w]*)$", s)
        if m:
            # Add lowercase compound: 'areascene', 'areasceneassignment'
            dictionary.add(m.group(1).lower())
    # Also add common LEAP vocab from manual knowledge
    for extra in (
        "area zone device button buttongroup server system areascene preset "
        "presetassignment presetbutton daynightmode timeclock timeclockevent "
        "dailyschedule weeklyschedule virtualbutton vbutton contactinfo "
        "sharedscene occupancygroup occupancysensor occupancysettings "
        "occupancysensorsettings dimmer fan shade shadegroup hvac load "
        "loadcontroller assignableresource rentablespace facade ledsettings "
        "status summary project masterdevicelist devices favorite pairing "
        "pairinglist relation audiodevice audiozone audioevent "
        "intruderdeterrent alexa homekit smartthings ifttt sonos wificonfig "
        "networksettings connection discovery certificate diagnostics "
        "devicefirmware devicegroup lightlevel areapreset spectrumtuninglevel "
        "daylighting daylightinggainsettings cca ccx leap auditlog trust "
        "user role contactsensor motionsensor childarea associatedzone "
        "associatedarea associatedcontrolstation associatedareascene "
        "associatedoccupancygroup associatedloadcontroller associateddevice "
        "associatedsensor associatedshadegroup controlstation loadshedding "
        "tuningsettings phasesettings fadesettings expanded deprecated level "
        "event emergencysettings naturallightoptimization naturalshow "
        "naturalshows zonealias zonescene zonetypegroup zonetypegroups "
        "countdowntimer colortuningsettings colorprofile dimmedlevelassignment "
        "dimmedlevel operation ping network openadrconnection openadr "
        "buttonevent contactclosureoutput contactclosureinput cci cco "
        "fwupdate profilesession sequencestep sequenceassignment "
        "startsequenceassignment raiselowerassignment ccolevelassignment "
        "batterystatus availability firmwarefile firmwareimage "
        "firmwareupdatesession firmware iplassociation webendpoint keystore "
        "accessory controller awscredsserver database integrator bonjour "
        "emergency bacnet bacnetsettings bacnetnetworksettings bacnetinstances "
        "intruder shadelevelwithtiltassignment tilt raise lower countdown "
        "timer scene alias programmingmodel thirdpartydevice thirdpartydevices "
        "xid with explicit implicit paging query settings assignment "
        "phoenix sftp support tmp"
    ).split():
        dictionary.add(extra)
    return dictionary


def main():
    goresym_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/goresym.json"
    data = json.load(open(goresym_path))

    routes = extract_routes(data["UserFunctions"])
    leapobj = extract_leapobj(data["Types"])
    dictionary = build_dictionary(data)

    print(f"Routes: {len(routes)}", file=sys.stderr)
    print(f"leapobj types: {len(leapobj)}", file=sys.stderr)

    # Build unified registry JSON
    out_routes = []
    for ident, info in sorted(routes.items()):
        path = ident_to_path(ident, dictionary)
        cand = type_name_for_ident(ident)
        response_type = cand if cand in leapobj else None
        out_routes.append(
            {
                "ident": ident,
                "path": path,
                "verbs": sorted(info["verbs"]),
                "handlers": info["handlers"],
                "responseType": response_type,
            }
        )

    outdir = REPO / "data" / "firmware-re"
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "leap-routes.json").write_text(json.dumps(out_routes, indent=2))
    (outdir / "leap-types.json").write_text(json.dumps(leapobj, indent=2))

    # Stats
    matched = sum(1 for r in out_routes if r["responseType"])
    print(f"Routes with matched response types: {matched}/{len(out_routes)}", file=sys.stderr)
    print(f"Wrote {outdir / 'leap-routes.json'} ({len(out_routes)} entries)", file=sys.stderr)
    print(f"Wrote {outdir / 'leap-types.json'} ({len(leapobj)} types)", file=sys.stderr)


if __name__ == "__main__":
    main()
