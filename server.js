const express = require("express");
const path = require("path");

const app = express();

const OFFICIAL_API_BASE =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records";
const FALLBACK_API_BASE = "https://api.prix-carburants.2aaz.fr";
const CACHE_TTL_MS = 2 * 60 * 1000;
const STALE_HIDE_DAYS = 60;

let cache = {
  updatedAt: 0,
  stations: [],
};

const fuelFieldMap = {
  gazole: "gazole",
  sp95: "sp95",
  sp98: "sp98",
  e10: "e10",
  e85: "e85",
  gpl: "gplc",
};

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function parseDateMaybe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isTooOld(date) {
  if (!date) return true;
  const ageMs = Date.now() - date.getTime();
  return ageMs > STALE_HIDE_DAYS * 24 * 60 * 60 * 1000;
}

function normalizeOfficialStation(record) {
  const lat = record?.geom?.lat;
  const lon = record?.geom?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const station = {
    id: `off-${record.id}`,
    name: record.adresse || `Station ${record.id}`,
    city: record.ville || "",
    lat,
    lon,
    lastUpdateText: null,
    fuels: {},
  };

  let newestUpdate = null;

  Object.entries(fuelFieldMap).forEach(([clientKey, sourceKey]) => {
    const price = record[`${sourceKey}_prix`];
    const majRaw = record[`${sourceKey}_maj`];
    const ruptureType = record[`${sourceKey}_rupture_type`];
    const majDate = parseDateMaybe(majRaw);

    if (typeof price !== "number") return;

    const available = !ruptureType && !isTooOld(majDate);

    station.fuels[clientKey] = {
      price,
      available,
      update: majDate ? majDate.toLocaleString("fr-FR") : null,
    };

    if (majDate && (!newestUpdate || majDate > newestUpdate)) {
      newestUpdate = majDate;
    }
  });

  if (Object.keys(station.fuels).length === 0) return null;

  station.lastUpdateText = newestUpdate ? newestUpdate.toLocaleString("fr-FR") : null;
  return station;
}

async function fetchOfficialAllStations() {
  const limit = 100;
  let offset = 0;
  const all = [];

  for (;;) {
    const url = `${OFFICIAL_API_BASE}?limit=${limit}&offset=${offset}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`official api ${response.status}`);

    const json = await response.json();
    const rows = Array.isArray(json.results) ? json.results : [];
    all.push(...rows);

    if (rows.length < limit) break;
    offset += limit;

    if (offset > 20000) break;
  }

  return all.map(normalizeOfficialStation).filter(Boolean);
}

async function getOfficialStationsCached() {
  const now = Date.now();
  if (cache.stations.length > 0 && now - cache.updatedAt < CACHE_TTL_MS) {
    return cache.stations;
  }

  const stations = await fetchOfficialAllStations();
  cache = {
    updatedAt: now,
    stations,
  };
  return stations;
}

function mapApiFuelToKey(fuel) {
  const byId = { 1: "gazole", 2: "sp95", 3: "e85", 4: "gpl", 5: "e10", 6: "sp98" };
  if (byId[fuel.id]) return byId[fuel.id];
  const shortName = String(fuel.shortName || "").toUpperCase();
  if (shortName.includes("E85")) return "e85";
  if (shortName.includes("GPL")) return "gpl";
  if (shortName.includes("E10")) return "e10";
  if (shortName.includes("SP98")) return "sp98";
  if (shortName.includes("SP95")) return "sp95";
  if (shortName.includes("GAZOLE")) return "gazole";
  return null;
}

function normalizeFallbackStation(raw) {
  const lat = raw?.Coordinates?.latitude;
  const lon = raw?.Coordinates?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const fuels = {};
  (raw.Fuels || []).forEach((fuel) => {
    const key = mapApiFuelToKey(fuel);
    const price = fuel?.Price?.value;
    if (!key || typeof price !== "number") return;
    fuels[key] = {
      price,
      available: Boolean(fuel.available),
      update: fuel?.Update?.text || null,
    };
  });

  if (Object.keys(fuels).length === 0) return null;

  return {
    id: `fb-${raw.id}`,
    name: raw.name || `Station ${raw.id}`,
    city: raw?.Address?.city_line || "",
    lat,
    lon,
    lastUpdateText: raw?.LastUpdate?.text || null,
    fuels,
  };
}

async function fetchFallbackAround(lat, lon, radiusKm) {
  const pageSize = 20;
  const maxPages = 200;
  const targetMeters = radiusKm * 1000;
  const rawRows = [];

  for (let page = 0; page < maxPages; page += 1) {
    const start = page * pageSize + 1;
    const end = start + pageSize - 1;
    const url = `${FALLBACK_API_BASE}/stations/around/${lat},${lon}?responseFields=Fuels,Price`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Range: `station=${start}-${end}`,
      },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`fallback api ${response.status}`);
    }

    const rows = await response.json();
    const arr = Array.isArray(rows) ? rows : [];
    if (arr.length === 0) break;

    rawRows.push(...arr);

    const farthest = arr[arr.length - 1]?.Distance?.value || arr[arr.length - 1]?.distance || 0;
    if (arr.length < pageSize || farthest >= targetMeters + 10000) {
      break;
    }
  }

  const uniqueById = new Map();
  rawRows.forEach((row) => {
    const normalized = normalizeFallbackStation(row);
    if (!normalized) return;
    const d = distanceKm(lat, lon, normalized.lat, normalized.lon);
    if (d <= radiusKm) uniqueById.set(normalized.id, normalized);
  });

  return [...uniqueById.values()];
}

async function stationsAroundHandler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radius = Number(req.query.radius || 20);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: "lat/lon invalides" });
      return;
    }

    const safeRadius = Number.isFinite(radius) ? Math.max(1, Math.min(radius, 500)) : 20;

    try {
      const official = await getOfficialStationsCached();
      const filtered = official.filter((station) => distanceKm(lat, lon, station.lat, station.lon) <= safeRadius);

      res.json({
        source: "official",
        updatedAt: new Date(cache.updatedAt).toISOString(),
        count: filtered.length,
        stations: filtered,
      });
      return;
    } catch (officialError) {
      const fallbackStations = await fetchFallbackAround(lat, lon, safeRadius);
      res.json({
        source: "fallback",
        updatedAt: new Date().toISOString(),
        count: fallbackStations.length,
        stations: fallbackStations,
      });
      return;
    }
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur" });
  }
}

app.get("/api/stations/around", stationsAroundHandler);
app.get("/stations/around", stationsAroundHandler);

app.use(express.static(path.join(__dirname)));

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`OpenOil server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
