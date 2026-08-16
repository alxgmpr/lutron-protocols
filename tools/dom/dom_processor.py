"""
Processor-side transport for the DOM tweaker.

Everything the tweaker needs lives on the processor: the athena DB (current
object rows and the ConfigurationStateRevision concurrency token), the
`lutron-core-client` IPC socket, and `/var/log/domain-object-manager` — the
oracle that says precisely why a tweak was refused.

This drives all of it over SSH, so the CLI runs from the workstation and leaves
nothing behind on the processor.
"""

from __future__ import annotations

import json
import shlex
import subprocess
from dataclasses import dataclass, field
from typing import Any, Mapping

ATHENA_DB = "/var/db/lutron-athena-db.sqlite"
DOM_LOG = "/var/log/domain-object-manager"

# Tweak result codes from the Go enum (docs/protocols/dom-tweaker.md § 8).
RESULT_CODES = {
    0: "SUCCESS",
    1: "FAILURE",
    2: "BUSY_ERROR",
    5: "INTERNAL_ERROR",
}


class ProcessorError(RuntimeError):
    pass


@dataclass
class TweakOutcome:
    """What the processor did with a tweak, as read back out of the DOM log."""

    ok: bool
    result_code: int | None
    core_output: str
    dom_log: list[str] = field(default_factory=list)
    reason: str | None = None

    def summary(self) -> str:
        name = RESULT_CODES.get(self.result_code, str(self.result_code))
        head = f"{'SUCCESS' if self.ok else 'FAILED'} (result={name})"
        return f"{head}: {self.reason}" if self.reason else head


