# MemoStats V2

Read-only diagnostic and telemetry client for the **Mercedes-Benz A-Class W176** over the user's **MBito BLE
dongle** (`V2407127C3`). Mobile-first web app for **Bluefy on iPhone**; desktop Chrome/Edge work too.

## Status — 0.3.0

| Layer | Status |
|---|---|
| BLE, MBito framing, dongle info, EXEC_UDS acceptance, `request_nr` echo | **WORKING** — VERIFIED REAL VEHICLE (V2, 2026-09-28) |
| V1 connect sequence (GET_CAN_BAUD → `01 0D`/`01 0C` → PIDs), V1 live polling | IMPLEMENTED — byte-identical to V1 frames — AWAITING VEHICLE VALIDATION |
| 0x33 ECU scan (all 70 W176 candidates, detected-only list, session cache) + history, 0–100, passive BLE capture, developer tools | IMPLEMENTED — AWAITING VEHICLE VALIDATION |
| DTC read, readiness, VIN, MAI MULTE DATE / boost | IMPLEMENTED — AWAITING VEHICLE VALIDATION |
| Mileage comparison, Mercedes measurements, sessions/analytics | not started |
| Stroboscope | placeholder only — no transmit code |

Next: milestone 2 in [docs/VEHICLE-TEST-CHECKLIST.md](docs/VEHICLE-TEST-CHECKLIST.md).

## Safety boundary

Read-only. No flashing, coding, DTC clearing, resets, SecurityAccess, routine control, CAN-baud changes or
arbitrary CAN/UDS sending. Write-capable MBito commands are not representable in the code
(`src/core/mbito/constants.ts`). No MBito cloud/GraphQL/auth at runtime.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + lint + unit tests + production build
```

Web Bluetooth needs HTTPS (or localhost). No service worker: a normal refresh always loads the current build;
the build time is shown in LOGURI.

## Deploy

Separate Vercel project `memostats-v2`. Never deploy this to the `memostats` project / `memostats.vercel.app`
until V2 passes vehicle validation.

```bash
npx vercel deploy          # preview
```

## Docs

- [ARCHITECTURE](docs/ARCHITECTURE.md) — layers and invariants
- [PROTOCOL](docs/PROTOCOL.md) — every protocol fact with its evidence (EXEC_UDS = `0x40`)
- [KNOWN-UNKNOWN](docs/KNOWN-UNKNOWN.md) — what is inferred or unresolved
- [DATA-SOURCES](docs/DATA-SOURCES.md) — audit of all MBito-derived data
- [W176-ECUS](docs/W176-ECUS.md) — generated ECU catalogue
- [DTC](docs/DTC.md) · [TELEMETRY](docs/TELEMETRY.md) · [PERFORMANCE](docs/PERFORMANCE.md)
- [VEHICLE-TEST-CHECKLIST](docs/VEHICLE-TEST-CHECKLIST.md)
- [CHANGELOG](CHANGELOG.md)
