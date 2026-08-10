#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pylutron-caseta"]
# ///
"""Pair with a Caseta bridge over LAP (port 8083) and write the certs.

A factory reset regenerates the bridge's CA, which invalidates any
previously issued client certificate — the bridge then answers the LEAP
handshake on 8081 with `tlsv1 alert unknown ca`. Re-pairing is the only
fix, and it requires physically pressing the small black button on the
back of the bridge, so this cannot run unattended.

    uv run tools/leap/caseta-pair.py <host> [out-dir]

Writes caseta-client.key / caseta-client.crt / caseta-ca.crt into out-dir
(default data/caseta-pair) and prints the config.json block to add.
"""

import asyncio
import json
import sys
from pathlib import Path

from pylutron_caseta.pairing import async_pair

DEFAULT_OUT = Path("data/caseta-pair")


def _ready() -> None:
    print(
        "\n>>> PRESS the small black button on the BACK of the Caseta bridge now.\n"
        ">>> Waiting up to 180 seconds...\n",
        flush=True,
    )


async def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    host = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)

    print(f"pairing with {host}:8083 ...", flush=True)
    data = await async_pair(host, _ready)

    files = {
        "caseta-client.key": data["key"],
        "caseta-client.crt": data["cert"],
        "caseta-ca.crt": data["ca"],
    }
    for name, content in files.items():
        path = out / name
        path.write_text(content)
        path.chmod(0o600)
        print(f"wrote {path}")

    print(f"\nbridge LEAP version: {data['version']}")
    print("\nAdd to config.json under \"processors\":")
    print(
        json.dumps(
            {
                host: {
                    "cert": str(out / "caseta-client.crt"),
                    "key": str(out / "caseta-client.key"),
                    "ca": str(out / "caseta-ca.crt"),
                }
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
