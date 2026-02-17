# Vive Processor Integration (Binary Ninja RE Notes)

Date: 2026-02-16
Target: `~/lutron-tools/Lutron Vive.app/Wrapper/Vive.app`

Note: This document is for the standalone legacy `Vive.app` bundle only. See `docs/vive-athena-leap-followup-2026-02-16.md` for follow-up findings showing Athena/LEAP route families in the unified `Lutron` app lineage.

## Scope

Analyzed in Binary Ninja:

- `Vive`
- `UtilityFramework.framework/UtilityFramework`
- `ConstantFramework.framework/ConstantFramework`
- `NetworkLayerFramework.framework/NetworkLayerFramework`
- `ProvidersFramework.framework/ProvidersFramework`
- `DataLayerFramework.framework/DataLayerFramework`

## High-Level Conclusion

Vive app integration with the processor is **not LEAP-style** like Caseta/RA3/HomeWorks.

It uses:

- Generic HTTP(S) request plumbing (`HttpNetworkService.get/post/put/delete/download/upload`)
- URL construction from `UtilityFramework.UrlBuilder`
- Local-hub route constants from `ConstantFramework.ViveConstants`
- Cookie/header-based auth semantics (`cookie`, `Set-Cookie`, `If-None-Match`, `X-Requested-With`)
- mDNS discovery (`_lutron._tcp.` + `local`)

It does **not** expose canonical LEAP artifacts in these binaries:

- No `CommuniqueType`
- No `ReadRequest/CreateRequest/UpdateRequest/SubscribeRequest` payload model
- No `/zone/...`, `/device/...`, `/area/...`, `/server/...` LEAP route families
- No `commandprocessor` endpoints

## Local Processor Routes Recovered

### URL builders (UtilityFramework)

- `getAddHubUrl(ipAddress:)` -> `"/hubRegistration"`
- `getHubInfoUrl(ipAddress:)` -> `"/hubdetails"` (assembled immediate in code)
- `getFlashHubUrl(ipAddress:)` -> `"/flashhub"` (assembled immediate in code)
- `getViveLoginUrl(ipAddress:)` -> `ViveConstants.loginURL`
- `getMDNSInfoUrl(ipAddress:)` -> `ViveConstants.mdnsInfoURL`
- `getVersionNumberUrl(ipAddress:)` -> `ViveConstants.versionNumberURL`
- `getBackupDownloadUrl(ipAddress:backupUrl:)` -> `ViveConstants.backupDownloadURL` (unless override provided)
- `getSoftwareUpdateUrl(ipAddress:)` -> `ViveConstants.softwareUpgradeStatusURL`
- `getMacAddressUrl(ipAddress:)` -> `ViveConstants.macAddressURL`

### Endpoint constant values (ConstantFramework)

- `loginURL` -> `"/login"`
- `mdnsInfoURL` -> `"/mdnsInfo"`
- `versionNumberURL` -> `"/versionNumber"`
- `backupDownloadURL` -> `"/backup"`
- `commissionedURL` -> `"setup/status"`
- `softwareUpgradeStatusURL` -> `"/firmwareUpgradeCurrentStatus"`
- `macAddressURL` -> `"/network?networkInterfaceHref=/networkinterface/1"`
- `supportFileURL` -> `"/supportFile"`
- `bacnetReportFileURL` -> `"/bacnet/report"`
- `picsReportFileURL` -> `"/bacnet/picsreport"`
- `viveSupportURL` -> `"/vive/support"`
- `forumURL` -> `"/vive/forums"`
- `youtubeURL` -> `"/watch"`

Also present:

- `httpScheme` -> `"http://"`
- `httpsScheme` -> `"https://"`
- `XRequestedWithKey` -> `"X-Requested-With"`
- `XRequestedWithValue` -> `"XMLHttpRequest"`
- `cookieKey` -> `"cookie"`
- `noneMatchKey` -> `"If-None-Match"`

## Discovery and Transport Notes

- mDNS service constants:
  - `oldHubsServiceType` -> `"_lutron._tcp."`
  - `domainType` -> `"local"`
- Trust/auth challenge path:
  - `NetworkLayerFramework.HubChallengeHandler.handle(...)`
- Cert files shipped in `NetworkLayerFramework.framework`:
  - `lutron.cer`
  - `vive_hub_br_line_1.cer`
  - `vive_hub_br_line_2.cer`
  - `vive_hub_br_line_1_29Nov2016.cer`
  - `vive_hub_cb_dev.cer`
  - `azurewebsites.cer`
  - `developer_self-signed.cer`

## Comparison to Caseta / RA3 LEAP

Compared against `docs/leap-routes.md`:

- Caseta/RA3/HomeWorks LEAP uses `CommuniqueType` envelopes and route families like:
  - `/zone/...`
  - `/device/...`
  - `/area/...`
  - `/system/...`
  - `/.../commandprocessor`
- Vive binaries analyzed here do not show that model.

### Practical classification

Vive processor integration appears to be:

- Closer to a hub-local REST surface with project/href semantics
- Not Caseta-style LEAP route compatible
- Not RA3-style LEAP route compatible
- A distinct commercial API stack (with some cloud and support/reporting endpoints)
