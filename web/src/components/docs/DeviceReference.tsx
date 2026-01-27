import { useState } from 'react'
import './DeviceReference.css'

// CCA Protocol Device Signatures
// Based on actual RF captures and protocol analysis

// Pico pairing packet signatures (from B8/B9/BA/BB packets)
// These bytes determine device behavior and button mapping
export interface PairingSignature {
  id: string
  name: string
  packetType: string   // B8, B9, BA, BB
  b10: number          // Byte 10: Button scheme (0x04=5-button style, 0x0B=4-button style)
  b30: number          // Byte 30: Capability flags
  b31: number          // Byte 31: Capability flags
  b37: number          // Byte 37: Button count/type indicator
  b38: number          // Byte 38: Device class indicator
  buttonCodes: number[] // Which button codes this device uses
  description: string
  observed: string[]   // Where we've seen this signature
}

// Known pairing signatures from captures
// The b38 byte appears to encode the "engraving type" - what labels the app shows
export const PAIRING_SIGNATURES: PairingSignature[] = [
  // ========== CONFIRMED SIGNATURES ==========
  {
    id: '5btn',
    name: '5-Button (ON/FAV/OFF/Raise/Lower)',
    packetType: 'B9',
    b10: 0x04,
    b30: 0x03,
    b31: 0x00,
    b37: 0x02,
    b38: 0x06,
    buttonCodes: [0x02, 0x03, 0x04, 0x05, 0x06],
    description: 'PJ2-3BRL-GWH-L01. Standard 5-button dimmer Pico. Direct-pairable.',
    observed: ['05851117 (Living Room)', 'Well documented']
  },
  {
    id: '2btn-paddle',
    name: '2-Button Paddle (ON/OFF)',
    packetType: 'B9',
    b10: 0x04,
    b30: 0x03,
    b31: 0x08,
    b37: 0x01,
    b38: 0x01,
    buttonCodes: [0x02, 0x04],
    description: 'Simple ON/OFF paddle. Direct-pairable. No dimming.',
    observed: ['B9E19B05']
  },
  {
    id: '4btn-rl',
    name: '4-Button Raise/Lower (ON/OFF/Raise/Lower)',
    packetType: 'B9',
    b10: 0x0B,
    b30: 0x02,
    b31: 0x00,
    b37: 0x02,
    b38: 0x21,
    buttonCodes: [0x08, 0x09, 0x0A, 0x0B],
    description: 'PJ2-4B-GWH-L01. 4-button with raise/lower. Direct-pairable.',
    observed: ['08692d70 (paired to Caseta and RA3)']
  },
  {
    id: '4btn-scene-custom',
    name: '4-Button Custom Scene',
    packetType: 'B9',
    b10: 0x0B,
    b30: 0x04,
    b31: 0x00,
    b37: 0x02,
    b38: 0x28,
    buttonCodes: [0x08, 0x09, 0x0A, 0x0B],
    description: 'Custom-engraved scene Pico. Direct-pairable. OFF button can be customized to a scene.',
    observed: ['Confirmed via capture']
  },
  {
    id: '4btn-scene-relax',
    name: '4-Button Scene: Bright/Entertain/Relax/Off',
    packetType: 'BA',
    b10: 0x0B,
    b30: 0x04,
    b31: 0x00,
    b37: 0x02,
    b38: 0x27,
    buttonCodes: [0x08, 0x09, 0x0A, 0x0B],
    description: 'PJ2-4B-GWH-P03. Standard scene Pico. Bridge-only (BA packet).',
    observed: ['084b1ebb (Hallway)', '702D6908']
  },

  // ========== NEEDS CAPTURE - Different b38 values expected ==========
  {
    id: '2btn-home-away',
    name: '2-Button Scene: Home/Away',
    packetType: 'BA',  // Likely BA since it's a scene type
    b10: 0x04,  // Assumed - uses 5btn-style codes
    b30: 0x00,  // NEEDS CAPTURE
    b31: 0x00,  // NEEDS CAPTURE
    b37: 0x00,  // NEEDS CAPTURE
    b38: 0x00,  // NEEDS CAPTURE - This should identify it as Home/Away engraving
    buttonCodes: [0x02, 0x04],  // Broadcasts ON/OFF but app shows Home/Away
    description: 'PJ2-2B-GWH-P01. Scene 2-button. App shows Home/Away labels. NEEDS PAIRING CAPTURE.',
    observed: ['NEEDS CAPTURE to identify b38 engraving code']
  },
  {
    id: '4btn-scene-cooking',
    name: '4-Button Scene: Bright/Cooking/Dining/Off',
    packetType: 'BA',  // Likely BA
    b10: 0x0B,
    b30: 0x04,  // Assumed same as other 4btn scenes
    b31: 0x00,
    b37: 0x02,
    b38: 0x00,  // NEEDS CAPTURE - Different from 0x27 (Relax)
    buttonCodes: [0x08, 0x09, 0x0A, 0x0B],
    description: 'Kitchen scene Pico. App shows Bright/Cooking/Dining/Off. NEEDS PAIRING CAPTURE.',
    observed: ['NEEDS CAPTURE to identify b38 engraving code']
  },
  {
    id: '4btn-scene-movie',
    name: '4-Button Scene: Bright/Entertain/Movie/Off',
    packetType: 'BA',  // Likely BA
    b10: 0x0B,
    b30: 0x04,  // Assumed same as other 4btn scenes
    b31: 0x00,
    b37: 0x02,
    b38: 0x00,  // NEEDS CAPTURE - Different from 0x27 (Relax)
    buttonCodes: [0x08, 0x09, 0x0A, 0x0B],
    description: 'Movie scene Pico. App shows Bright/Entertain/Movie/Off. NEEDS PAIRING CAPTURE.',
    observed: ['NEEDS CAPTURE to identify b38 engraving code']
  },
]

