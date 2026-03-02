# mb-parts-poc

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

## API Endpoints

### Lokal (Vite Middleware)

- `POST /api/sync`
- `POST /api/sync-prices`
- `POST /api/enrich-visible`

### Netlify (Functions + Redirects in `netlify.toml`)

- `POST /api/sync` -> `netlify/functions/sync.mjs`
- `POST /api/sync-prices` -> `netlify/functions/sync-prices.mjs`
- `POST /api/enrich-visible` -> `netlify/functions/enrich-visible.mjs`

## Deployment (Netlify)

- Build command: `npm run build`
- Publish dir: `dist`
- Functions dir: `netlify/functions`

Hinweis: Die Functions nutzen `public/data/parts-base.json` als Basis.  
Fehlt die Datei, schlägt Sync fehl.

