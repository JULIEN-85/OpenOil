const express = require("express");
const path = require("path");

const app = express();

const OFFICIAL_API_BASE =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records";
const FALLBACK_API_BASE = "https://api.prix-carburants.2aaz.fr";
const TANKERKOENIG_API_BASE = "https://creativecommons.tankerkoenig.de/json";
const UK_MAPBOX_API_BASE = "https://fuelaround.me/api/data.mapbox";
const BENELUX_DIRECTLEASE_PLACES_API =
  "https://tankservice.app-it-up.com/Tankservice/v2/places?fmt=web&country=NL&country=BE&lang=en";
const BENELUX_DIRECTLEASE_PLACE_DETAIL_API =
  "https://tankservice.app-it-up.com/Tankservice/v2/places/{ID}?_v48&lang=en";
const BENELUX_ANWB_API_BASE = "https://api.anwb.nl/routing/points-of-interest/v3/all?type-filter=FUEL_STATION";
const UK_CMA_FEEDS = [
  {
    provider: "bp",
    url: "https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json",
  },
  {
    provider: "tesco",
    url: "https://www.tesco.com/fuel_prices/fuel_prices_data.json",
  },
  {
    provider: "sainsburys",
    url: "https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json",
  },
  {
    provider: "shell",
    url: "https://www.shell.co.uk/fuel-prices-data.html",
  },
  {
    provider: "mfg",
    url: "https://fuel.motorfuelgroup.com/fuel_prices_data.json",
  },
  {
    provider: "jet",
    url: "https://jetlocal.co.uk/fuel_prices_data.json",
  },
  {
    provider: "rontec",
    url: "https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json",
  },
];
const TANKERKOENIG_API_KEY = String(
  process.env.TANKERKOENIG_API_KEY || "ca388ee6-3614-41b9-863d-7f008e646c3d"
)
  .replace(/\s+/g, "")
  .trim();
const CACHE_TTL_MS = 2 * 60 * 1000;
const FREE_CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_HIDE_DAYS = 60;
const GERMANY_API_RADIUS_KM = 24;
const GERMANY_MAX_RADIUS_KM = 100;
const UK_MAX_RADIUS_KM = 250;
const BENELUX_MAX_RADIUS_KM = 500;
const FRANCE_BOUNDS = {
  minLat: 41,
  maxLat: 51.5,
  minLon: -5.5,
  maxLon: 9.8,
};
const GERMANY_BOUNDS = {
  minLat: 47.2,
  maxLat: 55.1,
  minLon: 5.8,
  maxLon: 15.1,
};
const UK_BOUNDS = {
  minLat: 49.5,
  maxLat: 61,
  minLon: -8.5,
  maxLon: 2.2,
};
const BENELUX_BOUNDS = {
  minLat: 49.3,
  maxLat: 53.9,
  minLon: 2.4,
  maxLon: 7.4,
};
const MAX_STATIONS_PER_QUERY = 5000;

let cache = {
  updatedAt: 0,
  stations: [],
};

let officialCachePromise = null;

let freeModeCache = {
  updatedAt: 0,
  stations: [],
  sources: [],
  failedSources: [],
};

let freeModeCachePromise = null;

const fuelFieldMap = {
  gazole: "gazole",
  sp95: "sp95",
  sp98: "sp98",
  e10: "e10",
  e85: "e85",
  gpl: "gplc",
};

const UNKNOWN_UPDATE_TEXT = "Non communiquee";

function resolveUpdateText(dateOrNull, explicitText) {
  if (typeof explicitText === "string" && explicitText.trim().length > 0) {
    return explicitText.trim();
  }

  if (dateOrNull instanceof Date && !Number.isNaN(dateOrNull.getTime())) {
    return dateOrNull.toLocaleString("fr-FR");
  }

  return UNKNOWN_UPDATE_TEXT;
}

function buildFuelEntry(type, price, available, dateOrNull = null, explicitText = null) {
  return {
    type,
    price,
    available,
    update: resolveUpdateText(dateOrNull, explicitText),
  };
}

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

