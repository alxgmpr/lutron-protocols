const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((request, response, next) => {
  console.log(`[${new Date().toISOString()}] ${request.method} ${request.path}`);
  console.log('Headers:', JSON.stringify(request.headers, null, 2));
  if (request.body && Object.keys(request.body).length > 0) {
    console.log('Body:', JSON.stringify(request.body, null, 2));
  }
  next();
});

async function proxyRequest(request, response, targetHost, responseMutationFunction, requestMutationFunction) {
  try {
    console.log(`[${new Date().toISOString()}] Proxying request to ${targetHost}${request.path}`);

    const targetUrl = `${targetHost}${request.path}`;
    
    const requestHeaders = { ...request.headers };
    delete requestHeaders.host;
    delete requestHeaders['content-length'];
    
    if (requestHeaders['x-forwarded-for']) {
      delete requestHeaders['x-forwarded-for'];
    }
    if (requestHeaders['x-forwarded-proto']) {
      delete requestHeaders['x-forwarded-proto'];
    }

    console.log('Forwarding headers:', JSON.stringify(requestHeaders, null, 2));

    let requestBody = request.body;
    if (requestMutationFunction && requestBody) {
      console.log('Original request body:', JSON.stringify(requestBody, null, 2));
      requestBody = requestMutationFunction(requestBody);
      console.log('Modified request body:', JSON.stringify(requestBody, null, 2));
    }

    const axiosConfig = {
      method: request.method,
      url: targetUrl,
      headers: requestHeaders,
      params: request.query,
      validateStatus: () => true,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD' && requestBody !== undefined) {
      axiosConfig.data = requestBody;
    }

    console.log('Axios config:', JSON.stringify({
      method: axiosConfig.method,
      url: axiosConfig.url,
      headers: axiosConfig.headers,
      params: axiosConfig.params,
      hasData: !!axiosConfig.data
    }, null, 2));

    const proxyResponse = await axios(axiosConfig);

    console.log(`[${new Date().toISOString()}] Received response with status ${proxyResponse.status}`);
    console.log('Response headers:', JSON.stringify(proxyResponse.headers, null, 2));
    console.log('Response data:', JSON.stringify(proxyResponse.data, null, 2));

    let responseBody = proxyResponse.data;

    if (typeof responseBody === 'string') {
      try {
        responseBody = JSON.parse(responseBody);
      } catch (parseError) {
        console.log('Response is not JSON, returning as-is');
      }
    }

    if (responseMutationFunction) {
      responseBody = responseMutationFunction(responseBody);
    }

    Object.keys(proxyResponse.headers).forEach(headerName => {
      if (headerName.toLowerCase() !== 'content-length') {
        response.setHeader(headerName, proxyResponse.headers[headerName]);
      }
    });

    response.status(proxyResponse.status).json(responseBody);

    console.log(`[${new Date().toISOString()}] Response sent to client`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error proxying request:`, error.message);
    console.error('Stack:', error.stack);
    response.status(500).json({ error: 'Proxy error', message: error.message });
  }
}

app.all('/myLutron/myLutron.svc/RefreshToken', async (request, response) => {
  const mutationFunction = (responseBody) => {
    if (responseBody && typeof responseBody === 'object' && responseBody.User && responseBody.User.Channels) {
      console.log('Original User.Channels:', JSON.stringify(responseBody.User.Channels, null, 2));
      
      responseBody.User.Channels = getModifiedChannels(responseBody.User.Channels);
      
      console.log('Modified User.Channels:', JSON.stringify(responseBody.User.Channels, null, 2));
    } else {
      console.log('Response does not contain User.Channels, skipping mutation');
    }
    return responseBody;
  };

  await proxyRequest(request, response, 'https://designer-relay.lutron.com', mutationFunction);
});

app.all('/myLutron/myLutron.svc/AuthenticateCode', async (request, response) => {
  const mutationFunction = (responseBody) => {
    if (responseBody && typeof responseBody === 'object' && responseBody.User && responseBody.User.Channels) {
      console.log('Original User.Channels:', JSON.stringify(responseBody.User.Channels, null, 2));
      
      responseBody.User.Channels = getModifiedChannels(responseBody.User.Channels);
      
      console.log('Modified User.Channels:', JSON.stringify(responseBody.User.Channels, null, 2));
    } else {
      console.log('Response does not contain User.Channels, skipping mutation');
    }
    return responseBody;
  };

  await proxyRequest(request, response, 'https://designer-relay.lutron.com', mutationFunction);
});

app.all('/api/IdentityService/GetUserFullProfile', async (request, response) => {
  const mutationFunction = (responseBody) => {
    if (responseBody && typeof responseBody === 'object' && responseBody.Data && responseBody.Data.UserBasicProfile && responseBody.Data.UserBasicProfile.Channels) {
      console.log('Original Data.UserBasicProfile.Channels:', JSON.stringify(responseBody.Data.UserBasicProfile.Channels, null, 2));
      
      responseBody.Data.UserBasicProfile.Channels = getModifiedChannels(responseBody.Data.UserBasicProfile.Channels);
      
      console.log('Modified Data.UserBasicProfile.Channels:', JSON.stringify(responseBody.Data.UserBasicProfile.Channels, null, 2));
    } else {
      console.log('Response does not contain Data.UserBasicProfile.Channels, skipping mutation');
    }
    return responseBody;
  };

  await proxyRequest(request, response, 'https://umsssoservice.lutron.com', mutationFunction);
});

// All channel strings from ChannelTypes enum [Display(Name)] attributes
// in Lutron.Gulliver.Infrastructure.myLutronService.ChannelTypes
const ALL_CHANNELS = [
  // Product channels
  "LDB",                // 0x1   - Lutron Designer Base (StandaloneQS)
  "DesVive",            // 0x2   - Vive design (StandaloneQS)
  "DesmyRoom",          // 0x4   - myRoom design (StandaloneQS)
  "DesQuantum",         // 0x8   - Quantum design (StandaloneQS)
  "DesAll",             // 0xF   - LDALL combo (LDB+DesVive+DesmyRoom+DesQuantum)
  "CommmyRoomLegacy",   // 0x10  - Legacy myRoom (Quantum) — note: also display name for LDLegacymyRoom
  "LDBlockUsageTrac",   // 0x20  - Block usage tracking (StandaloneQS)
  "LDAlpha",            // 0x40  - Alpha access (StandaloneQS)
  "LDBeta",             // 0x80  - Beta access (StandaloneQS)
  "OQT",                // 0x100 - Online Quote Tool (StandaloneQS)
  // Currency channels
  "DCurrUSD",           // 0x200
  "DCurrCAD",           // 0x400
  "DCurrGBP",           // 0x800
  "DCurrEUR",           // 0x1000
  "DCurrINR",           // 0x2000
  "DCurrJPY",           // 0x4000
  "DCurrBRL",           // 0x8000
  "DCurrMXN",           // 0x10000
  "DCurrCNY",           // 0x20000
  // Commissioning channels
  "CommQuantum",        // 0x40000  - Quantum commissioning
  "CommmyRoom",         // 0x80000  - myRoom commissioning
  "CommAll",            // 0xC0000  - CommQuantum+CommmyRoom combo
  // Specialty channels
  "QTT",                // 0x200000   - Quote TakeOff Tool
  "DLSI",               // 0x400000   - LSI access (StandaloneQS)
  "PIDHW013",           // 0x800000   - Homeworks QSX (QuantumResi)
  "RadioRA 3 All",      // 0x1000000  - RadioRA 3 (RadioRA2)
  "Design Ketra Legacy", // 0x4000000 - Ketra legacy (StandaloneQS)
  "Beta_LutronDesignerPlus_DTDTPhaseOne",      // 0x8000000
  "Beta_LutronDesignerPlus_DTDT_OQT_Hybrid",   // 0x10000000
];

function getModifiedChannels(originalChannels) {
  if (!Array.isArray(originalChannels)) {
    console.log('Warning: originalChannels is not an array, returning full channel set');
    return [...ALL_CHANNELS];
  }
  const existing = new Set(originalChannels);
  const merged = [...originalChannels];
  for (const ch of ALL_CHANNELS) {
    if (!existing.has(ch)) {
      merged.push(ch);
    }
  }
  return merged;
}

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Proxy server listening on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Endpoints available:`);
  console.log(`  - /myLutron/myLutron.svc/RefreshToken -> https://designer-relay.lutron.com (mutates response)`);
  console.log(`  - /myLutron/myLutron.svc/AuthenticateCode -> https://designer-relay.lutron.com (mutates response)`);
  console.log(`  - /api/IdentityService/GetUserFullProfile -> https://umsssoservice.lutron.com (mutates response)`);
});

