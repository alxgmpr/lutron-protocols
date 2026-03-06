# Lutron Dimming Curve Definitions

## Source
Extracted from Lutron Designer LocalDB `SqlModelInfo.mdf` v26.0.1.100, table `TBLDimCurveDefinition`.

## Database Structure

### Tables (in SqlModelInfo.mdf)
- `TBLDimCurveDefinition` — curve parameters (knots, coefficients, CCT range)
- `TBLWarmDimCurveGroupInfo` — named groups of curves
- `TBLWarmDimCurveGroupToWarmDimCurveMap` — which curves belong to which groups
- `TBLDualCCTConfigInfo` — dual-CCT channel configuration

### Curve Groups
| GroupID | Description |
|---------|-------------|
| 1 | Ketra |
| 2 | Lumaris Soft White |
| 3 | Lumaris Daylight |
| 4 | WhiteTune1800To5500K |
| 5 | MultiChannelTapeController |
| 6 | RobinTrimKit |

### Group → Curve Mappings
| Group | Curves (by SortOrder) |
|-------|----------------------|
| 1 (Ketra) | 1, 5, 2, 3, 4 |
| 2 (Lumaris Soft White) | 1, 5, 2, 3 |
| 3 (Lumaris Daylight) | 4 (only curve 4) |
| 4 (WhiteTune1800To5500K) | 1, 5, 2, 3, 4 |
| 5 (MultiChannelTapeController) | 1, 5, 2, 3 |
| 6 (RobinTrimKit) | 5, 2, 3 |

## Curve Definitions

All values are hex. Knots define spline breakpoints, coefficients define the spline segments between knots.

### Curve 1 — NameStringID: 36216 (IntensityFadeDomainID: 1)
**Has both xy chromaticity AND CCT splines — this is the full warm-dim "Modified Halogen" curve.**

**CIE xy Chromaticity Spline (11 knots):**
- Knots: `0x7, 0x7, 0x7, 0x3a, 0x117, 0x375, 0xa21, 0x21c4, 0x7fff, 0x7fff, 0xffff`
- x Coefficients (8): `0x1335, 0x121d, 0x11d1, 0x10e6, 0x107c, 0xf8b, 0xec5, 0xe7f`
- y Coefficients (8): `0xc96, 0xcca, 0xd27, 0xd2f, 0xd59, 0xd4d, 0xd3c, 0xd25`

**CCT Spline (11 knots):**
- Knots: `0x3, 0x3, 0x3, 0xd0, 0x27f, 0x519, 0x89e, 0x2129, 0x7f7f, 0x7f7f, 0xffff`
- Coefficients (8): `0x706, 0x702, 0x794, 0x7ff, 0x845, 0x95d, 0xa83, 0xaf2`

### Curve 2 — NameStringID: 34638 (IntensityFadeDomainID: 2)
**CCT-only spline — likely "Finiré 2700K"**

**CCT Spline (11 knots, but only 8 unique — last 2 are max-value repeats):**
- Knots: `0x20, 0x20, 0x20, 0x79c, 0x10f9, 0x1def, 0x4856, 0x7fff, 0x7fff, 0xffff, 0xffff`
- Coefficients (8): `0x6f8, 0x6e0, 0x7cf, 0x8b2, 0x9d8, 0xa80, 0xaa0, 0xffff`

No xy data (NULL).

### Curve 3 — NameStringID: 34639 (IntensityFadeDomainID: 2)
**CCT-only spline — likely "Finiré 3000K"**

**CCT Spline (11 knots):**
- Knots: `0x20, 0x20, 0x20, 0x6dc, 0x1c4b, 0x488a, 0x7fff, 0x7fff, 0xffff, 0xffff, 0xffff`
- Coefficients (8): `0x702, 0x6e4, 0x8e6, 0xac7, 0xbaf, 0xbe0, 0xffff, 0xffff`

No xy data (NULL). Note the 0xffff coefficients — the curve saturates to max CCT.