function offsetCoordinateKm(lat, lon, northKm, eastKm) {
  const latOffset = northKm / 110.574;
  const lonDivisor = 111.32 * Math.cos((lat * Math.PI) / 180);
  const lonOffset = Math.abs(lonDivisor) < 1e-6 ? 0 : eastKm / lonDivisor;

  return {
    lat: lat + latOffset,
    lon: lon + lonOffset,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function circleIntersectsBounds(lat, lon, radiusKm, bounds) {
  const nearestLat = clamp(lat, bounds.minLat, bounds.maxLat);
  const nearestLon = clamp(lon, bounds.minLon, bounds.maxLon);
  return distanceKm(lat, lon, nearestLat, nearestLon) <= radiusKm;
}

function buildGermanySearchCenters(lat, lon, radiusKm) {
  const safeRadius = Math.max(1, Math.min(radiusKm, GERMANY_MAX_RADIUS_KM));
  const stepKm = GERMANY_API_RADIUS_KM * Math.SQRT2;
  const offsets = [];

  for (let northKm = -safeRadius; northKm <= safeRadius; northKm += stepKm) {
    offsets.push(northKm);
  }

  if (!offsets.some((value) => Math.abs(value) < 0.001)) {
    offsets.push(0);
  }

  const uniqueOffsets = [...new Set(offsets.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
  const centers = [];

  uniqueOffsets.forEach((northKm) => {
    uniqueOffsets.forEach((eastKm) => {
      if (Math.hypot(northKm, eastKm) > safeRadius + GERMANY_API_RADIUS_KM) {
        return;
      }

      centers.push(offsetCoordinateKm(lat, lon, northKm, eastKm));
    });
  });

  return centers;
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
    country: "FR",
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

    station.fuels[clientKey] = buildFuelEntry(clientKey, price, available, majDate);

    if (majDate && (!newestUpdate || majDate > newestUpdate)) {
      newestUpdate = majDate;
    }
  });

  if (Object.keys(station.fuels).length === 0) return null;

  station.lastUpdateText = newestUpdate ? newestUpdate.toLocaleString("fr-FR") : null;
  return station;
}

async function fetchOfficialStationsAround(lat, lon, radiusKm) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error("paramètres de localisation invalides");
  }

  const limit = 100;
  let offset = 0;
  const all = [];

  for (;;) {
    const where = `distance(geom, geom'POINT(${lon} ${lat})', ${radiusKm}km)`;
    const url = `${OFFICIAL_API_BASE}?where=${encodeURIComponent(where)}&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`official api ${response.status}`);

    const json = await response.json();
    const rows = Array.isArray(json.results) ? json.results : [];
    all.push(...rows);

    if (rows.length < limit) break;
    offset += limit;

    if (offset > MAX_STATIONS_PER_QUERY) break;
  }

  return all.map(normalizeOfficialStation).filter(Boolean);
}

async function fetchOfficialStationsAll() {
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

    if (offset > MAX_STATIONS_PER_QUERY) break;
  }

  return all.map(normalizeOfficialStation).filter(Boolean);
}

async function getOfficialStationsCached() {
  if (Date.now() - cache.updatedAt < CACHE_TTL_MS && cache.stations.length > 0) {
    return cache.stations;
  }

  if (officialCachePromise) {
    return officialCachePromise;
  }

  officialCachePromise = (async () => {
    try {
      const stations = await fetchOfficialStationsAll();
      cache = {
        updatedAt: Date.now(),
        stations,
      };
      return stations;
    } finally {
      officialCachePromise = null;
    }
  })();

  return officialCachePromise;
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
      ...buildFuelEntry(
        key,
        price,
        Boolean(fuel.available),
        parseDateMaybe(fuel?.Update?.value || fuel?.Update?.date || null),
        fuel?.Update?.text || null
      ),
    };
  });

  if (Object.keys(fuels).length === 0) return null;

  return {
    id: `fb-${raw.id}`,
    name: raw.name || `Station ${raw.id}`,
    country: "FR",
    city: raw?.Address?.city_line || "",
    lat,
    lon,
    lastUpdateText: raw?.LastUpdate?.text || null,
    fuels,
  };
}

function normalizeGermanyStation(raw) {
  const lat = raw?.lat;
  const lon = raw?.lng;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const fuels = {};
  const available = Boolean(raw?.isOpen);
  const stationUpdated = parseDateMaybe(raw?.date || raw?.updatedAt || raw?.lastUpdate || null);

  if (typeof raw?.diesel === "number") {
    fuels.gazole = buildFuelEntry("gazole", raw.diesel, available, stationUpdated);
  }

  if (typeof raw?.e5 === "number") {
    fuels.sp95 = buildFuelEntry("sp95", raw.e5, available, stationUpdated);
  }

  if (typeof raw?.e10 === "number") {
    fuels.e10 = buildFuelEntry("e10", raw.e10, available, stationUpdated);
  }

  if (Object.keys(fuels).length === 0) return null;

  const stationName = raw?.name || raw?.brand || raw?.street || `Station ${raw?.id || raw?.uuid || "DE"}`;

  return {
    id: `de-${raw?.id || raw?.uuid || stationName}`,
    name: stationName,
    country: "DE",
    city: raw?.place || "",
    lat,
    lon,
    lastUpdateText: resolveUpdateText(stationUpdated, null),
    fuels,
  };
}

function normalizeUkFuelKey(value) {
  const key = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!key) return null;
  if (key.includes("diesel")) return "gazole";
  if (key.includes("super_unleaded") || key.includes("premium_unleaded")) return "sp98";
  if (key.includes("unleaded") || key === "e5") return "sp95";
  if (key === "e10") return "e10";
  if (key.includes("lpg") || key.includes("autogas")) return "gpl";
  return null;
}

function normalizeBeneluxFuelKey(value) {
  const key = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!key) return null;
  if (key.includes("diesel")) return "gazole";
  if (key.includes("autogas") || key.includes("lpg")) return "gpl";
  if (key.includes("euro98") || key.includes("super_plus") || key.includes("e5")) return "sp98";
  if (key.includes("euro95") || key.includes("e10") || key.includes("unleaded")) return "e10";
  return null;
}

function normalizedStationIdentity(station) {
  const normalizedName = String(station?.name || "station")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const latKey = Number.isFinite(station?.lat) ? station.lat.toFixed(4) : "na";
  const lonKey = Number.isFinite(station?.lon) ? station.lon.toFixed(4) : "na";
  return `${normalizedName}|${latKey}|${lonKey}`;
}

function stationUpdateDate(station) {
  if (station?.updatedAtIso) {
    const parsedIso = parseDateMaybe(station.updatedAtIso);
    if (parsedIso) return parsedIso;
  }

  return parseDateMaybe(station?.lastUpdateText || null);
}

function pickNewestStation(existing, incoming) {
  const existingDate = stationUpdateDate(existing);
  const incomingDate = stationUpdateDate(incoming);

  if (!existingDate && incomingDate) return incoming;
  if (existingDate && !incomingDate) return existing;
  if (existingDate && incomingDate) {
    if (incomingDate > existingDate) return incoming;
    if (existingDate > incomingDate) return existing;
  }

  const existingFuelCount = Object.keys(existing?.fuels || {}).length;
  const incomingFuelCount = Object.keys(incoming?.fuels || {}).length;
  return incomingFuelCount > existingFuelCount ? incoming : existing;
}

function dedupeStationsPreferNewest(stations) {
  const byIdentity = new Map();

  stations.forEach((station) => {
    if (!station) return;

    const key = normalizedStationIdentity(station);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, station);
      return;
    }

    byIdentity.set(key, pickNewestStation(existing, station));
  });

  return [...byIdentity.values()];
}

function normalizeUkStation(feature, datasetUpdatedAt = null) {
  const coords = feature?.geometry?.coordinates;
  const lon = Array.isArray(coords) ? Number(coords[0]) : NaN;
  const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const props = feature?.properties || {};
  const fuels = {};

  if (props.grouped_fuels && typeof props.grouped_fuels === "object") {
    Object.entries(props.grouped_fuels).forEach(([groupKey, value]) => {
      const key = normalizeUkFuelKey(groupKey);
      const price = Number(value?.price);
      if (!key || !Number.isFinite(price)) return;

      const fuelUpdated =
        parseDateMaybe(value?.updatedAt || value?.updated || value?.last_updated || null) ||
        parseDateMaybe(props?.updatedAt || props?.updated || props?.last_updated || null) ||
        datasetUpdatedAt ||
        null;

      fuels[key] = {
        ...buildFuelEntry(key, price, true, fuelUpdated, null),
      };
    });
  }

  if (Object.keys(fuels).length === 0 && props.fuel_prices && typeof props.fuel_prices === "object") {
    Object.entries(props.fuel_prices).forEach(([rawKey, rawPrice]) => {
      const key = normalizeUkFuelKey(rawKey);
      const price = Number(rawPrice);
      if (!key || !Number.isFinite(price)) return;

      const fuelUpdated =
        parseDateMaybe(props?.updatedAt || props?.updated || props?.last_updated || null) ||
        datasetUpdatedAt ||
        null;

      fuels[key] = {
        ...buildFuelEntry(key, price, true, fuelUpdated, null),
      };
    });
  }

  if (Object.keys(fuels).length === 0) return null;

  const stationUpdated =
    parseDateMaybe(props?.updatedAt || props?.updated || props?.last_updated || null) || datasetUpdatedAt || null;

  const stationId = props.station_id || `${props.brand || "UK"}-${lat.toFixed(5)}-${lon.toFixed(5)}`;
  const stationName = props.brand || props.title || `Station ${stationId}`;

  return {
    id: `uk-${stationId}`,
    name: stationName,
    country: "GB",
    city: props.postcode || "",
    lat,
    lon,
    lastUpdateText: resolveUpdateText(stationUpdated, null),
    updatedAtIso: stationUpdated ? stationUpdated.toISOString() : null,
    fuels,
  };
}

function normalizeCmaUkStation(raw, providerName, datasetUpdatedAt) {
  const lat = Number(raw?.location?.latitude);
  const lon = Number(raw?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const stationUpdated = parseDateMaybe(raw?.updated || raw?.last_updated) || datasetUpdatedAt || null;
  const fuels = {};
  const prices = raw?.prices && typeof raw.prices === "object" ? raw.prices : {};

  Object.entries(prices).forEach(([fuelKeyRaw, fuelPriceRaw]) => {
    const fuelKey = normalizeUkFuelKey(fuelKeyRaw);
    const price = Number(fuelPriceRaw);
    if (!fuelKey || !Number.isFinite(price)) return;

    fuels[fuelKey] = {
      ...buildFuelEntry(fuelKey, price, true, stationUpdated),
    };
  });

  if (Object.keys(fuels).length === 0) return null;

  const stationId = raw?.site_id || `${providerName}-${lat.toFixed(5)}-${lon.toFixed(5)}`;

  return {
    id: `ukcma-${providerName}-${stationId}`,
    name: raw?.brand || providerName.toUpperCase(),
    country: "GB",
    city: raw?.postcode || "",
    lat,
    lon,
    lastUpdateText: resolveUpdateText(stationUpdated, null),
    updatedAtIso: stationUpdated ? stationUpdated.toISOString() : null,
    fuels,
  };
}

async function fetchUkFuelFeedAround(lat, lon, radiusKm) {
  const safeRadius = Math.max(1, Math.min(radiusKm, UK_MAX_RADIUS_KM));
  const southWest = offsetCoordinateKm(lat, lon, -safeRadius, -safeRadius);
  const northEast = offsetCoordinateKm(lat, lon, safeRadius, safeRadius);

  const bbox = `${southWest.lon},${southWest.lat},${northEast.lon},${northEast.lat}`;
  const center = `${lon},${lat}`;
  const url =
    `${UK_MAPBOX_API_BASE}?bbox=${encodeURIComponent(bbox)}` +
    `&center=${encodeURIComponent(center)}&limit=2000`;

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`uk api ${response.status}`);
  }

  const payload = await response.json();
  const datasetUpdatedAt =
    parseDateMaybe(payload?.last_updated || payload?.updatedAt || payload?.generatedAt || null) ||
    parseDateMaybe(response.headers.get("last-modified") || response.headers.get("date") || null) ||
    new Date();
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const uniqueById = new Map();

  features.forEach((feature) => {
    const normalized = normalizeUkStation(feature, datasetUpdatedAt);
    if (!normalized) return;

    const d = distanceKm(lat, lon, normalized.lat, normalized.lon);
    if (d > safeRadius) return;

    uniqueById.set(normalized.id, normalized);
  });

  return [...uniqueById.values()];
}

async function fetchUkCmaAround(lat, lon, radiusKm) {
  const safeRadius = Math.max(1, Math.min(radiusKm, UK_MAX_RADIUS_KM));
  const allStations = [];
  const failedFeeds = [];

  const results = await Promise.allSettled(
    UK_CMA_FEEDS.map(async (feed) => {
      const response = await fetch(feed.url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0",
        },
      });

      if (!response.ok) {
        throw new Error(`${feed.provider}: ${response.status}`);
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${feed.provider}: invalid json`);
      }

      const feedUpdatedAt = parseDateMaybe(payload?.last_updated || payload?.lastUpdated || null);
      const rawStations = Array.isArray(payload?.stations) ? payload.stations : [];

      rawStations.forEach((rawStation) => {
        const normalized = normalizeCmaUkStation(rawStation, feed.provider, feedUpdatedAt);
        if (!normalized) return;

        const d = distanceKm(lat, lon, normalized.lat, normalized.lon);
        if (d > safeRadius) return;

        allStations.push(normalized);
      });
    })
  );

  results.forEach((result) => {
    if (result.status === "rejected") {
      failedFeeds.push(String(result.reason?.message || "uk-cma feed error"));
    }
  });

  return {
    stations: dedupeStationsPreferNewest(allStations),
    failedFeeds,
  };
}