// Engraving type hypothesis:
// b38 appears to encode which label set the Lutron app displays
// Known values:
//   0x06 = 5-button (ON/FAV/OFF/Raise/Lower)
//   0x01 = 2-button paddle (ON/OFF)
//   0x21 = 4-button raise/lower (ON/OFF/Raise/Lower)
//   0x27 = 4-button scene "Relax" (Bright/Entertain/Relax/Off)
//   0x28 = 4-button custom scene (user-defined labels)
// Unknown - need to capture:
//   0x?? = 2-button Home/Away
//   0x?? = 4-button Cooking (Bright/Cooking/Dining/Off)
//   0x?? = 4-button Movie (Bright/Entertain/Movie/Off)

// Button code mappings observed in captures
export interface ButtonMapping {
  code: number
  name5btn: string | null  // Name when used by 5-button devices
  name4btn: string | null  // Name when used by 4-button devices
  action: string
}

export const BUTTON_CODES: ButtonMapping[] = [
  { code: 0x02, name5btn: 'ON', name4btn: null, action: 'Turn on / go to 100%' },
  { code: 0x03, name5btn: 'FAVORITE', name4btn: null, action: 'Recall saved level' },
  { code: 0x04, name5btn: 'OFF', name4btn: null, action: 'Turn off / go to 0%' },
  { code: 0x05, name5btn: 'RAISE', name4btn: null, action: 'Increase brightness (hold)' },
  { code: 0x06, name5btn: 'LOWER', name4btn: null, action: 'Decrease brightness (hold)' },
  { code: 0x08, name5btn: null, name4btn: 'ON / SCENE4', action: 'On or top scene button' },
  { code: 0x09, name5btn: null, name4btn: 'RAISE / SCENE3', action: 'Raise or upper-mid scene' },
  { code: 0x0A, name5btn: null, name4btn: 'LOWER / SCENE2', action: 'Lower or lower-mid scene' },
  { code: 0x0B, name5btn: null, name4btn: 'OFF / SCENE1', action: 'Off or bottom scene button' },
]

// Bridge B1 pairing device type bytes (bytes 21-22 in B1 packet)
export interface DeviceTypeCode {
  bytes: string  // e.g., "63 02"
  name: string
  description: string
}

export const B1_DEVICE_TYPES: DeviceTypeCode[] = [
  { bytes: '63 02', name: 'Dimmer', description: 'Standard dimmer (0-100% level control)' },
  { bytes: '64 01', name: 'Switch', description: 'On/off switch (0% or 100% only)' },
  { bytes: '65 01', name: 'Fan', description: 'Fan controller (4 speed levels)' },
]

// Device ID format documentation (this part is accurate)
export interface DeviceIdFormat {
  name: string
  description: string
  example: string
  exampleSource: string
  byteOrder: 'big_endian' | 'little_endian'
  packetTypes: string[]
}

