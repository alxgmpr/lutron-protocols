const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// All channel strings from ChannelTypes enum [Display(Name)] attributes
// in Lutron.Gulliver.Infrastructure.myLutronService.ChannelTypes
const ALL_CHANNELS = [
  "LDB", "DesVive", "DesmyRoom", "DesQuantum", "DesAll",
  "CommmyRoomLegacy", "LDBlockUsageTrac", "LDAlpha", "LDBeta", "OQT",
  "DCurrUSD", "DCurrCAD", "DCurrGBP", "DCurrEUR", "DCurrINR",
  "DCurrJPY", "DCurrBRL", "DCurrMXN", "DCurrCNY",
  "CommQuantum", "CommmyRoom", "CommAll",
  "QTT", "DLSI", "PIDHW013", "RadioRA 3 All", "Design Ketra Legacy",
  "Beta_LutronDesignerPlus_DTDTPhaseOne",
  "Beta_LutronDesignerPlus_DTDT_OQT_Hybrid",
];

function injectChannels(channels) {
  if (!Array.isArray(channels)) return [...ALL_CHANNELS];
  const existing = new Set(channels);
  return [...channels, ...ALL_CHANNELS.filter(ch => !existing.has(ch))];
}

// Route table: path -> { upstream, channelsPath }
const ROUTES = [
  { path: '/myLutron/myLutron.svc/RefreshToken',      upstream: 'https://designer-relay.lutron.com', get: b => b?.User?.Channels,                    set: (b, c) => { b.User.Channels = c; } },
  { path: '/myLutron/myLutron.svc/AuthenticateCode',   upstream: 'https://designer-relay.lutron.com', get: b => b?.User?.Channels,                    set: (b, c) => { b.User.Channels = c; } },
  { path: '/api/IdentityService/GetUserFullProfile',   upstream: 'https://umsssoservice.lutron.com',  get: b => b?.Data?.UserBasicProfile?.Channels,  set: (b, c) => { b.Data.UserBasicProfile.Channels = c; } },
];

for (const route of ROUTES) {
  app.all(route.path, async (req, res) => {
    const tag = `${req.method} ${route.path}`;
    console.log(`→ ${tag}`);

    try {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      delete headers['x-forwarded-for'];
      delete headers['x-forwarded-proto'];

      const config = {
        method: req.method,
        url: `${route.upstream}${req.path}`,
        headers,
        params: req.query,
        validateStatus: () => true,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
        config.data = req.body;
      }

      const upstream = await axios(config);
      let body = upstream.data;

      // Parse string responses as JSON if possible
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }

      // Inject channels if present
      const original = route.get(body);
      if (original) {
        const injected = injectChannels(original);
        route.set(body, injected);
        const added = injected.length - (Array.isArray(original) ? original.length : 0);
        console.log(`  ✓ ${upstream.status} — injected ${added} channels (${original.length} → ${injected.length})`);
      } else {
        console.log(`  ✓ ${upstream.status} — no channels field, passthrough`);
      }

      // Forward response headers (except content-length, we re-serialize)
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
      }
      res.status(upstream.status).json(body);
    } catch (err) {
      console.error(`  ✗ ${tag}: ${err.message}`);
      res.status(502).json({ error: 'proxy error', message: err.message });
    }
  });
}

app.listen(PORT, () => {
  console.log(`ldproxy listening on :${PORT}`);
  console.log(`  ${ROUTES.length} routes → channel injection`);
});
