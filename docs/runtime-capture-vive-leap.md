# Runtime Capture Workflow (Vive/Athena LEAP)

## 1. Run capture

```bash
tools/capture-lutron-leap.sh 180 en0 <processor_ip>
```

Example:

```bash
tools/capture-lutron-leap.sh 180 en0 10.0.0.2
```

## 2. During capture, perform one action type at a time

1. Zone on/off only.
2. Zone dim level change only.
3. Room/area scene trigger only.

Keep each action batch short and separated in time so packets are easy to correlate.

## 3. Review generated files

Output folder:

`captures/lutron-runtime/<timestamp>/`

Key files:

- `summary.txt`
- `tcp-streams.tsv`
- `http-requests.tsv` (only if plaintext HTTP exists)
- `tls-sni.tsv`
- `mdns.txt`
- `path-candidates.txt`

## Notes

- LEAP on processor port `8081` is typically TLS, so `http-requests.tsv` may be empty.
- If all traffic is TLS-only, route recovery requires pre-TLS instrumentation (blocked in this environment by process-debug restrictions).
