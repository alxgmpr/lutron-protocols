# Designer

*Reverse-engineering of Lutron Designer: its database, project format, and RA3 ↔ HomeWorks integration.*

Designer is Lutron's commissioning and programming application, run in a VM at the
configured IP (see `config.json` / project conventions). This section documents its
database structure, project-format internals, and the RA3 ↔ HomeWorks integration
work that lets a RadioRA 3 processor run HomeWorks-style programming.

- [Database](database.md) — Designer's SQL Server LocalDB schema and project tables
- [RA3 ↔ HomeWorks migration](ra3-hw-migration.md) — full identity migration and the ID-only switch workflow
- [Cycle dimming](cycle-dim.md) — cycle-dim button programming and validation

DLL-patch / jailbreak material (universal platform unlock, channel-compat patches)
lives in the private `~/redacted-security-repo/docs-security/` repo, not here.
</content>