class Processor:
    """SSH-driven access to one processor."""

    def __init__(self, host: str, *, timeout: int = 30, dry_run: bool = False):
        self.host = host
        self.timeout = timeout
        self.dry_run = dry_run

    # -- plumbing ---------------------------------------------------------

    def run(self, command: str, *, check: bool = True) -> str:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", self.host, command],
            capture_output=True,
            text=True,
            timeout=self.timeout,
        )
        if check and proc.returncode != 0:
            raise ProcessorError(
                f"ssh {self.host}: exit {proc.returncode}: "
                f"{(proc.stderr or proc.stdout).strip()}"
            )
        return proc.stdout

    def sqlite(self, sql: str, *, db: str = ATHENA_DB, separator: str = "|") -> list[list[str]]:
        out = self.run(f"sqlite3 -separator {shlex.quote(separator)} {db} {shlex.quote(sql)}")
        return [line.split(separator) for line in out.splitlines() if line]

    # -- reads ------------------------------------------------------------

    def configuration_state_revision(self) -> str:
        """
        The concurrency token a Transaction must carry.

        It rotates on **every** successful commit, so it must be re-read
        immediately before each tweak rather than cached across them.
        """
        rows = self.sqlite(
            "SELECT ConfigurationStateRevision FROM DatabaseMetadata"
        )
        if not rows or not rows[0] or not rows[0][0]:
            raise ProcessorError("could not read ConfigurationStateRevision")
        return rows[0][0]

    def columns(self, table: str) -> list[str]:
        rows = self.sqlite(f"PRAGMA table_info('{table}')")
        return [r[1] for r in rows if len(r) > 1]

    def object_row(self, table: str, object_id: int) -> dict[str, str]:
        cols = self.columns(table)
        if not cols:
            raise ProcessorError(f"no such table {table}")
        rows = self.sqlite(
            f"SELECT * FROM {table} WHERE ObjectID = {int(object_id)}"
        )
        if not rows:
            raise ProcessorError(f"{table} has no ObjectID {object_id}")
        return dict(zip(cols, rows[0]))

    def object_row_by_xid(self, table: str, xid: str) -> dict[str, str]:
        cols = self.columns(table)
        rows = self.sqlite(
            f"SELECT * FROM {table} WHERE ExtendedObjectID = {sql_quote(xid)}"
        )
        if not rows:
            raise ProcessorError(f"{table} has no ExtendedObjectID {xid}")
        return dict(zip(cols, rows[0]))

    def xid_tables(self) -> list[str]:
        """Tables carrying both ObjectID and ExtendedObjectID (63 on 26.05)."""
        rows = self.sqlite(
            "SELECT m.name FROM sqlite_master m "
            "WHERE m.type='table' AND EXISTS ("
            "  SELECT 1 FROM pragma_table_info(m.name) p "
            "  WHERE p.name='ExtendedObjectID') "
            "AND EXISTS ("
            "  SELECT 1 FROM pragma_table_info(m.name) p "
            "  WHERE p.name='ObjectID') "
            "ORDER BY m.name"
        )
        return [r[0] for r in rows if r and r[0]]

    def resolve_object(
        self, object_id: int, *, tables: list[str] | None = None
    ) -> tuple[str, str]:
        """
        (ExtendedObjectID, table) for a numeric ObjectID.

        There is no global identity table, so this searches every table that has
        both columns. ObjectIDs are globally unique in practice; if more than one
        table matches we refuse rather than guess.
        """
        tables = tables if tables is not None else self.xid_tables()
        union = " UNION ALL ".join(
            f"SELECT '{t}' AS tbl, ExtendedObjectID AS xid "
            f"FROM {t} WHERE ObjectID = {int(object_id)}"
            for t in tables
        )
        rows = self.sqlite(union)
        found = {(r[0], r[1]) for r in rows if len(r) > 1}
        if not found:
            raise ProcessorError(f"no object with ObjectID {object_id}")
        if len({xid for _, xid in found}) > 1:
            where = ", ".join(sorted(t for t, _ in found))
            raise ProcessorError(
                f"ObjectID {object_id} is ambiguous across tables: {where}"
            )
        table, xid = next(iter(found))
        return xid, table

    def resolve_xid(self, object_id: int, *, tables: list[str] | None = None) -> str:
        return self.resolve_object(object_id, tables=tables)[0]

    def object_type_names(self) -> dict[int, str]:
        rows = self.sqlite("SELECT ObjectTypeID, Description FROM ObjectType")
        return {int(r[0]): r[1] for r in rows if len(r) > 1}

    def dom_log_mark(self) -> int:
        out = self.run(f"wc -l < {DOM_LOG} 2>/dev/null || echo 0")
        try:
            return int(out.strip() or 0)
        except ValueError:
            return 0

    def dom_log_since(self, mark: int) -> list[str]:
        out = self.run(f"tail -n +{mark + 1} {DOM_LOG} 2>/dev/null || true", check=False)
        return out.splitlines()

    # -- the write --------------------------------------------------------

    def request_tweak(
        self, tweak_data_b64: str, operation_session_id: str, *, wait: int | None = None
    ) -> str:
        """
        Fire RequestDomManagedTweak and wait for the response.

        **Both** args are required. Omitting OperationSessionId fails at the JSON
        layer with `Non-singleton parser exists but failed to parse JSON`, which
        reads like a bad TweakData but means a missing sibling field.

        `-d` on its own is fire-and-forget: it queues the write, exits 0, and
        prints nothing — so a caller that omits `-o` commits the tweak and then
        reports failure because it never saw a result. `-o` blocks for the
        matching DomManagedTweakResponse, which is the only way to read the
        result code back.
        """
        payload = json.dumps(
            {
                "cmd": "RequestDomManagedTweak",
                "args": {
                    "TweakData": tweak_data_b64,
                    "OperationSessionId": operation_session_id,
                },
            }
        )
        expect = json.dumps({"cmd": "DomManagedTweakResponse"})
        if self.dry_run:
            return f"[dry-run] would send: {payload}"
        # Keep the remote wait inside the ssh timeout, or ssh kills the client
        # mid-wait and the tweak's result is lost even though it committed.
        if wait is None:
            wait = max(5, self.timeout - 5)
        return self.run(
            f"lutron-core-client -d {shlex.quote(payload)} "
            f"-o {shlex.quote(expect)} -t {int(wait)}",
            check=False,
        )


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def classify_dom_log(lines: list[str]) -> tuple[bool, str | None]:
    """
    Read a verdict out of DOM log lines.

    Returns (ok, reason). The DOM log is always on and carries the precise
    failure reason, unlike /var/log/core which needs debug enabled.
    """
    failures = (
        "cannot parse invalid wire-format data",
        "DTOType not registered",
        "does not match current",
        "no rows in result set",
        "deserializing tweaked data",
        "Failed to start database update",
    )
    for line in reversed(lines):
        for marker in failures:
            if marker in line:
                return False, line.strip()
    for line in reversed(lines):
        if "Tweak completed with success" in line or "UpdateSuccess={true}" in line:
            return True, None
    return False, None


