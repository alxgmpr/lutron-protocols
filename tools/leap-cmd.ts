#!/usr/bin/env bun

/**
 * LEAP Command Tool — send commands and config changes to zones via LEAP API
 *
 * Usage:
 *   bun run tools/leap-cmd.ts status                       # show zone status
 *   bun run tools/leap-cmd.ts level 75                     # set level to 75%
 *   bun run tools/leap-cmd.ts level 50 --fade 5            # fade to 50% over 5s
 *   bun run tools/leap-cmd.ts on / off                     # switch on/off
 *   bun run tools/leap-cmd.ts config                       # read all config
 *   bun run tools/leap-cmd.ts presets                      # read preset assignments
 *   bun run tools/leap-cmd.ts set-trim 95 5                # set high/low trim
 *   bun run tools/leap-cmd.ts set-fade 4                   # set fade on all presets (sec)
 *   bun run tools/leap-cmd.ts set-delay 2                  # set delay on all presets (sec)
 *   bun run tools/leap-cmd.ts set-preset 1243 -f 5 -d 2   # update single preset
 *   bun run tools/leap-cmd.ts watch                        # subscribe and watch events
 *   bun run tools/leap-cmd.ts raw ReadRequest /zone/5      # raw request
 */

import { parseArgs } from "util";
import { CASETA_HOST } from "../lib/env";
import { hrefId, LeapConnection } from "./leap-client";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", short: "h", default: CASETA_HOST },
    cert: { type: "string", short: "c", default: "caseta" },
    zone: { type: "string", short: "z", default: "73" },
    fade: { type: "string", short: "f" },
    delay: { type: "string", short: "d" },
    level: { type: "string", short: "l" },
  },
  allowPositionals: true,
});

const command = positionals[0] ?? "status";
const arg1 = positionals[1];
const arg2 = positionals[2];

/** Format seconds as HH:MM:SS */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Find zone by ID or name substring (case-insensitive) */
async function findZone(
  conn: LeapConnection,
  search: string,
): Promise<{ id: number; name: string; zone: any } | null> {
  const body = await conn.readBody("/zone");
  const zones = body?.Zones ?? [];

  const asNum = parseInt(search, 10);
  const match = !Number.isNaN(asNum)
    ? zones.find((z: any) => hrefId(z.href) === asNum)
    : zones.find((z: any) =>
        (z.Name ?? "").toLowerCase().includes(search.toLowerCase()),
      );
  if (!match) {
    console.error(`No zone matching "${search}". Available zones:`);
    for (const z of zones) {
      console.error(`  ${hrefId(z.href)}: ${z.Name}`);
    }
    return null;
  }
  const id = hrefId(match.href);
  const detail = await conn.readBody(`/zone/${id}`);
  return { id, name: match.Name, zone: detail?.Zone ?? match };
}

/** Get all preset assignments for a zone */
async function getZonePresets(conn: LeapConnection, zoneId: number) {
  const paBody = await conn.readBody("/presetassignment");
  const all = paBody?.PresetAssignments ?? [];
  return all.filter((pa: any) => pa.AffectedZone?.href === `/zone/${zoneId}`);
}

function dump(label: string, data: any) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(data, null, 2));
}

function presetSummary(pa: any): string {
  const id = hrefId(pa.href);
  const preset = pa.Parent?.href ? hrefId(pa.Parent.href) : "?";
  return `  pa/${id} (preset ${preset}): level=${pa.Level}% fade=${pa.Fade}s delay=${pa.Delay}s`;
}