async function fetchUkCmaAll() {
  const allStations = [];
  const failedFeeds = [];

  const results = await Promise.allSettled(
    UK_CMA_FEEDS.map(async (feed) => {
      const response = await fetch(feed.url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0",
        },
      });

      if (!response.ok) {
        throw new Error(`${feed.provider}: ${response.status}`);
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${feed.provider}: invalid json`);
      }

      const feedUpdatedAt = parseDateMaybe(payload?.last_updated || payload?.lastUpdated || null);
      const rawStations = Array.isArray(payload?.stations) ? payload.stations : [];

      rawStations.forEach((rawStation) => {
        const normalized = normalizeCmaUkStation(rawStation, feed.provider, feedUpdatedAt);
        if (!normalized) return;
        allStations.push(normalized);
      });
    })
  );

  results.forEach((result) => {
    if (result.status === "rejected") {
      failedFeeds.push(String(result.reason?.message || "uk-cma feed error"));
    }
  });

  return {
    stations: dedupeStationsPreferNewest(allStations),
    failedFeeds,
  };
}

async function fetchUkAround(lat, lon, radiusKm) {
  try {
    const stations = await fetchUkFuelFeedAround(lat, lon, radiusKm);
    if (stations.length > 0) {
      return {
        source: "fuelfeed-uk",
        stations,
        failedSources: [],
      };
    }
  } catch (error) {
    const cma = await fetchUkCmaAround(lat, lon, radiusKm);
    return {
      source: "cma-uk",
      stations: cma.stations,
      failedSources: [`fuelfeed-uk: ${String(error?.message || "error")}`, ...cma.failedFeeds],
    };
  }

  const cma = await fetchUkCmaAround(lat, lon, radiusKm);
  if (cma.stations.length > 0) {
    return {
      source: "cma-uk",
      stations: cma.stations,
      failedSources: cma.failedFeeds,
    };
  }

  return {
    source: "fuelfeed-uk",
    stations: [],
    failedSources: cma.failedFeeds,
  };
}

function normalizeBeneluxAnwbStation(raw, fallbackName = "Benelux station") {
  const lat = Number(raw?.coordinates?.latitude);
  const lon = Number(raw?.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const fuels = {};
  const prices = Array.isArray(raw?.prices) ? raw.prices : [];
  prices.forEach((priceItem) => {
    const fuelKey = normalizeBeneluxFuelKey(priceItem?.fuelType || priceItem?.fuelName || "");
    const price = Number(priceItem?.value ?? priceItem?.price);
    if (!fuelKey || !Number.isFinite(price)) return;

    fuels[fuelKey] = {
      ...buildFuelEntry(
        fuelKey,
        price,
        true,
        parseDateMaybe(priceItem?.updatedAt || priceItem?.updated || priceItem?.lastUpdated || null),
        null
      ),
    };
  });

  if (Object.keys(fuels).length === 0) return null;

  const address = raw?.address || {};
  const city = address.city || address.postalCode || "";
  const stationId = raw?.id || `${lat.toFixed(5)}-${lon.toFixed(5)}`;

  return {
    id: `benelux-anwb-${stationId}`,
    name: raw?.title || fallbackName,
    country: String(address.countryCode || raw?.countryCode || "BENELUX").toUpperCase(),
    city,
    lat,
    lon,
    lastUpdateText: resolveUpdateText(parseDateMaybe(raw?.updatedAt || raw?.updated || null), null),
    updatedAtIso: null,
    fuels,
  };
}

function normalizeBeneluxDirectLeaseStation(detail, baseStation) {
  const lat = Number(detail?.lat ?? baseStation?.lat);
  const lon = Number(detail?.lng ?? baseStation?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const fuels = {};
  const fuelCollections = [detail?.prices, detail?.fuels, detail?.fuelPrices];

  fuelCollections.forEach((collection) => {
    if (!collection) return;
    const entries = Array.isArray(collection) ? collection : Object.values(collection);

    entries.forEach((fuelItem) => {
      const fuelKey = normalizeBeneluxFuelKey(
        fuelItem?.fuelType || fuelItem?.type || fuelItem?.fuelName || fuelItem?.name || ""
      );
      const price = Number(fuelItem?.value ?? fuelItem?.price ?? fuelItem?.amount);
      if (!fuelKey || !Number.isFinite(price)) return;

      fuels[fuelKey] = {
        ...buildFuelEntry(
          fuelKey,
          price,
          true,
          parseDateMaybe(fuelItem?.updatedAt || fuelItem?.updated || fuelItem?.lastUpdated || null),
          null
        ),
      };
    });
  });

  if (Object.keys(fuels).length === 0) return null;

  const stationUpdated =
    parseDateMaybe(detail?.updatedAt || detail?.updated || detail?.lastUpdated || detail?.timestamp) || null;
  const stationId = detail?.id || baseStation?.id || `${lat.toFixed(5)}-${lon.toFixed(5)}`;

  return {
    id: `benelux-dl-${stationId}`,
    name: detail?.name || baseStation?.name || "Benelux station",
    country: String(detail?.country || detail?.countryCode || baseStation?.country || "BENELUX").toUpperCase(),
    city: detail?.city || baseStation?.city || "",
    lat,
    lon,
    lastUpdateText: stationUpdated ? stationUpdated.toLocaleString("en-GB") : null,
    updatedAtIso: stationUpdated ? stationUpdated.toISOString() : null,
    fuels,
  };
}

async function fetchBeneluxDirectLeaseAround(lat, lon, radiusKm) {
  const safeRadius = Math.max(1, Math.min(radiusKm, BENELUX_MAX_RADIUS_KM));
  const response = await fetch(BENELUX_DIRECTLEASE_PLACES_API, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`directlease list ${response.status}`);
  }

  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : [];
  const nearby = list
    .filter((row) => {
      const rowLat = Number(row?.lat);
      const rowLon = Number(row?.lng);
      if (!Number.isFinite(rowLat) || !Number.isFinite(rowLon)) return false;
      return distanceKm(lat, lon, rowLat, rowLon) <= safeRadius;
    })
    .slice(0, 200);

  if (nearby.length === 0) {
    return { stations: [], failedFeeds: [] };
  }

  const probeId = nearby[0]?.id;
  const probeUrl = BENELUX_DIRECTLEASE_PLACE_DETAIL_API.replace("{ID}", encodeURIComponent(String(probeId)));
  const probeResponse = await fetch(probeUrl, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (probeResponse.status === 401) {
    throw new Error("directlease detail authentication required");
  }

  if (!probeResponse.ok) {
    throw new Error(`directlease detail ${probeResponse.status}`);
  }

  const settled = await Promise.allSettled(
    nearby.map(async (baseStation) => {
      const detailUrl = BENELUX_DIRECTLEASE_PLACE_DETAIL_API.replace(
        "{ID}",
        encodeURIComponent(String(baseStation.id))
      );
      const detailResp = await fetch(detailUrl, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0",
        },
      });

      if (!detailResp.ok) {
        throw new Error(`directlease ${baseStation.id}: ${detailResp.status}`);
      }

      const detailPayload = await detailResp.json();
      const normalized = normalizeBeneluxDirectLeaseStation(detailPayload, baseStation);
      return normalized;
    })
  );

  const stations = settled
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value)
    .filter(Boolean);

  const failedFeeds = settled
    .filter((item) => item.status === "rejected")
    .map((item) => String(item.reason?.message || "directlease detail error"));

  return {
    stations: dedupeStationsPreferNewest(stations),
    failedFeeds,
  };
}

async function fetchBeneluxAnwbAround(lat, lon, radiusKm) {
  const safeRadius = Math.max(1, Math.min(radiusKm, BENELUX_MAX_RADIUS_KM));
  const southWest = offsetCoordinateKm(lat, lon, -safeRadius, -safeRadius);
  const northEast = offsetCoordinateKm(lat, lon, safeRadius, safeRadius);
  const bbox = `${southWest.lat},${southWest.lon},${northEast.lat},${northEast.lon}`;
  const url = `${BENELUX_ANWB_API_BASE}&bounding-box-filter=${encodeURIComponent(bbox)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`anwb ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.value) ? payload.value : [];
  const stations = [];

  rows.forEach((row) => {
    const normalized = normalizeBeneluxAnwbStation(row);
    if (!normalized) return;

    const d = distanceKm(lat, lon, normalized.lat, normalized.lon);
    if (d <= safeRadius) stations.push(normalized);
  });

  return dedupeStationsPreferNewest(stations);
}

async function fetchBeneluxAround(lat, lon, radiusKm) {
  try {
    const directLease = await fetchBeneluxDirectLeaseAround(lat, lon, radiusKm);
    if (directLease.stations.length > 0) {
      return {
        source: "directlease-benelux",
        stations: directLease.stations,
        failedSources: directLease.failedFeeds,
      };
    }

    const anwbStations = await fetchBeneluxAnwbAround(lat, lon, radiusKm);
    return {
      source: "anwb-benelux",
      stations: anwbStations,
      failedSources: directLease.failedFeeds,
    };
  } catch (directLeaseError) {
    const anwbStations = await fetchBeneluxAnwbAround(lat, lon, radiusKm);
    return {
      source: "anwb-benelux",
      stations: anwbStations,
      failedSources: [String(directLeaseError?.message || "directlease error")],
    };
  }
}

async function fetchGermanyAround(lat, lon, radiusKm) {
  if (!TANKERKOENIG_API_KEY) {
    throw new Error("missing tankerkoenig api key");
  }

  const centers = buildGermanySearchCenters(lat, lon, radiusKm);
  const responses = await Promise.all(
    centers.map(async (center) => {
      const url =
        `${TANKERKOENIG_API_BASE}/list.php?lat=${center.lat}&lng=${center.lon}` +
        `&rad=${GERMANY_API_RADIUS_KM}&sort=dist&type=all&apikey=${encodeURIComponent(TANKERKOENIG_API_KEY)}`;

      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`tankerkonig api ${response.status}`);
      }

      const payload = await response.json();
      if (payload?.status !== "ok") {
        throw new Error(`tankerkonig status ${payload?.status || "unknown"}`);
      }

      return Array.isArray(payload?.stations) ? payload.stations : [];
    })
  );

  const uniqueById = new Map();

  responses.flat().forEach((row) => {
    const normalized = normalizeGermanyStation(row);
    if (!normalized) return;

    const distance = distanceKm(lat, lon, normalized.lat, normalized.lon);
    if (distance > radiusKm) return;

    uniqueById.set(normalized.id, normalized);
  });

  return [...uniqueById.values()];
}

async function fetchGermanyWide() {
  const hubs = [
    { lat: 53.55, lon: 10.0 }, // Hamburg
    { lat: 52.52, lon: 13.405 }, // Berlin
    { lat: 50.94, lon: 6.96 }, // Cologne
    { lat: 50.11, lon: 8.68 }, // Frankfurt
    { lat: 48.14, lon: 11.58 }, // Munich
    { lat: 48.78, lon: 9.18 }, // Stuttgart
    { lat: 51.34, lon: 12.37 }, // Leipzig
    { lat: 53.08, lon: 8.8 }, // Bremen
  ];

  const settled = await Promise.allSettled(
    hubs.map((hub) => fetchGermanyAround(hub.lat, hub.lon, GERMANY_MAX_RADIUS_KM))
  );

  const stations = [];
  const failedFeeds = [];

  settled.forEach((result) => {
    if (result.status === "fulfilled") {
      stations.push(...result.value);
      return;
    }

    failedFeeds.push(String(result.reason?.message || "tankerkonig wide error"));
  });

  return {
    stations: dedupeStationsPreferNewest(stations),
    failedFeeds,
  };
}

async function fetchBeneluxWide() {
  const centerLat = (BENELUX_BOUNDS.minLat + BENELUX_BOUNDS.maxLat) / 2;
  const centerLon = (BENELUX_BOUNDS.minLon + BENELUX_BOUNDS.maxLon) / 2;

  const anwbStations = await fetchBeneluxAnwbAround(centerLat, centerLon, BENELUX_MAX_RADIUS_KM);
  return {
    stations: anwbStations,
    failedFeeds: [],
  };
}

async function collectFreeModeStations() {
  const sourceRequests = [
    fetchFranceAround(46.6, 2.4, 1000),
    fetchGermanyWide().then((payload) => ({
      source: "tankerkonig",
      updatedAt: new Date().toISOString(),
      stations: payload.stations,
      failedSources: payload.failedFeeds,
    })),
    fetchUkCmaAll().then((payload) => ({
      source: "cma-uk",
      updatedAt: new Date().toISOString(),
      stations: payload.stations,
      failedSources: payload.failedFeeds,
    })),
    fetchBeneluxWide().then((payload) => ({
      source: "anwb-benelux",
      updatedAt: new Date().toISOString(),
      stations: payload.stations,
      failedSources: payload.failedFeeds,
    })),
  ];

  const settled = await Promise.allSettled(sourceRequests);
  const fulfilled = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const rejected = settled
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || "source error"));

  const partialFailures = fulfilled
    .flatMap((entry) => (Array.isArray(entry.failedSources) ? entry.failedSources : []))
    .filter(Boolean);

  const combinedStations = dedupeStationsPreferNewest(mergeStationsById(fulfilled.map((entry) => entry.stations)));
  const nonEmptyFulfilled = fulfilled.filter((entry) => Array.isArray(entry.stations) && entry.stations.length > 0);
  const sourceBase = nonEmptyFulfilled.length > 0 ? nonEmptyFulfilled : fulfilled;
  const sources = [...new Set(sourceBase.map((entry) => entry.source))];
  const updatedAt = fulfilled
    .map((entry) => entry.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    source: sources.length === 1 ? sources[0] : "mixed",
    sources,
    failedSources: [...partialFailures, ...rejected],
    updatedAt: updatedAt || new Date().toISOString(),
    count: combinedStations.length,
    stations: combinedStations,
  };
}

async function getFreeModeStationsCached() {
  if (Date.now() - freeModeCache.updatedAt < FREE_CACHE_TTL_MS && freeModeCache.stations.length > 0) {
    return {
      source: freeModeCache.sources.length === 1 ? freeModeCache.sources[0] : "mixed",
      sources: freeModeCache.sources,
      failedSources: freeModeCache.failedSources,
      updatedAt: new Date(freeModeCache.updatedAt).toISOString(),
      count: freeModeCache.stations.length,
      stations: freeModeCache.stations,
      cacheState: "hit",
    };
  }

  if (freeModeCachePromise) {
    return freeModeCachePromise;
  }

  freeModeCachePromise = (async () => {
    try {
      const payload = await collectFreeModeStations();
      freeModeCache = {
        updatedAt: Date.now(),
        stations: payload.stations,
        sources: payload.sources,
        failedSources: payload.failedSources,
      };

      return {
        ...payload,
        cacheState: "refresh",
      };
    } finally {
      freeModeCachePromise = null;
    }
  })();

  return freeModeCachePromise;
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

async function fetchFranceAround(lat, lon, radiusKm) {
  try {
    const official = await getOfficialStationsCached();
    const filtered = official.filter((station) => distanceKm(lat, lon, station.lat, station.lon) <= radiusKm);

    return {
      source: "official",
      updatedAt: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : new Date().toISOString(),
      stations: filtered,
    };
  } catch (officialError) {
    const fallbackStations = await fetchFallbackAround(lat, lon, radiusKm);
    return {
      source: "fallback",
      updatedAt: new Date().toISOString(),
      stations: fallbackStations,
    };
  }
}

function mergeStationsById(groups) {
  const merged = new Map();

  groups.flat().forEach((station) => {
    if (!station) return;
    merged.set(station.id, station);
  });

  return [...merged.values()];
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

    const shouldQueryFrance = circleIntersectsBounds(lat, lon, safeRadius, FRANCE_BOUNDS);
    const shouldQueryGermany = circleIntersectsBounds(lat, lon, safeRadius, GERMANY_BOUNDS);
    const shouldQueryUk = circleIntersectsBounds(lat, lon, safeRadius, UK_BOUNDS);
    const shouldQueryBenelux = circleIntersectsBounds(lat, lon, safeRadius, BENELUX_BOUNDS);

    const sourceRequests = [];

    if (shouldQueryFrance) {
      sourceRequests.push(fetchFranceAround(lat, lon, safeRadius));
    }

    if (shouldQueryGermany) {
      sourceRequests.push(
        fetchGermanyAround(lat, lon, safeRadius).then((stations) => ({
          source: "tankerkonig",
          updatedAt: new Date().toISOString(),
          stations,
        }))
      );
    }

    if (shouldQueryUk) {
      sourceRequests.push(
        fetchUkAround(lat, lon, safeRadius).then((ukPayload) => ({
          source: ukPayload.source,
          updatedAt: new Date().toISOString(),
          stations: ukPayload.stations,
          failedSources: ukPayload.failedSources || [],
        }))
      );
    }

    if (shouldQueryBenelux) {
      sourceRequests.push(
        fetchBeneluxAround(lat, lon, safeRadius).then((beneluxPayload) => ({
          source: beneluxPayload.source,
          updatedAt: new Date().toISOString(),
          stations: beneluxPayload.stations,
          failedSources: beneluxPayload.failedSources || [],
        }))
      );
    }

    if (sourceRequests.length === 0) {
      res.json({
        source: "none",
        updatedAt: new Date().toISOString(),
        count: 0,
        stations: [],
      });
      return;
    }

    const settled = await Promise.allSettled(sourceRequests);
    const fulfilled = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const rejected = settled
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason?.message || "source error"));

    const partialFailures = fulfilled
      .flatMap((entry) => (Array.isArray(entry.failedSources) ? entry.failedSources : []))
      .filter(Boolean);

    if (fulfilled.length === 0) {
      res.json({
        source: "unavailable",
        sources: [],
        failedSources: rejected,
        updatedAt: new Date().toISOString(),
        count: 0,
        stations: [],
      });
      return;
    }

    const combinedStations = mergeStationsById(fulfilled.map((entry) => entry.stations));
    const nonEmptyFulfilled = fulfilled.filter((entry) => Array.isArray(entry.stations) && entry.stations.length > 0);
    const sourceBase = nonEmptyFulfilled.length > 0 ? nonEmptyFulfilled : fulfilled;
    const sources = [...new Set(sourceBase.map((entry) => entry.source))];
    const updatedAt = fulfilled
      .map((entry) => entry.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    res.json({
      source: sources.length === 1 ? sources[0] : "mixed",
      sources,
      failedSources: [...partialFailures, ...rejected],
      updatedAt: updatedAt || new Date().toISOString(),
      count: combinedStations.length,
      stations: combinedStations,
    });
    return;
  } catch (error) {
    console.error("stationsAroundHandler error:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
}

async function stationsFreeHandler(req, res) {
  try {
    const payload = await getFreeModeStationsCached();
    res.json(payload);
  } catch (error) {
    console.error("stationsFreeHandler error:", error);
    res.status(500).json({ error: "Erreur serveur mode libre" });
  }
}

app.get("/api/stations/around", stationsAroundHandler);
app.get("/stations/around", stationsAroundHandler);
app.get("/api/stations/free", stationsFreeHandler);
app.get("/stations/free", stationsFreeHandler);

app.use(express.static(path.join(__dirname)));

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`OpenOil server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
