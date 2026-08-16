This bridge is for bridging CCX commands to WiZ WiFi lights via Home Assistant. It's not related directly to Lutron factory bridges.

## MQTT / Home Assistant discovery

Optional. With no broker configured the bridge behaves exactly as it did
before and never even imports `mqtt`.

### Prerequisites

1. An MQTT broker. The Mosquitto broker add-on is the usual choice.
2. The **MQTT integration** configured in HA — discovery only works if HA is
   subscribed to the discovery prefix.

### Configure

HA add-on → Configuration:

| Option | Value |
|---|---|
| `mqtt_url` | `mqtt://<broker-host>:1883` |
| `mqtt_username` / `mqtt_password` | broker credentials, if any |
| `mqtt_base_topic` | `lutron` (default) |
| `mqtt_discovery_prefix` | `homeassistant` (default) |

The add-on runs with `host_network: true`, so supervisor-internal hostnames
are not guaranteed to resolve. If `mqtt://core-mosquitto:1883` fails with a
DNS error or ECONNREFUSED in the add-on log, use the HA host's IP instead.

Standalone (Docker / local `npx tsx bridge/main.ts`) reads the same settings
from the environment: `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`,
`MQTT_BASE_TOPIC`, `MQTT_DISCOVERY_PREFIX`.

### What appears

The startup banner prints an `MQTT:` line — either the broker URL or
`disabled`. Once connected:

```
lutron/zone/<zoneId>/state                 retained
lutron/device/<deviceId>/event             NOT retained
lutron/bridge/availability                 retained, also the LWT
lutron/bridge/source/<name>/availability   retained
```

Entities are announced lazily, the first time a zone or control is *seen*, so
nothing shows up in HA until traffic happens. Touch a light for a `light`
entity; press a Pico or keypad button for an `event` entity.

`event` entities fire with `event_type` of `press`, `hold` or `release` —
`hold`/`release` come from Pico raise/lower. Use them as automation triggers.

### Verify without HA

```bash
mosquitto_sub -h <broker-host> -v -t 'lutron/#' -t 'homeassistant/#'
```

### Notes

- A zone or control appears as **one** entity regardless of how many
  transports observe it — topics carry identity, not protocol.
- Entities depend on both `lutron/bridge/availability` and their source's
  availability topic (`availability_mode: all`), so a dead sniffer greys out
  its own entities without marking the whole bridge down.
- Button events are deliberately **not** retained: a retained press would
  re-fire every bound automation each time HA restarts.

Full design notes: `docs/tooling/ccx-wiz-bridge.md` §9.5.