async function main() {
  const conn = new LeapConnection({
    host: values.host!,
    certName: values.cert!,
  });
  await conn.connect();

  // --- raw command ---
  if (command === "raw") {
    const type = arg1 ?? "ReadRequest";
    const url = arg2 ?? "/server";
    const bodyArg = positionals[3];
    let body: any;
    if (bodyArg) body = JSON.parse(bodyArg);
    const resp = await conn.send(type, url, body);
    dump(`${type} ${url}`, resp);
    conn.close();
    return;
  }

  // --- watch (subscribe) ---
  if (command === "watch") {
    conn.onEvent = (msg) => {
      const ts = new Date().toISOString().slice(11, 23);
      const ct = msg.CommuniqueType ?? "?";
      const url = msg.Header?.Url ?? "";
      console.log(`\n[${ts}] ${ct} ${url}`);
      if (msg.Body) console.log(JSON.stringify(msg.Body, null, 2));
    };

    const subs = ["/zone/status", "/device/status"];
    for (const url of subs) {
      const resp = await conn.subscribe(url);
      const status = resp.Header?.StatusCode ?? "";
      console.log(`Subscribed: ${url} (${status})`);
      if (resp.Body?.ZoneStatuses) {
        for (const zs of resp.Body.ZoneStatuses) {
          const zid = zs.Zone?.href?.replace("/zone/", "") ?? "?";
          const sw = zs.SwitchedLevel ? ` [${zs.SwitchedLevel}]` : "";
          console.log(`  zone ${zid}: ${zs.Level}%${sw}`);
        }
      }
    }
    console.log("\nWatching for events... (Ctrl+C to stop)\n");
    await new Promise(() => {});
  }

  // --- zones (list all) ---
  if (command === "zones") {
    const body = await conn.readBody("/zone");
    for (const z of body?.Zones ?? []) {
      const id = hrefId(z.href);
      const statusBody = await conn.readBody(`/zone/${id}/status`);
      const zs = statusBody?.ZoneStatus;
      const level = zs?.Level ?? "?";
      const sw = zs?.SwitchedLevel ? ` [${zs.SwitchedLevel}]` : "";
      console.log(
        `  ${id}: ${z.Name} — ${level}%${sw} (${z.ControlType ?? "?"})`,
      );
    }
    conn.close();
    return;
  }

  // --- everything below needs a zone ---
  const found = await findZone(conn, values.zone!);
  if (!found) {
    conn.close();
    process.exit(1);
  }
  const { id: zoneId, name: zoneName, zone } = found;
  console.log(`Zone ${zoneId}: ${zoneName}`);

  switch (command) {
    case "status": {
      const statusResp = await conn.readBody(`/zone/${zoneId}/status`);
      dump("Zone Status", statusResp?.ZoneStatus);
      break;
    }

    case "info": {
      dump("Zone Detail", zone);
      break;
    }

    case "level": {
      const level = parseFloat(arg1 ?? "100");
      const params: any = { Level: level };
      if (values.fade) params.FadeTime = fmtTime(parseFloat(values.fade));
      if (values.delay) params.DelayTime = fmtTime(parseFloat(values.delay));

      console.log(`  GoToDimmedLevel: ${JSON.stringify(params)}`);
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: {
          CommandType: "GoToDimmedLevel",
          DimmedLevelParameters: params,
        },
      });
      dump("Response", resp.Body);
      break;
    }

    case "on": {
      console.log("  GoToSwitchedLevel: On");
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: {
          CommandType: "GoToSwitchedLevel",
          SwitchedLevelParameters: { SwitchedLevel: "On" },
        },
      });
      dump("Response", resp.Body);
      break;
    }

    case "off": {
      console.log("  GoToSwitchedLevel: Off");
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: {
          CommandType: "GoToSwitchedLevel",
          SwitchedLevelParameters: { SwitchedLevel: "Off" },
        },
      });
      dump("Response", resp.Body);
      break;
    }

    case "raise": {
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: { CommandType: "Raise" },
      });
      dump("Response", resp.Body);
      break;
    }

    case "lower": {
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: { CommandType: "Lower" },
      });
      dump("Response", resp.Body);
      break;
    }

    case "stop": {
      const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, {
        Command: { CommandType: "Stop" },
      });
      dump("Response", resp.Body);
      break;
    }

    case "config": {
      // Tuning settings
      if (zone.TuningSettings?.href) {
        const ts = await conn.readBody(zone.TuningSettings.href);
        if (ts) dump("Tuning Settings", ts);
      } else {
        console.log("  No TuningSettings href on zone");
      }

      // Phase settings
      const phase = await conn.readBody(`/zone/${zoneId}/phasesettings`);
      if (phase) dump("Phase Settings", phase);

      // LED settings (via device)
      const deviceHref = zone.Device?.href;
      if (deviceHref) {
        const led = await conn.readBody(`${deviceHref}/ledsettings`);
        if (led) dump("LED Settings", led);
      }

      // Fade settings (may be RA3-only)
      const fadeSets = await conn.readBody(`/zone/${zoneId}/fadesettings`);
      if (fadeSets && !fadeSets.Message) dump("Fade Settings", fadeSets);

      // Countdown timer
      if (zone.CountdownTimer?.href) {
        const ct = await conn.readBody(zone.CountdownTimer.href);
        if (ct) dump("Countdown Timer", ct);
      }

      // Preset assignments for this zone
      const presets = await getZonePresets(conn, zoneId);
      if (presets.length > 0) {
        console.log(`\n--- Preset Assignments (${presets.length}) ---`);
        for (const pa of presets) {
          console.log(presetSummary(pa));
        }
      }
      break;
    }

    case "presets": {
      const matching = await getZonePresets(conn, zoneId);
      if (matching.length === 0) {
        console.log("  No preset assignments for this zone");
      } else {
        for (const pa of matching) {
          dump(`PresetAssignment ${hrefId(pa.href)}`, pa);
        }
      }
      break;
    }

    // --- Config write commands ---

    case "set-trim": {
      const high = parseFloat(arg1 ?? "100");
      const low = parseFloat(arg2 ?? "0");
      if (!zone.TuningSettings?.href) {
        console.error("  No TuningSettings href on zone");
        break;
      }
      console.log(`  Setting trim: high=${high}%, low=${low}%`);
      const resp = await conn.update(zone.TuningSettings.href, {
        TuningSettings: { HighEndTrim: high, LowEndTrim: low },
      });
      const status = resp.Header?.StatusCode ?? "?";
      console.log(`  -> ${status}`);
      if (resp.Body) dump("Response", resp.Body);
      break;
    }

    case "set-led": {
      // set-led idle on|off / set-led nightlight on|off / set-led on|off (both)
      const target = (arg1 ?? "").toLowerCase();
      const state = (arg2 ?? arg1 ?? "").toLowerCase();
      const deviceHref = zone.Device?.href;
      if (!deviceHref) {
        console.error("  No device associated with this zone");
        break;
      }
      // Read current settings to get href
      const ledBody = await conn.readBody(`${deviceHref}/ledsettings`);
      const ledSettings = ledBody?.LEDSettings;
      if (!ledSettings?.href) {
        console.error("  Could not read LED settings for this device");
        break;
      }
      const toState = (s: string) =>
        s === "on" || s === "enabled" ? "Enabled" : "Disabled";

      const updateBody: any = {};
      if (target === "idle") {
        updateBody.IdleLED = { EnabledState: toState(state) };
      } else if (target === "nightlight" || target === "night") {
        updateBody.NightlightLED = { EnabledState: toState(state) };
      } else {
        // Apply to both
        const s = toState(target); // arg1 is the state when no target specified
        updateBody.IdleLED = { EnabledState: s };
        updateBody.NightlightLED = { EnabledState: s };
      }
      console.log(
        `  Updating ${ledSettings.href}: ${JSON.stringify(updateBody)}`,
      );
      const ledResp = await conn.update(ledSettings.href, {
        LEDSettings: updateBody,
      });
      const ledStatus = ledResp.Header?.StatusCode ?? "?";
      console.log(`  -> ${ledStatus}`);
      if (ledResp.Body) dump("Response", ledResp.Body);
      break;
    }

    case "set-timer": {
      // set-timer 15:00 / set-timer off / set-timer 5:00
      const timerArg = arg1 ?? "off";
      if (!zone.CountdownTimer?.href) {
        // Try to create one
        if (timerArg === "off" || timerArg === "disable") {
          console.log("  No countdown timer exists for this zone");
          break;
        }
        console.log(`  Creating countdown timer: ${timerArg}`);
        const resp = await conn.create(`/zone/${zoneId}/countdowntimer`, {
          CountdownTimer: { Timeout: timerArg, EnabledState: "Enabled" },
        });
        const s = resp.Header?.StatusCode ?? "?";
        console.log(`  -> ${s}`);
        if (resp.Body) dump("Response", resp.Body);
      } else {
        const enabled = timerArg !== "off" && timerArg !== "disable";
        const update: any = { EnabledState: enabled ? "Enabled" : "Disabled" };
        if (enabled) update.Timeout = timerArg;
        console.log(
          `  Updating ${zone.CountdownTimer.href}: ${JSON.stringify(update)}`,
        );
        const resp = await conn.update(zone.CountdownTimer.href, {
          CountdownTimer: update,
        });
        const s = resp.Header?.StatusCode ?? "?";
        console.log(`  -> ${s}`);
        if (resp.Body) dump("Response", resp.Body);
      }
      break;
    }

    case "set-phase": {
      const direction = arg1 ?? "Forward";
      console.log(`  Setting phase: ${direction}`);
      const resp = await conn.update(`/zone/${zoneId}/phasesettings`, {
        PhaseSettings: { Direction: direction },
      });
      const status = resp.Header?.StatusCode ?? "?";
      console.log(`  -> ${status}`);
      if (resp.Body) dump("Response", resp.Body);
      break;
    }

    case "set-fade": {
      const fadeSec = parseFloat(arg1 ?? "2");
      const presets = await getZonePresets(conn, zoneId);
      if (presets.length === 0) {
        console.error("  No preset assignments for this zone");
        break;
      }
      console.log(
        `  Setting fade=${fadeSec}s on ${presets.length} preset assignments`,
      );
      for (const pa of presets) {
        const paId = hrefId(pa.href);
        const resp = await conn.update(pa.href, {
          PresetAssignment: { Fade: fadeSec },
        });
        const status = resp.Header?.StatusCode ?? "?";
        console.log(`  pa/${paId} -> ${status}`);
      }
      break;
    }

    case "set-delay": {
      const delaySec = parseFloat(arg1 ?? "0");
      const presets = await getZonePresets(conn, zoneId);
      if (presets.length === 0) {
        console.error("  No preset assignments for this zone");
        break;
      }
      console.log(
        `  Setting delay=${delaySec}s on ${presets.length} preset assignments`,
      );
      for (const pa of presets) {
        const paId = hrefId(pa.href);
        const resp = await conn.update(pa.href, {
          PresetAssignment: { Delay: delaySec },
        });
        const status = resp.Header?.StatusCode ?? "?";
        console.log(`  pa/${paId} -> ${status}`);
      }
      break;
    }

    case "set-preset": {
      // Update a single preset assignment by ID
      const paId = parseInt(arg1 ?? "0", 10);
      if (!paId) {
        console.error(
          "  Usage: set-preset <preset-assignment-id> [-f fade] [-d delay] [-l level]",
        );
        break;
      }
      const update: any = {};
      if (values.fade) update.Fade = parseFloat(values.fade);
      if (values.delay) update.Delay = parseFloat(values.delay);
      if (values.level) update.Level = parseFloat(values.level);
      if (Object.keys(update).length === 0) {
        console.error("  Provide at least one of: -f fade, -d delay, -l level");
        break;
      }
      console.log(`  Updating pa/${paId}: ${JSON.stringify(update)}`);
      const resp = await conn.update(`/presetassignment/${paId}`, {
        PresetAssignment: update,
      });
      const status = resp.Header?.StatusCode ?? "?";
      console.log(`  -> ${status}`);
      if (resp.Body) dump("Response", resp.Body);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error(`
Commands:
  status                          Show zone status
  info                            Show full zone detail
  zones                           List all zones with status
  level <pct> [-f sec] [-d sec]   Set dimmed level with optional fade/delay
  on / off                        Switch on/off
  raise / lower / stop            Ramp control
  config                          Read all config (trim, phase, timer, presets)
  presets                         Read preset assignments for zone

Config writes:
  set-trim <high> <low>           Update high/low end trim
  set-phase <Forward|Reverse>     Update phase setting
  set-led idle on|off             Set idle LED (status light when off)
  set-led nightlight on|off       Set nightlight LED mode
  set-led on|off                  Set both LED modes at once
  set-timer <MM:SS>               Set/create countdown timer
  set-timer off                   Disable countdown timer
  set-fade <seconds>              Set fade time on all zone presets
  set-delay <seconds>             Set delay time on all zone presets
  set-preset <id> [-f] [-d] [-l]  Update single preset assignment

Other:
  watch                           Subscribe to live zone/device events
  raw <Type> <url> [body]         Send arbitrary LEAP request

Options:
  -h, --host <ip>      Processor IP (default: $CASETA_HOST)
  -c, --cert <name>    Cert name (default: caseta)
  -z, --zone <id|name> Zone ID or name search (default: 73)
  -f, --fade <sec>     Fade time in seconds
  -d, --delay <sec>    Delay time in seconds
  -l, --level <pct>    Level percentage`);
      process.exit(1);
  }

  conn.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