export const DEVICE_ID_FORMATS: DeviceIdFormat[] = [
  {
    name: 'Factory ID',
    description: 'Printed on device label. 8 hex digits. Permanent hardware identifier.',
    example: '06FE43B1',
    exampleSource: 'Label on dimmer',
    byteOrder: 'big_endian',
    packetTypes: ['B1 target (bytes 16-19)', 'B9/BA Pico ID (bytes 2-5)']
  },
  {
    name: 'Zone/Load ID',
    description: 'Assigned by bridge during pairing. Used in LEVEL commands.',
    example: 'AF902C11',
    exampleSource: 'B1 packet subnet+zone',
    byteOrder: 'little_endian',
    packetTypes: ['LEVEL source (bytes 2-5)', 'B1 subnet (bytes 3-4)']
  },
  {
    name: 'RF TX ID',
    description: 'Used by dimmers when broadcasting STATE_RPT. Derived from Zone ID.',
    example: '062C908F',
    exampleSource: 'STATE_RPT from paired dimmer',
    byteOrder: 'little_endian',
    packetTypes: ['STATE_RPT (0x81-0x83) device field']
  },
  {
    name: 'Subnet',
    description: 'Middle 16 bits of Zone ID. Groups devices by bridge.',
    example: '902C',
    exampleSource: 'From Zone ID AF902C11 -> 902C',
    byteOrder: 'big_endian',
    packetTypes: ['BEACON, B1 pairing']
  },
]

// Known devices from our captures
export interface KnownDevice {
  id: string
  name: string
  category: 'pico' | 'dimmer' | 'bridge' | 'unknown'
  signature?: string  // Reference to PAIRING_SIGNATURES id
  notes: string[]
  relatedIds?: string[]  // Other IDs associated with this device
}

export const KNOWN_DEVICES: KnownDevice[] = [
  {
    id: '05851117',
    name: '5-Button Pico (Living Room)',
    category: 'pico',
    signature: '5btn',
    notes: ['Buttons 0x02-0x06', 'Direct paired to dimmer', 'ID matches label']
  },
  {
    id: '084B1EBB',
    name: 'Scene Pico (Hallway)',
    category: 'pico',
    signature: '4btn-scene-bridge',
    notes: ['Buttons 0x08-0x0B', 'Bridge-only (BA packets)', 'Triggers scenes via Caseta bridge']
  },
  {
    id: '08692D70',
    name: '4-Button Pico (Raise/Lower)',
    category: 'pico',
    signature: '4btn-rl',
    notes: ['Buttons 0x08-0x0B', 'Paired to BOTH Caseta and RA3 bridges']
  },
  {
    id: 'B9E19B05',
    name: '2-Button Pico',
    category: 'pico',
    signature: '2btn',
    notes: ['ON/OFF only (0x02, 0x04)', 'Seen as BTN_SHORT_B packets']
  },
  {
    id: '702D6908',
    name: 'Scene Pico',
    category: 'pico',
    signature: '4btn-scene-bridge',
    notes: ['Buttons 0x08-0x0B (SCENE codes)', 'Captured BTN_LONG_B with SCENE2']
  },
  {
    id: '06FE43B1',
    name: 'Dimmer',
    category: 'dimmer',
    notes: [
      'Factory ID from label',
      'Bridge-controlled via LEVEL commands',
      'Re-paired: now broadcasts on 062C90xx IDs'
    ],
    relatedIds: ['062C908F', '062C9080', '062C908D']
  },
  {
    id: '0700438C',
    name: 'Living Room Downlights',
    category: 'dimmer',
    notes: ['Bridge-controlled', 'STATE_RPT on 062C908x'],
    relatedIds: ['062C908C', '062C908F']
  },
  {
    id: '06FE8020',
    name: 'Kitchen Downlights',
    category: 'dimmer',
    notes: ['Bridge-controlled', 'STATE_RPT on 0E2C90xx'],
    relatedIds: ['0E2C9080', '0E2C908F']
  },
  {
    id: '002C90AF',
    name: 'Bridge Zone (Subnet 902C)',
    category: 'bridge',
    notes: ['LEVEL command source', 'BEACON broadcasts', 'Subnet: 902C']
  },
]