def extract_result_code(core_output: str) -> int | None:
    """Pull `"Result":N` out of the DomManagedTweakResponse broadcast."""
    for chunk in core_output.splitlines():
        if "DomManagedTweakResponse" not in chunk and "Tweaker" not in chunk:
            continue
        marker = '"Result":'
        idx = chunk.find(marker)
        if idx == -1:
            continue
        tail = chunk[idx + len(marker) :].lstrip()
        digits = ""
        for ch in tail:
            if ch.isdigit():
                digits += ch
            else:
                break
        if digits:
            return int(digits)
    return None


def compose_outcome(core_output: str, dom_lines: list[str]) -> TweakOutcome:
    """
    Combine the DomManagedTweakResponse result with the DOM log.

    The result code decides; the log only explains. A successful tweak often
    writes nothing to the DOM log at all — that log carries rejections — so
    requiring a success line there would report every good tweak as a failure.
    When no result code came back (the response was missed), fall back to the
    log, where silence is treated as failure rather than assumed success.
    """
    code = extract_result_code(core_output)
    log_ok, reason = classify_dom_log(dom_lines)

    if code is None:
        return TweakOutcome(
            ok=log_ok,
            result_code=None,
            core_output=core_output,
            dom_log=dom_lines,
            reason=reason or "no DomManagedTweakResponse was seen",
        )

    ok = code == 0
    if not ok and reason is None:
        reason = f"core returned result {RESULT_CODES.get(code, code)}"
    return TweakOutcome(
        ok=ok, result_code=code, core_output=core_output, dom_log=dom_lines, reason=reason
    )


def row_to_values(
    row: Mapping[str, str],
    fields: list[Mapping[str, Any]],
    *,
    xid_lookup,
    type_lookup,
) -> dict[str, Any]:
    """
    Build a complete proto value map from an athena row.

    A tweaker Update replaces the whole record, so every field has to be filled
    from current state before overrides are applied — otherwise the omitted ones
    silently reset to proto3 defaults.

    `xid_lookup(object_id) -> str` resolves an integer reference to its
    ExtendedObjectID; `type_lookup(object_id) -> int` gives its ObjectType, used
    for the `*_type` companions that have no column of their own.
    """
    from dom_types import column_name

    values: dict[str, Any] = {}
    missing: list[str] = []

    for spec in fields:
        if spec.get("repeated"):
            continue
        name = spec["name"]
        col = column_name(name)

        if name.endswith("_xid"):
            if col not in row:
                missing.append(f"{name} (column {col})")
                continue
            values[name] = xid_lookup(int(row[col]))
            continue

        if col in row:
            raw = row[col]
            values[name] = raw if spec["type"] in ("string", "bytes") else int(raw)
            continue

        # `*_type` companions to a `*_xid` reference are derived, not stored.
        if name.endswith("_type"):
            ref_col = column_name(name[: -len("_type")] + "_xid")
            if ref_col in row:
                values[name] = type_lookup(int(row[ref_col]))
                continue

        missing.append(f"{name} (column {col})")

    if missing:
        raise ProcessorError(
            "could not fill every field from the database, so an Update would "
            "reset the rest: " + ", ".join(missing)
        )
    return values
