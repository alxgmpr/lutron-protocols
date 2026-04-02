# Fix: "Account not able to open this project" with RA3 devices in HW projects

## Problem

After adding an RA3 device (e.g., RR-3PD) to a Homeworks project, Designer blocks you from opening the project with:

> "Your account is not able to open this project"

This happens because RA3 model families lack the HW platform bits in the SQLMODELINFO database. Designer checks `TOOLBOXPLATFORMTYPES` on project load and refuses to open if it finds a device whose family isn't flagged for the current platform.

## Fix

Run this SQL against the **SQLMODELINFO** database on LocalDB **before** clicking "Leave remote services disabled" in the Designer startup dialog:

```sql
USE [C:\PROGRAMDATA\LUTRON\LUTRONELECTRONICS.LUTRONDESIGNERGAMMA_HB4QHWKZQ4PCY\ALEX\LUTRON DESIGNER 26.0.2.100\SQLMODELINFO.MDF];

UPDATE TBLFAMILYCATEGORYINFO
SET TOOLBOXPLATFORMTYPES = TOOLBOXPLATFORMTYPES | 4128
FROM TBLFAMILYCATEGORYINFO f
JOIN TBLFAMILYCATINFOMODELINFOMAP fm ON fm.FAMILYCATEGORYINFOID = f.FAMILYCATEGORYINFOID
JOIN TBLMODELINFO m ON m.MODELINFOID = fm.MODELINFOID
WHERE m.LUTRONMODELNUMBERBASE LIKE 'RR%'
AND f.TOOLBOXPLATFORMTYPES & 4128 = 0;
```

This ORs in the HW platform bits (4128) to all RadioRA model families.

## Timing

The patch must be applied **every time Designer starts**, because Designer reloads SQLMODELINFO from its pristine copy on launch. The window to run it is:

1. Launch Designer
2. Designer shows the "remote services" dialog — SQLMODELINFO is already loaded at this point
3. Run the SQL patch (via MCP `designer-db` tool or `sqlcmd`)
4. Click "Leave remote services disabled"
5. Open the HW project — it now loads successfully

## Context

This is Gate 3 of the RA3-to-HW model validation. See `docs/infrastructure/ra3-hw-migration.md` for the full set of validation gates and the device migration workflow.
