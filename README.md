# OpenOil

OpenOil is a web app that helps you discover nearby fuel stations on an interactive map, compare prices, and monitor live updates.

## Features

- Fuel availability by type (diesel, SP95, SP98, E10, E85, LPG)
- Live prices by fuel type
- Radius-based comparison and ranking
- Station list sorting (price, distance, price+distance compromise)
- Automatic refresh every 60 seconds
- Multi-country data aggregation (France, Germany, UK, Benelux depending on location)
- Mobile-first tabbed experience (filters, list, map)
- Dedicated mobile-view page for desktop preview

## Run Locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

Then open:

```text
http://localhost:8080
```

## API Endpoints

### Around mode

```http
GET /api/stations/around?lat={lat}&lon={lon}&radius={km}
```

Returns stations near a coordinate, with merged sources depending on geographic bounds.

### Free mode

```http
GET /api/stations/free
```

Returns a larger cached dataset for free exploration mode.

## Data Sources

Primary / regional sources:

- France official open data (`data.economie.gouv.fr`)
- Germany (`Tankerkonig`)
- UK feeds (Mapbox fuel feed + CMA-compatible sources)
- Benelux feeds (DirectLease and ANWB)

Fallback:

- `https://api.prix-carburants.2aaz.fr`

Optional environment variable:

- `TANKERKOENIG_API_KEY` (override default Tankerkonig key)

## Deployment (Vercel)

The project is ready for Vercel with:

- `api/index.js` as the serverless Express entrypoint
- `vercel.json` rewrite rules routing `/api/*` to Express
- Static frontend served from the project root

Deploy steps:

```bash
npm i -g vercel
vercel
vercel --prod
```

Production URL serves:

- Frontend at `/`
- API at `/api/stations/around` and `/api/stations/free`
