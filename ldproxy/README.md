# Lutron Designer Account Proxy

Intercepts Lutron Designer authentication responses and injects all channel strings to unlock every product type and feature.

## How It Works

Lutron Designer receives a `User.Channels` string array from the auth server. Each string maps to a bit in the `[Flags] enum ChannelTypes` (in `Lutron.Gulliver.Infrastructure.dll`) via `[Display(Name)]` attributes. The proxy adds all 29 known channel strings, giving the app every product entitlement.

The app's `ProductType` is set at startup (Homeworks, RadioRA 3, Lutron Designer+, etc.), and `SetUserChannelsForProduct()` filters channels to only those valid for the current product. So the proxy works for all product modes.

## Channel Reference

Derived from decompiling `Lutron.Gulliver.Infrastructure.myLutronService.ChannelTypes`:

| API String | Bit | ProductType | Purpose |
|---|---|---|---|
| `LDB` | 0x1 | StandaloneQS | Lutron Designer Base |
| `DesVive` | 0x2 | StandaloneQS | Vive design |
| `DesmyRoom` | 0x4 | StandaloneQS | myRoom design |
| `DesQuantum` | 0x8 | StandaloneQS | Quantum design |
| `DesAll` | 0xF | *(combo)* | LDB+DesVive+DesmyRoom+DesQuantum |
| `CommmyRoomLegacy` | 0x10 | Quantum | Legacy myRoom |
| `LDBlockUsageTrac` | 0x20 | StandaloneQS | Block usage tracking |
| `LDAlpha` | 0x40 | StandaloneQS | Alpha access |
| `LDBeta` | 0x80 | StandaloneQS | Beta access |
| `OQT` | 0x100 | StandaloneQS | Online Quote Tool |
| `DCurrUSD` .. `DCurrCNY` | 0x200-0x20000 | *(currency)* | 9 currency channels |
| `CommQuantum` | 0x40000 | Quantum | Quantum commissioning |
| `CommmyRoom` | 0x80000 | MyRoom | myRoom commissioning |
| `CommAll` | 0xC0000 | *(combo)* | CommQuantum+CommmyRoom |
| `QTT` | 0x200000 | — | Quote TakeOff Tool |
| `DLSI` | 0x400000 | StandaloneQS | LSI access |
| `PIDHW013` | 0x800000 | QuantumResi | **Homeworks QSX** |
| `RadioRA 3 All` | 0x1000000 | RadioRA2 | **RadioRA 3** |
| `Design Ketra Legacy` | 0x4000000 | StandaloneQS | Ketra legacy |
| `Beta_LutronDesignerPlus_DTDTPhaseOne` | 0x8000000 | StandaloneQS | DTDT beta |
| `Beta_LutronDesignerPlus_DTDT_OQT_Hybrid` | 0x10000000 | StandaloneQS | DTDT+OQT hybrid |

## Setup

```bash
cd ldproxy
npm install
npm start    # listens on port 3000
```

## VM Routing (UTM Shared Network)

The Designer VM uses UTM Shared Network (NAT) mode for stable IPs:
- **VM**: `192.168.64.4`
- **Mac (gateway)**: `192.168.64.1`

Charles Proxy on the VM maps these three endpoints to `192.168.64.1:3000`:

| Endpoint | Upstream Host |
|---|---|
| `/myLutron/myLutron.svc/RefreshToken` | `designer-relay.lutron.com` |
| `/myLutron/myLutron.svc/AuthenticateCode` | `designer-relay.lutron.com` |
| `/api/IdentityService/GetUserFullProfile` | `umsssoservice.lutron.com` |

## Second Layer: Feature Flags

Channels control product access. Feature flags (Rollout.io/CloudBees) are a separate remote config system keyed by `FeatureFlagType` enum with per-product defaults. These are not controlled by the proxy.
