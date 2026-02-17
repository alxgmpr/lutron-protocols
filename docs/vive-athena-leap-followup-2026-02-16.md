# Vive/Athena LEAP Follow-up (2026-02-16)

## What changed from prior notes

Prior static RE of standalone `Vive.app` (`com.lutron.vive`) showed setup/status + cloud project APIs and did **not** reveal LEAP zone/area command routes.

Follow-up analysis of the currently running unified `Lutron` app binary (v26 lineage) shows explicit Athena + LEAP support and LEAP route families.

## Evidence: Athena + LEAP markers (unified app binary)

Observed in binary strings:

- `VAL_SYSTEM_TYPE_ATHENA`
- `Athena`
- `athenaLightingSystemName`
- `lblAthenaProcessor`
- `connectViaLEAP`
- `CommuniqueType`
- `/commandprocessor`
- `sendGoToDimmedLeveLCommandForZone(trait:)`
- `goToWarmDimZoneHref:curveDimmingHref:level:`
- `showFadeSettingsPassedFadeSettingsLAG:`
- `showLedSettingsStatusLedSettings:`
- `LoadControllersViewController`
- `/system/loadshedding/status`
- `/system/naturallightoptimization`

## LEAP route families extracted from unified app

Route strings recovered from Mach-O scan include:

- `/zone`
- `/zone/status`
- `/zone/status/expanded`
- `/area`
- `/area/summary`
- `/area/summary?where=`
- `/controlstation`
- `/button`
- `/buttongroup`
- `/buttongroup/expanded`
- `/areascene`
- `/areasceneassignment`
- `/presetassignment`
- `/device`
- `/device/status`
- `/device/status/deviceheard`
- `/device/commandprocessor`
- `/device?where=SerialNumber:`
- `/occupancygroup`
- `/occupancygroup/status`
- `/timeclock`
- `/timeclock/status`
- `/timeclockevent`
- `/timeclockevent?where=`
- `/system`
- `/system/action`
- `/system/away`
- `/system/commandprocessor`
- `/system/loadshedding/status`
- `/system/naturallightoptimization`
- `/server`
- `/project`
- `/project/contactinfo`
- `/project/masterdevicelist/devices`
- `/virtualbutton`
- `/associatedcontrolstation/commandprocessor`

## Where the “simple controls” are

For LEAP-capable systems (including Athena/Vive in unified app):

- Room/area-level control: area command processors + area scene resources.
- Zone on/off: zone command processor with switched-level commands.
- Zone dimming: zone command processor with dimmed-level commands.
- Live state: `/zone/status` subscriptions/reads and related area/device status routes.

This matches the same LEAP control model used in Caseta/RA3/HomeWorks app families, with Athena/commercial features layered on top (load shedding, NLO, load-controller UX).

## Runtime capture status

- Added helper script: `tools/capture-lutron-leap.sh`
- Validated capture pipeline; current live session traffic to processor on `tcp/8081` is TLS-only, so URIs are not visible from packets alone.
- Frida attach was blocked by macOS process-debug restrictions in this environment, so direct pre-TLS request interception could not be performed here.