### Curve 4 — NameStringID: 36217 (IntensityFadeDomainID: 1)
**Simple linear CCT — no spline, just min/max bounds.**

- bendCoefficient: `2900`
- cctMin: `2500`
- cctMax: `5000`

All knot/coefficient fields are NULL. This is likely "Daylight" mode — linear interpolation between 2500K and 5000K with a bend at 2900K.

### Curve 5 — No name (NameStringID: NULL) (IntensityFadeDomainID: 1)
**CCT-only spline — unnamed/default**

**CCT Spline (11 knots):**
- Knots: `0x20, 0x20, 0x20, 0xbb, 0x25f, 0x872, 0x1269, 0x201f, 0x7fff, 0x7fff, 0xffff`
- Coefficients (8): `0x708, 0x743, 0x798, 0x826, 0x8bf, 0x971, 0xa7b, 0xaf0`

No xy data (NULL).

## Interpretation

### Spline Structure
- **11-knot B-spline** — first 3 and last 2 knots are repeated (clamped/open uniform B-spline)
- **8 coefficients** per dimension = degree-3 (cubic) B-spline with 8 control points
- Knot multiplicity at endpoints ensures the curve passes through the first and last control points

### Value Encoding
- Knots appear to be in a **0x0000–0xFFFF intensity domain** (0 = off, 0xFFFF = full on)
  - This matches the CCA level encoding: `level16 = percent * 0xFEFF / 100`
- CCT coefficients are in a **scaled CCT space** — values like 0x706 (1798), 0xaf2 (2802)
  - These likely map to actual Kelvin values via a scaling factor
  - Curve 4's explicit cctMin=2500, cctMax=5000 with bend=2900 gives us a reference point
- xy coefficients for Curve 1: x ranges ~0xe7f to ~0x1335 (3711-4917), y ranges ~0xc96 to ~0xd59 (3222-3417)
  - These are likely CIE 1931 xy coordinates scaled by some factor (possibly ×10000)
  - x: 0.37–0.49, y: 0.32–0.34 — this traces the Planckian locus from ~2700K to ~1800K (warm dim!)

### IntensityFadeDomainID
- Domain 1: Used by curves 1, 4, 5 — these are "standard" intensity curves
- Domain 2: Used by curves 2, 3 — these may use a different intensity-to-output mapping

### Connection to Transfer Log Tables
The transfer log showed 4 separate curve table types:
- `WarmDimCurve` → maps to curve 1 (full xy + CCT warm dim)
- `XYSpline11KnotDimCurve` → the xy chromaticity spline data (11 knots, as confirmed)
- `CCTSpline11KnotDimCurve` → the CCT-only spline data (11 knots, as confirmed)
- `McCaseyDimCurve` → likely curve 4 (the simple min/max/bend — "McCasey" may be an internal algorithm name for linear CCT interpolation with a bend coefficient)

## LocalDB Access

```bash
# SSH into VM
ssh $DESIGNER_VM_USER@$DESIGNER_VM_HOST

# Connect to Lutron Designer LocalDB (must disable encryption with -No)
sqlcmd -S "np:\\.\pipe\LOCALDB#CEA130DB\tsql\query" -No

# Databases on this instance:
# - Project                  (the active project database — 268 tables)
# - SqlModelInfo.mdf         (device model definitions — contains curve data)
# - SqlReferenceInfo.mdf     (reference/lookup data)
# - SqlApplicationData.mdf   (app settings per version)

# Switch to ModelInfo DB:
USE [C:\PROGRAMDATA\LUTRON\LUTRONELECTRONICS.LUTRONDESIGNERGAMMA_HB4QHWKZQ4PCY\ALEX\LUTRON DESIGNER 26.0.1.100\SQLMODELINFO.MDF]

# Query curves:
SELECT * FROM TBLDimCurveDefinition ORDER BY DimCurveId
SELECT * FROM TBLWarmDimCurveGroupInfo
SELECT * FROM TBLWarmDimCurveGroupToWarmDimCurveMap ORDER BY WarmDimCurveGroupID, SortOrder
```
