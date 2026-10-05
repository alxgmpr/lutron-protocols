# Sunnata LED brightness: sunrise/sunset experiment

Findings from a 2026-10-04 investigation using Designer **26.6.0.144** and a
HomeWorks project on a modified RadioRA 3 processor. These results concern control
LEDs, not connected lighting loads. They do not establish behavior on a stock QSX
installation.

A Sunnata hybrid keypad sunrise/sunset candidate was prepared in an isolated
project copy, but **has not been transferred or physically tested**. A Sunnata
dimmer cannot reuse its native intensity assignments through the inspected
Designer command catalog, which does not register those commands for dimmers.

## Ambient sensing versus scheduled intensity

Palladiom Dynamic Backlighting Management (DBM) adjusts engraving backlight
intensity with ambient lighting. See Lutron's
[Palladiom specification, 369881](https://assets.lutron.com/a/documents/369881_eng.pdf).
The published Sunnata keypad specification describes button LED bars and status
intensity adjustable through system programming, but does not document equivalent
ambient-light DBM. See the
[RadioRA 3 Sunnata keypad specification, 3691168, pages 1–2](https://assets.lutron.com/a/documents/3691168_eng.pdf).
That specification does not prove runtime intensity changes on a HomeWorks hybrid
keypad.

A sunrise/sunset schedule switches between two chosen intensities; it does not
continuously measure room illumination. Lutron's built-in Day/Night feature
documented for smart lighting controls lighting zones, not wall-control LED
brightness. See the
[Lumaris programming overview](https://support.lutron.com/us/en/product/homeworks/article/ketra-and-lighting/Lumaris-Tape-Light-Programming).
The candidate below uses direct timeclock recalls without a separate Day/Night
variable.

## Designer command compatibility

Static inspection of the installed `Lutron.Gulliver.InfoObjects.dll`, method
`ControlTypeCommandTypeParameterTypeReference.LoadMappingInformation`, found:

| Control type | Registered commands relevant to this check | Intensity commands registered? |
| --- | --- | --- |
| KeyPad (`19`) | GoToLockState (`19`), GotoLevelWithOptions (`27`), SetBacklightIntensity (`60`), SetStatusIntensity (`61`) | Yes |
| Dimmer (`31`) | GoToLockState (`19`), GotoLevelWithOptions (`27`) | No |
| Switch (`32`) | GoToLockState (`19`), GotoLevelWithOptions (`27`) | No |

The dimmer's command `27` uses level/fade/level-option parameters, not intensity
parameters `58`/`59`/`60`. Retargeting keypad SQL assignments to a dimmer would
bypass the native command catalog rather than establish supported programming.
This is specific to the inspected build; it does not prove every processor or
firmware path is incapable of changing dimmer LEDs.

Command registration, a valid project, successful transfer, and physical device
behavior are separate checks. The repository also records negative CCX keypad
runtime-intensity tests in [the IPL reference](../protocols/ipl.md).
Those tests do not constitute a transfer or physical result for this candidate.

## Hybrid keypad candidate — artifact validated, hardware untested

Live LEAP identified the target as **HRST-HN4B-XX**. Preparation used a separate
LocalDB copy of a saved project; the original project and live processor were
unchanged.

| Event | Trigger | Offset | Active status intensity |
| --- | --- | --- | --- |
| Day | Sunrise | 0 | 100 |
| Night | Sunset | 0 | 25 |

The timeclock runs daily in Normal mode, with catch-up enabled on the clock and
both events. Idle LED settings and existing lighting events are unchanged.
Values `100`/`25` are Designer assignment values, not raw CCX bytes or measured
physical brightness.

Each preset has one `SetStatusIntensity` assignment (`61`), command group
`StatusIntensity` (`40`), targeting the keypad as a `ControlStationDevice` (`5`):

| Parameter | Meaning | Candidate value |
| --- | --- | --- |
| 58 | ComponentNumberRange | 0 |
| 59 | IntensityType | StatusIntensity (`110`) |
| 60 | IntensityValue | 100 for Day; 25 for Night |

The component-range value and hardware execution remain unverified. IDs were
reserved through `sel_NextObjectID`. A rollback-only dry run and saved candidate
passed programming-model issue checks, `DBCC CHECKDB`, `RESTORE VERIFYONLY WITH
CHECKSUM`, ZIP integrity, and extracted-backup SHA-256 verification. Those checks
validate the artifact, not transfer or LED behavior. An unchanged saved-project
rollback snapshot was also preserved; private project files are not published.

Remaining validation:

1. Open the candidate in Designer and inspect both timeclock assignments.
2. Transfer it, then manually invoke Day and Night and observe LEDs.
3. Read LEAP `/preset/<day-preset-id>` and `/preset/<night-preset-id>` to check
   whether the presets reached the processor. Presence alone does not prove LED
   execution; use the IDs from the test project.
4. Verify keypad buttons and the hybrid's local load still operate normally.
5. If the test fails, reopen and transfer the before snapshot.

## Sunnata dimmer — native scheduling limitation

Live LEAP identified a **HRST-PRO-N-XX** / `SunnataDimmer`, CCX firmware
**003.014.017r000**. Read-only SQL on the saved-project copy found
`ZoneOnIndicatorIntensity=60` and `ZoneOffIndicatorIntensity=8` on its
`ZoneControlUI` row. These are saved configuration values, not current physical
readback and not percentages. The keypad candidate was not retargeted, and no
dimmer LED writes, transfers, firmware changes, or reboots were performed.

Earlier read-only LEAP probes returned `500 InternalServerError` for
`/device/<dimmer-id>/ledsettings` and `/zonecontroller/<ui-id>`, and
`400 BadRequest` for `/ledsettings` and `/device/<dimmer-id>/zonecontrollers`.
IPL runtime-property reads for BacklightIntensity (`46`) and StatusIntensity
(`110`) on UI type `9` and device type `5` were acknowledged but returned no
matching intensity telemetry in the observation window. A zone-level read was a
positive control. These results do not establish a working intensity getter or
setter.

## Alternate dimmer route: complete CCX records

Repository captures describe dimmer/switch LED settings in **AAM**, object type
**9**, fields **7** (on) and **8** (off). Keypads use **AHA**, object type **108**,
fields **4** and **5**. See
[CCX CoAP configuration records](../protocols/ccx/coap.md#known-cbor-formats).

**PUT replaces the complete record.** A brightness-only AAM write can remove
button configuration; a prior repository test disabled a dimmer's off button
until a Designer transfer restored it. A write-only/empty GET cannot supply a
complete rollback baseline.

Before scheduling this route, obtain the complete current record and an exact
rollback, change one device, verify LEDs and all local controls, and restore it.
Saved Designer fields can help reconstruct a record, but the complete
serialization must be established before writing. Do not apply the keypad AHA
inactive-intensity floor to AAM: zero is valid for AAM indicator fields in the
recorded captures.

No configured bidirectional CCX bridge was available during this investigation,
so this route was not attempted. A working CCX bridge or a verified processor-side
record-editing route is still needed. Direct dimmer changes and sunrise/sunset
automation remain proposals, not tested behavior in this investigation.
