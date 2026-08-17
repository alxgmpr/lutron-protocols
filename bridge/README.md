Bridges Lutron radio traffic into Home Assistant (and WiZ WiFi lights). Not
related to Lutron's own factory bridges.

## Two add-ons

| Add-on | Slug | Source | Entry point | Manifest |
|---|---|---|---|---|
| **openlutron Bridge** | `openlutron-bridge` | openlutron board over UDP :9433 — **CCA + CCX** | `bridge/openlutron-main.ts` | `bridge/openlutron-addon/` |
| CCX-WiZ Bridge | `ccx-bridge` | nRF sniffer dongle over serial — CCX only | `bridge/main.ts` | `bridge/ha-addon/` |

**openlutron-bridge supersedes ccx-bridge.** It hears both radios instead of
one, and needs no Thread channel or master key — the board is a Thread node, so
CCX frames arrive already decrypted. What it needs instead is network access to
the board (`openlutron_host`).

Run **one at a time** against a given broker: both publish the same topics, and
two bridges announcing the same entities will fight.

Deploy either with the same script:

```bash
./bridge/deploy-ha.sh /Volumes/config /Volumes/addons              # openlutron (default)
ADDON=ccx ./bridge/deploy-ha.sh /Volumes/config /Volumes/addons    # sniffer
```

Both add-ons read LEAP data from `/config/ccx-bridge/` on HA.

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

- A zone appears as **one** entity regardless of how many transports observe
  it — topics carry identity, not protocol.
- A **control**'s id names its transport (`cca_deadbeef`, `ccx_0c2cef20`),
  because a CCA wire id and a CCX one are both four undifferentiated bytes and
  a collision would merge two physical controls into one entity.
- On the openlutron add-on, the source name is `openlutron` — one stream, one
  health topic, even though it carries two radios. It reads `offline` until the
  board actually answers: UDP has no handshake, so a bound socket proves
  nothing.
- Entities depend on both `lutron/bridge/availability` and their source's
  availability topic (`availability_mode: all`), so a dead sniffer greys out
  its own entities without marking the whole bridge down.
- Button events are deliberately **not** retained: a retained press would
  re-fire every bound automation each time HA restarts.

Full design notes: `docs/tooling/ccx-wiz-bridge.md` §9.5.