// Component
export function DeviceReference() {
  const [activeTab, setActiveTab] = useState<'signatures' | 'buttons' | 'ids' | 'devices'>('signatures')

  return (
    <div className="device-reference">
      <div className="device-ref-header">
        <h2>CCA Device Signatures</h2>
        <p>Protocol-level device identification from RF captures</p>
      </div>

      <div className="device-ref-tabs">
        <button className={activeTab === 'signatures' ? 'active' : ''} onClick={() => setActiveTab('signatures')}>
          Pairing Signatures
        </button>
        <button className={activeTab === 'buttons' ? 'active' : ''} onClick={() => setActiveTab('buttons')}>
          Button Codes
        </button>
        <button className={activeTab === 'ids' ? 'active' : ''} onClick={() => setActiveTab('ids')}>
          ID Formats
        </button>
        <button className={activeTab === 'devices' ? 'active' : ''} onClick={() => setActiveTab('devices')}>
          Known Devices
        </button>
      </div>

      <div className="device-ref-content">
        {activeTab === 'signatures' && (
          <div className="signatures-section">
            <p className="section-intro">
              Pico remotes identify themselves via B8/B9/BA/BB pairing packets.
              Key bytes determine button layout and pairing capability.
            </p>

            <div className="byte-legend">
              <h4>Key Byte Positions (in 53-byte pairing packet)</h4>
              <div className="legend-items">
                <div className="legend-item">
                  <span className="legend-byte">B10</span>
                  <span className="legend-desc">Button scheme: 0x04=5-btn style, 0x0B=4-btn style</span>
                </div>
                <div className="legend-item">
                  <span className="legend-byte">B30-31</span>
                  <span className="legend-desc">Capability flags</span>
                </div>
                <div className="legend-item">
                  <span className="legend-byte">B37</span>
                  <span className="legend-desc">Button count indicator</span>
                </div>
                <div className="legend-item">
                  <span className="legend-byte">B38</span>
                  <span className="legend-desc">Device class (0x06, 0x21, 0x27, 0x28, etc.)</span>
                </div>
              </div>
            </div>

            <h4>Confirmed Signatures</h4>
            <div className="signatures-list">
              {PAIRING_SIGNATURES.filter(sig => sig.b38 !== 0).map(sig => (
                <div key={sig.id} className="signature-card">
                  <div className="sig-header">
                    <span className="sig-name">{sig.name}</span>
                    <span className={`sig-pkt pkt-${sig.packetType.toLowerCase()}`}>{sig.packetType}</span>
                  </div>
                  <p className="sig-desc">{sig.description}</p>

                  <div className="sig-bytes">
                    <div className="sig-byte"><span className="byte-label">B10</span><code>0x{sig.b10.toString(16).toUpperCase().padStart(2, '0')}</code></div>
                    <div className="sig-byte"><span className="byte-label">B30</span><code>0x{sig.b30.toString(16).toUpperCase().padStart(2, '0')}</code></div>
                    <div className="sig-byte"><span className="byte-label">B31</span><code>0x{sig.b31.toString(16).toUpperCase().padStart(2, '0')}</code></div>
                    <div className="sig-byte"><span className="byte-label">B37</span><code>0x{sig.b37.toString(16).toUpperCase().padStart(2, '0')}</code></div>
                    <div className="sig-byte highlight"><span className="byte-label">B38</span><code>0x{sig.b38.toString(16).toUpperCase().padStart(2, '0')}</code></div>
                  </div>

                  <div className="sig-buttons">
                    <span className="buttons-label">Button codes:</span>
                    {sig.buttonCodes.map(code => (
                      <code key={code}>0x{code.toString(16).toUpperCase().padStart(2, '0')}</code>
                    ))}
                  </div>

                  {sig.observed.length > 0 && (
                    <div className="sig-observed">
                      <span className="observed-label">Observed:</span>
                      <ul>
                        {sig.observed.map((obs, i) => <li key={i}>{obs}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <h4>Needs Pairing Capture</h4>
            <p className="needs-capture-note">These Pico types exist but we haven't captured their pairing packets yet. The b38 "engraving" byte is unknown.</p>
            <div className="signatures-list needs-capture">
              {PAIRING_SIGNATURES.filter(sig => sig.b38 === 0).map(sig => (
                <div key={sig.id} className="signature-card needs-capture">
                  <div className="sig-header">
                    <span className="sig-name">{sig.name}</span>
                    <span className="sig-status">NEEDS CAPTURE</span>
                  </div>
                  <p className="sig-desc">{sig.description}</p>

                  <div className="sig-buttons">
                    <span className="buttons-label">Expected button codes:</span>
                    {sig.buttonCodes.map(code => (
                      <code key={code}>0x{code.toString(16).toUpperCase().padStart(2, '0')}</code>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="b1-types">
              <h4>B1 Device Type Codes (bytes 21-22)</h4>
              <p>When bridge sends B1 pairing assignment, these bytes indicate target device type:</p>
              <table>
                <thead>
                  <tr><th>Bytes</th><th>Type</th><th>Description</th></tr>
                </thead>
                <tbody>
                  {B1_DEVICE_TYPES.map(dt => (
                    <tr key={dt.bytes}>
                      <td><code>{dt.bytes}</code></td>
                      <td>{dt.name}</td>
                      <td>{dt.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'buttons' && (
          <div className="buttons-section">
            <p className="section-intro">
              Button codes differ between 5-button (0x02-0x06) and 4-button (0x08-0x0B) devices.
              The button scheme byte (B10) determines which set is used.
            </p>

            <div className="button-groups">
              <div className="button-group">
                <h4>5-Button Layout (B10=0x04)</h4>
                <table>
                  <thead>
                    <tr><th>Code</th><th>Button</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {BUTTON_CODES.filter(b => b.name5btn).map(btn => (
                      <tr key={btn.code}>
                        <td><code>0x{btn.code.toString(16).toUpperCase().padStart(2, '0')}</code></td>
                        <td>{btn.name5btn}</td>
                        <td>{btn.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="button-group">
                <h4>4-Button Layout (B10=0x0B)</h4>
                <table>
                  <thead>
                    <tr><th>Code</th><th>Button</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {BUTTON_CODES.filter(b => b.name4btn).map(btn => (
                      <tr key={btn.code}>
                        <td><code>0x{btn.code.toString(16).toUpperCase().padStart(2, '0')}</code></td>
                        <td>{btn.name4btn}</td>
                        <td>{btn.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="button-actions">
              <h4>Action Byte (following button code)</h4>
              <table>
                <thead>
                  <tr><th>Code</th><th>Action</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>0x00</code></td><td>PRESS (button down)</td></tr>
                  <tr><td><code>0x01</code></td><td>RELEASE (button up)</td></tr>
                  <tr><td><code>0x03</code></td><td>SAVE (save favorite level)</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'ids' && (
          <div className="ids-section">
            <p className="section-intro">
              Lutron devices use multiple ID formats. Understanding endianness is critical for correct parsing.
            </p>

            <div className="id-formats-list">
              {DEVICE_ID_FORMATS.map((fmt, i) => (
                <div key={i} className="id-format-card">
                  <div className="id-format-header">
                    <span className="id-format-name">{fmt.name}</span>
                    <span className={`id-format-endian ${fmt.byteOrder}`}>
                      {fmt.byteOrder === 'big_endian' ? 'Big Endian' : 'Little Endian'}
                    </span>
                  </div>
                  <p className="id-format-desc">{fmt.description}</p>
                  <div className="id-format-example">
                    <code>{fmt.example}</code>
                    <span className="example-source">({fmt.exampleSource})</span>
                  </div>
                  <div className="id-format-packets">
                    <span className="packets-label">Found in:</span>
                    {fmt.packetTypes.map((pt, j) => (
                      <span key={j} className="packet-tag">{pt}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="id-calculation">
              <h4>RF TX ID Derivation</h4>
              <p>When a dimmer broadcasts STATE_RPT, its RF TX ID is derived from the Zone ID:</p>
              <div className="calc-formula">
                <code>RF_TX_ID = Zone_ID with high nibble modified</code>
              </div>
              <div className="calc-example">
                <div className="calc-row">
                  <span>Zone ID (from bridge):</span>
                  <code>AF902C11</code>
                </div>
                <div className="calc-row">
                  <span>RF TX ID (STATE_RPT):</span>
                  <code>0F2C9011, 0F2C9080, 0F2C908F</code>
                </div>
                <div className="calc-note">
                  Pattern: Dimmers broadcast on multiple RF TX IDs with zone suffix variations (80, 8D, 8F, etc.)
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'devices' && (
          <div className="devices-section">
            <p className="section-intro">
              Devices observed in our RF captures. IDs and behaviors confirmed through testing.
            </p>

            <div className="devices-list">
              {KNOWN_DEVICES.map(dev => (
                <div key={dev.id} className={`device-card category-${dev.category}`}>
                  <div className="device-header">
                    <code className="device-id">{dev.id}</code>
                    <span className="device-name">{dev.name}</span>
                    <span className={`device-category cat-${dev.category}`}>{dev.category}</span>
                  </div>

                  {dev.signature && (
                    <div className="device-signature">
                      Signature: <code>{dev.signature}</code>
                    </div>
                  )}

                  <ul className="device-notes">
                    {dev.notes.map((note, i) => <li key={i}>{note}</li>)}
                  </ul>

                  {dev.relatedIds && dev.relatedIds.length > 0 && (
                    <div className="device-related">
                      <span className="related-label">Related IDs:</span>
                      {dev.relatedIds.map(rid => <code key={rid}>{rid}</code>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default DeviceReference
