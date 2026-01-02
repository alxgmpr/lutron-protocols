# Lutron Designer API Proxy

A lightweight proxy server that unlocks Homeworks Programming features in Lutron Designer by modifying API responses to add additional "Channels" to your user profile.

## What It Does

When Lutron Designer authenticates with Lutron's servers, it receives a list of "Channels" that determine which features are available. This proxy intercepts those API calls and adds channels that unlock:

- **PIDHW013** - Homeworks Programming
- **DesAll** - Designer All Features
- **DesQuantum** - Quantum Integration
- And more...

## Setup

1. Install dependencies:
   ```bash
   cd proxy
   npm install
   ```

2. Start the proxy server:
   ```bash
   npm start
   ```

   The proxy runs on port 3000 by default.

3. Configure your system to route Lutron traffic through the proxy:
   - Add entries to your hosts file pointing Lutron domains to 127.0.0.1
   - Or configure a system-level proxy

## Proxied Endpoints

| Endpoint | Target | Purpose |
|----------|--------|---------|
| `/myLutron/myLutron.svc/RefreshToken` | designer-relay.lutron.com | Adds channels on token refresh |
| `/myLutron/myLutron.svc/AuthenticateCode` | designer-relay.lutron.com | Adds channels on auth |
| `/api/IdentityService/GetUserFullProfile` | umsssoservice.lutron.com | Adds channels to user profile |

## Channels Added

```javascript
["PIDHW013", "DesAll", "DesQuantum", "CommAll", "CommQuantum",
 "DesVive", "DesmyRoom", "Design Ketra Legaacy", "DCurrUSD",
 "DLSI", "CommmyRoomLegacy", "LDBlockUsageTrac", "LDB",
 "LDAlpha", "LDBeta"]
```

## Disclaimer

This tool is for research and educational purposes. Use responsibly and in accordance with Lutron's terms of service.
