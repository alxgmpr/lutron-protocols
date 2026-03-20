# HW Project Injection into RA3 Processor (ACHIEVED 2026-03-03)

## Summary
Successfully transferred a HomeWorks (HW) project to an RA3 processor by injecting
RA3 device addressing data into a fresh HW project file opened in Designer.

## Why This Works
- RA3 and HW use identical hardware (Janus AM3351 processor, same CCA/CCX radios)
- The database schema is identical (268 tables)
- CCA/CCX protocols are product-agnostic
- Designer doesn't hard-validate processor product type during transfer

## The Failed Approach: Project File Conversion
Converting backup-pristine.ra3 → converted.hw by modifying the .bak file caused
Designer to freeze at 19% loading "Guest Room." Root cause never fully determined.
FK constraints (all 202 disabled) were fixed but didn't solve it. Something else
in the converted database causes Designer to hang during project load.

## The Working Approach: Fresh HW + Identity Injection

### Prerequisites
- A working .hw project file that opens in Designer (e.g., Test.hw)
- The RA3 project's database accessible (restored as InspectOrig on LocalDB)
- Both databases on the same LocalDB instance for cross-DB queries

### Fields to Update (6 updates total)

#### 1. Processor Identity (tblProcessor)
```sql
UPDATE dbo.tblProcessor SET
  SerialNumber = ra3.SerialNumber,
  MacAddress = ra3.MacAddress,
  IPAddress = ra3.IPAddress,
  ProcessorCertificate = ra3.ProcessorCertificate,
  LoobKey = ra3.LoobKey
FROM dbo.tblProcessor hw
CROSS JOIN <ra3_db>.dbo.tblProcessor ra3;
```

#### 2. Processor System Certs (tblProcessorSystem)
```sql
UPDATE dbo.tblProcessorSystem SET
  SubsystemCertificateV2 = ra3.SubsystemCertificateV2,
  SubSystemPrivateKeyV2 = ra3.SubSystemPrivateKeyV2,
  UniqueLocalIPv6NetworkAddress = ra3.UniqueLocalIPv6NetworkAddress
FROM dbo.tblProcessorSystem hw
CROSS JOIN <ra3_db>.dbo.tblProcessorSystem ra3;
```

#### 3. CCA Link — Subnet Address (tblLink)
```sql
UPDATE dbo.tblLink SET SubnetAddress = 33495  -- 0x82D7
WHERE LinkInfoID = 11;  -- CCA link type
```

#### 4. CCX Link — Thread Credentials (tblPegasusLink)
```sql
UPDATE dbo.tblPegasusLink SET
  Channel = ra3.Channel,
  PanID = ra3.PanID,
  ExtendedPanId = ra3.ExtendedPanId,
  NetworkMasterKey = ra3.NetworkMasterKey
FROM dbo.tblPegasusLink hw
CROSS JOIN <ra3_db>.dbo.tblPegasusLink ra3;
```

#### 5. Activation State (tblProcessor) — CRITICAL
```sql
UPDATE dbo.tblProcessor SET SerialNumberState = 2;
```
- `SerialNumberState = 0` → Designer shows processor as not activated, blocks transfer
- `SerialNumberState = 2` → Designer shows processor as activated, allows transfer

### Key Data Points (from RA3 project)
- Processor MAC: `a0:b1:c2:d3:e4:f5`
- Processor Serial: `100000001`
- Processor IP: `10.0.0.1`
- CCA SubnetAddress: `33495` (0x82D7), Channel: 26
- CCX Channel: 25, PanID: 25327 (0xXXXX)
- CCX ExtendedPanId: `0x<your-thread-xpanid>`
- CCX NetworkMasterKey: `0x<your-thread-master-key>`

### What This Achieves
- Designer treats the RA3 processor as an HW processor
- The processor joins the same CCA/CCX RF networks as the existing RA3 devices
- HW features (DoubleTap, HoldPreset, richer LedLogic, etc.) become available
- Existing devices should be discoverable on the network

### CCX vs CCA Device Injection Results
- **CCX devices (Thread) WORK** — injecting SerialNumber + SerialNumberState=2 +
  PegasusLinkNode (IPv6/GUID) survives Designer save/transfer. HN3RL confirmed working.
- **CCA devices get WIPED** — Designer caches device data in memory. On save/transfer,
  it overwrites CCA device SerialNumber back to 0 and SerialNumberState back to 0.
  Only CCX device values survive.

## FAILED Approach: Offline .bak Patching — DO NOT USE
- Extracted .bak from .hw (project-convert.ts --extract-only), restored to LocalDB,
  patched serial numbers via SQL, backed up, repacked into .hw (--pack-only)
- **Result: BROKE the file.** Opening patched file CRASHED the entire VM.
- **NEVER patch .bak files offline** — extract/repack corrupts them catastrophically.

## FAILED Approach: Close Without Saving
- Updating live DB then closing Designer without saving does NOT preserve changes.
- Designer discards all in-memory state and the file reverts to its saved version.
- You MUST save from within Designer to persist any live DB changes.

## The Only Viable Approach for CCA Devices: Live DB + Designer Save Trick
1. Open the .hw project in Designer (so it has a live LocalDB)
2. Run SQL updates on the live database (serial numbers, SerialNumberState=2, link nodes)
3. **Trick Designer into saving** — make a trivial change in the Designer UI
   (e.g., rename a room, toggle a setting) so it considers the project "dirty" and saves
4. Save the project (File > Save) — this writes Designer's in-memory cache PLUS
   any DB changes it didn't cache back to the .bak
5. Close and reopen the file — Designer now loads from the saved .bak which includes
   the injected values

### CONFIRMED: Live DB + Save Trick Works for CCA Devices (2026-03-03)
- Update SerialNumber + SerialNumberState=2 on live DB while Designer has file open
- **AddressOnLink MUST match the RA3 device's actual CCA address** (mismatch = transfer fail)
- Make a trivial UI change in Designer (so it considers project "dirty")
- Save → Close → Reopen → Transfer
- **CCA devices now show as addressed and activated after transfer!**

### CCX Devices Don't Need DB Injection
- **CCX (Thread) devices can be activated via the native Lutron app** — no DB hacking needed
- Only **CCA devices** require manual serial + activation injection via live DB
- Focus DB injection efforts on CCA lamp dimmers and similar CCA-only devices

### Migration Workflow
- Build the HW project topology in Designer (areas, rooms, devices, zones)
- For each device: match to RA3 device by model, update serial + activation via live DB
- Save trick after each batch of updates
- Transfer to processor — devices connect on their existing RF addresses

### Device ID Reference
| Test.hw ID | RA3 ID | Model      | Link | Address | Serial    |
|------------|--------|------------|------|---------|-----------|
| 483        | 926    | RRST-HN3RL | CCX  | 3       | 100000003 |
| 532        | 3272   | RRD-3LD    | CCA  | 14      | 100000004   |
| 561        | 3289   | RRD-3LD    | CCA  | 15      | 100000005   |

### Link Structure Reference
- CCA Link: LinkInfoID=11 (link 236 in RA3, link 439 in Test.hw)
- CCX Link: LinkInfoID=40 (link 234 in RA3, link 437 in Test.hw)
- Processor owns both links (IsLinkOwner=1 on link nodes 233/235 in RA3, 436/438 in Test.hw)
