# mb-parts-poc

Ein produktionsnahes Parts-Portal für Mercedes-Teile mit strukturierter Datenpipeline, performanter UI und integriertem Netlify Release-Workflow.

Vite + TypeScript PoC für Mercedes-Teile (`A309`/`A310`) mit:

- tabellarischer UI (Suche, Sortierung, Pagination)
- Chunk-basierten Daten unter `public/data/vehicles/...`
- Preis-/Verfügbarkeits-Enrichment
- Netlify Functions für produktive `/api/*` Endpoints

## Voraussetzungen

- Node.js 22+
- npm

## Lokaler Start

```bash
npm install
npm run dev
```

## Datenpipeline

Der Build erwartet eine Quelle:

- bevorzugt `data/vehicles/default/index/parts.ndjson`
- alternativ `public/data/parts-base.json`

### Daten erzeugen

```bash
npm run build:data
```

Das Script macht:

1. optional `migrate` (`parts-base.json` -> `data/.../parts.ndjson`)
2. `chunk:index` (`parts.ndjson` -> `public/data/vehicles/default/index/chunks/*`)

### Produktions-Build

```bash
npm run build
```

`build` führt automatisch `build:data` aus.

## Wichtige Scripts

- `npm run dev` – lokaler Vite Dev Server
- `npm run build:data` – Daten für UI vorbereiten
- `npm run migrate` – JSON Snapshot -> NDJSON
- `npm run chunk:index` – NDJSON -> Chunk-Index
- `npm run build` – Build inkl. Datenvorbereitung
- `npm run typecheck` – TypeScript-Check ohne Build-Artefakte
- `npm run test` – Platzhalter (`not configured`)
- `npm run lint` – Platzhalter (`not configured`)
- `npm run format` – Platzhalter (`not configured`)

## API Endpoints

### Lokal (Vite Middleware)

- `POST /api/sync`
- `POST /api/sync-prices`
- `POST /api/enrich-visible`
- `POST /api/chat`

### Netlify (Functions + Redirects in `netlify.toml`)

- `POST /api/sync` -> `netlify/functions/sync.mjs`
- `POST /api/sync-prices` -> `netlify/functions/sync-prices.mjs`
- `POST /api/enrich-visible` -> `netlify/functions/enrich-visible.mjs`
- `POST /api/chat` -> `netlify/functions/chat.mjs`

## Teile-Berater Chatbot (Startpunkt)

Der PoC enthält ein minimales Beratungs-Widget auf der Startseite:

- Frontend: `src/chatbot.ts` (floating Chat-Widget, API-Call, Ergebnis-Karten)
- Styling: `src/style.css` (`.parts-chat*`)
- Backend: `POST /api/chat` (regelbasierte Katalog-Suche)

### Request/Response

Request:

```json
{ "message": "Suche Bremsbeläge vorne für W204, möglichst günstig" }
```

Response (gekürzt):

```json
{
  "ok": true,
  "answer": "Ich habe passende Teile aus dem Katalog priorisiert...",
  "followUpQuestions": ["..."],
  "recommendations": [
    {
      "partNumber": "A309...",
      "name": "....",
      "price": "129,00 €",
      "url": "...",
      "availability": { "status": "in_stock", "label": "Verfügbar" },
      "reason": "Name passt zu \"brems...\""
    }
  ]
}
```

### Aktuelle Matching-Logik

- Exakte Teilenummern werden stark priorisiert.
- Danach Name/Gruppe-Token-Matching auf Basis des Katalog-Snapshots.
- Optionaler Bias für Lieferbarkeit (`lieferbar`, `sofort`) oder Preis (`günstig`, `preiswert`).
- Bei Unsicherheit fragt der Bot nach Modell/Baujahr/VIN.

### Tracking + Warenkorb-Übergabe

- Triggered Events: `chat_open`, `chat_submit`, `chat_reco_click`
- Tracking-Ausgabe:
  - Push auf `window.dataLayer` (wenn vorhanden)
  - Browser-Event `mb_parts_chat_event` (für eigene Listener)
- Trefferkarten enthalten:
  - `Teil ansehen`
  - `In den Warenkorb` (Produkt-URL mit `?ref=mb-parts-chatbot&intent=cart`)

## Deployment (Netlify)

- Build command: `npm run build`
- Publish dir: `dist`
- Functions dir: `netlify/functions`

Hinweis: Die Functions nutzen `public/data/parts-base.json` als Basis.  
Fehlt die Datei, schlägt Sync fehl.

## Netlify MCP + Release Flow

Für mehr Kontrolle über Build- und Deploy-Ausgaben ist der Netlify MCP Server im Repo vorbereitet:

- MCP Config: `mcp.json`
- Server: `@netlify/mcp`

### 1) Auth + Site verknüpfen

```bash
npx -y netlify login
npm run netlify:link
```

Optional für CI/automatisierte Nutzung:

- `NETLIFY_AUTH_TOKEN`
- `NETLIFY_SITE_ID`

### 2) Release-Kommandos

- `npm run netlify:build` – führt den Netlify Build lokal aus (nahe an Netlify, aber nicht 1:1 Remote-Infrastruktur)
- `npm run release:preview` – erstellt ein Preview Deploy mit JSON-Output
- `npm run release:prod` – erstellt ein Production Deploy mit JSON-Output

Die `release:*` Skripte nutzen `--json`, damit Build-/Deploy-Ergebnisse im Release-Flow maschinenlesbar und eindeutig auswertbar sind.

### 3) Empfohlener Release-Ablauf

```bash
npm run netlify:build
npm run release:preview
# Preview testen
npm run release:prod
```

### Troubleshooting

Fehler:

`Error: Could not find the project ID ... please run netlify link`

Lösung:

```bash
npm run netlify:link
```

Falls nötig direkt mit Site-ID:

```bash
npx -y netlify link --id <NETLIFY_SITE_ID>
```

Hinweis: `netlify:build` validiert den Build lokal mit Netlify-Logik. Das tatsächliche Remote-Verhalten prüfst du über `release:preview` im echten Netlify Deploy.
