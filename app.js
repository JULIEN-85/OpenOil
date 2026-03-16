const DEFAULT_CENTER = [48.8566, 2.3522];
const RADIUS_OPTIONS = [10, 20, 30, 40, 50];
const API_BASE = "/api";
const LIVE_REFRESH_MS = 60000;
const DEFAULT_FETCH_RADIUS_KM = 50;

const map = L.map("map").setView(DEFAULT_CENTER, 10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const fuelSelect = document.getElementById("fuelSelect");
const locationInput = document.getElementById("locationInput");
const searchLocationBtn = document.getElementById("searchLocationBtn");
const onlyAvailableCheckbox = document.getElementById("onlyAvailable");
const priceMaxInput = document.getElementById("priceMax");
const locateBtn = document.getElementById("locateBtn");
const refreshBtn = document.getElementById("refreshBtn");
const radiiContainer = document.getElementById("radii");
const customRadiusInput = document.getElementById("customRadiusInput");
const applyRadiusBtn = document.getElementById("applyRadiusBtn");
const comparisonResult = document.getElementById("comparisonResult");
const stationListResult = document.getElementById("stationListResult");
const liveStatus = document.getElementById("liveStatus");
const sectionToggleButtons = document.querySelectorAll(".section-toggle");

let stations = [];
let stationLayerGroup = L.layerGroup().addTo(map);
let currentCenter = { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1], label: "Centre carte" };
let userMarker = null;
let radiusCircle = null;
let selectedRadius = 20;
let refreshIntervalId = null;
let isRefreshing = false;

const fuelLabels = {
  gazole: "Gazole",
  sp95: "SP95",
  sp98: "SP98",
  e10: "E10",
  e85: "E85",
  gpl: "GPL",
};

function initFilterSections() {
  sectionToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.closest(".filter-section");
      if (!section) {
        return;
      }

      const willExpand = section.classList.contains("collapsed");
      section.classList.toggle("collapsed", !willExpand);
      button.setAttribute("aria-expanded", String(willExpand));

      const stateLabel = button.querySelector(".section-toggle-state");
      if (stateLabel) {
        stateLabel.textContent = willExpand ? "Masquer" : "Afficher";
      }
    });
  });
}

function createRadiusButtons() {
  RADIUS_OPTIONS.forEach((radius) => {
    const button = document.createElement("button");
    button.dataset.radius = String(radius);
    button.className = `radius-btn${radius === selectedRadius ? " active" : ""}`;
    button.textContent = `${radius} km`;
    button.addEventListener("click", () => {
      setSelectedRadius(radius, "rayon");
    });
    radiiContainer.appendChild(button);
  });

  customRadiusInput.value = String(selectedRadius);
}

function syncRadiusButtons() {
  [...radiiContainer.children].forEach((child) => {
    const radius = Number(child.dataset.radius);
    child.classList.toggle("active", radius === selectedRadius);
  });
}

function setSelectedRadius(radius, source = "rayon personnalisé") {
  const parsedRadius = Number(radius);
  if (!Number.isFinite(parsedRadius) || parsedRadius <= 0) {
    return;
  }

  selectedRadius = Math.round(parsedRadius);
  customRadiusInput.value = String(selectedRadius);
  syncRadiusButtons();
  updateRadiusCircle();
  renderStations();

  if (selectedRadius > DEFAULT_FETCH_RADIUS_KM) {
    refreshLiveStations(source);
  }
}

function iconForStation(station, selectedFuel) {
  const fuel = station.fuels[selectedFuel];
  const dotClass = !fuel ? "dot-gray" : fuel.available ? "dot-green" : "dot-orange";

  return L.divIcon({
    className: "",
    html: `<div class="marker-dot ${dotClass}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function formatEuro(value) {
  return `${value.toFixed(3)} €`;
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

function stationPopup(station) {
  const rows = Object.entries(station.fuels)
    .map(([fuelKey, fuel]) => {
      const state = fuel.available ? "Disponible" : "Indisponible";
      return `<li>${fuelLabels[fuelKey]}: <strong>${formatEuro(fuel.price)}</strong> (${state})</li>`;
    })
    .join("");

  const lastUpdate = station.lastUpdateText ? `<br />MàJ station: ${station.lastUpdateText}` : "";

  return `
    <div>
      <strong>${station.name}</strong><br />
      ${station.city}${lastUpdate}<br />
      <ul style="padding-left: 18px; margin: 8px 0 0;">
        ${rows}
      </ul>
    </div>
  `;
}

function getFilteredStations() {
  const selectedFuel = fuelSelect.value;
  const onlyAvailable = onlyAvailableCheckbox.checked;
  const maxPrice = Number(priceMaxInput.value);
  const hasMax = Number.isFinite(maxPrice) && maxPrice > 0;

  return stations.filter((station) => {
    const fuel = station.fuels[selectedFuel];
    const distance = distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon);
    if (!fuel) return false;
    if (distance > selectedRadius) return false;
    if (onlyAvailable && !fuel.available) return false;
    if (hasMax && fuel.price > maxPrice) return false;
    return true;
  });
}

function renderStations() {
  const selectedFuel = fuelSelect.value;
  const filtered = getFilteredStations();
  const totalInRadius = stations.filter(
    (station) => distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon) <= selectedRadius
  ).length;

  stationLayerGroup.clearLayers();

  filtered.forEach((station) => {
    const marker = L.marker([station.lat, station.lon], {
      icon: iconForStation(station, selectedFuel),
    });

    marker.bindPopup(stationPopup(station));

    stationLayerGroup.addLayer(marker);
  });

  const baseStatus = liveStatus.textContent;
  if (typeof baseStatus === "string" && baseStatus.trim().length > 0) {
    const statusPrefix = baseStatus.split(" · ")[0];
    setLiveStatus(`${statusPrefix} · ${filtered.length}/${totalInRadius} stations affichées · rayon ${selectedRadius} km`);
  }

  renderStationList(filtered, selectedFuel);
  renderComparison();
}

function renderStationList(filteredStations, selectedFuel) {
  const sorted = [...filteredStations].sort((a, b) => {
    const priceA = a.fuels[selectedFuel]?.price;
    const priceB = b.fuels[selectedFuel]?.price;
    return priceA - priceB;
  });

  if (sorted.length === 0) {
    stationListResult.innerHTML = "Aucune station affichée avec les filtres actuels.";
    return;
  }

  const items = sorted
    .map((station) => {
      const fuel = station.fuels[selectedFuel];
      const distance = distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon);
      return `
        <div class="station-list-item" data-lat="${station.lat}" data-lon="${station.lon}" style="cursor:pointer">
          <div class="station-list-top">
            <span class="station-name">${station.name}</span>
            <span class="station-price">${formatEuro(fuel.price)}</span>
          </div>
          <div class="station-list-meta">${station.city || "Ville inconnue"} · ${distance.toFixed(1)} km</div>
        </div>
      `;
    })
    .join("");

  stationListResult.innerHTML = items;

  stationListResult.querySelectorAll(".station-list-item").forEach((el) => {
    el.addEventListener("click", () => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      map.flyTo([lat, lon], 16, { duration: 0.8 });
      stationLayerGroup.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          const pos = layer.getLatLng();
          if (Math.abs(pos.lat - lat) < 0.0001 && Math.abs(pos.lng - lon) < 0.0001) {
            layer.openPopup();
          }
        }
      });
    });
  });
}

function stationsInRadius() {
  const selectedFuel = fuelSelect.value;

  return getFilteredStations()
    .map((station) => {
      const fuel = station.fuels[selectedFuel];
      const distance = distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon);
      return { station, fuel, distance };
    })
    .filter((item) => item.fuel && item.fuel.available && item.distance <= selectedRadius)
    .sort((a, b) => a.fuel.price - b.fuel.price);
}

function renderComparison() {
  const inRange = stationsInRadius();

  if (inRange.length === 0) {
    comparisonResult.innerHTML =
      "<div class=\"comparison-empty\" data-i18n>Aucune station disponible avec les filtres actuels.</div>";
    if (typeof window.openOilRetranslate === "function") {
      window.openOilRetranslate();
    }
    return;
  }

  const prices = inRange.map((item) => item.fuel.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((acc, value) => acc + value, 0) / prices.length;
  const cheapestPrice = min;
  const savingPerL = avg - cheapestPrice;

  comparisonResult.innerHTML = `
    <div class="comparison-kpis">
      <article class="kpi-card kpi-card-wide">
        <div class="kpi-label" data-i18n>Nombre de stations</div>
        <div class="kpi-value">${inRange.length}</div>
      </article>
      <article class="kpi-card kpi-card-accent">
        <div class="kpi-label" data-i18n>Prix moyen</div>
        <div class="kpi-value">${formatEuro(avg)}</div>
      </article>
      <article class="kpi-card">
        <div class="kpi-label" data-i18n>Prix minimum</div>
        <div class="kpi-value">${formatEuro(min)}</div>
      </article>
      <article class="kpi-card">
        <div class="kpi-label" data-i18n>Prix maximum</div>
        <div class="kpi-value">${formatEuro(max)}</div>
      </article>
      <article class="kpi-card kpi-card-saving">
        <div class="kpi-label" data-i18n>Économie potentielle vs moyenne</div>
        <div class="kpi-value">${formatEuro(savingPerL)} <span data-i18n>/ litre</span></div>
      </article>
    </div>
  `;

  if (typeof window.openOilRetranslate === "function") {
    window.openOilRetranslate();
  }
}

function updateRadiusCircle() {
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
  }

  radiusCircle = L.circle([currentCenter.lat, currentCenter.lon], {
    radius: selectedRadius * 1000,
    color: "#165dff",
    fillColor: "#165dff",
    fillOpacity: 0.08,
    weight: 1.5,
  }).addTo(map);
}

function setLiveStatus(text) {
  liveStatus.textContent = text;
}

function formatSyncTime(date) {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function fetchLiveStationsFromBackend(lat, lon, radiusKm) {
  const endpoint = `${API_BASE}/stations/around?lat=${lat}&lon=${lon}&radius=${radiusKm}`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.stations) ? payload.stations : [];

  return {
    stations: rows,
    source: payload?.source || "unknown",
    sources: Array.isArray(payload?.sources) ? payload.sources : [],
    updatedAt: payload?.updatedAt || null,
  };
}

async function loadLocalFallbackStations() {
  const response = await fetch("./data/stations.json");
  const localData = await response.json();
  stations = Array.isArray(localData) ? localData : [];
}

async function refreshLiveStations(source = "auto") {
  if (isRefreshing) {
    return;
  }

  isRefreshing = true;
  setLiveStatus(`Mise à jour live (${source})...`);

  try {
    const fetchRadiusKm = Math.max(DEFAULT_FETCH_RADIUS_KM, selectedRadius);
    const payload = await fetchLiveStationsFromBackend(currentCenter.lat, currentCenter.lon, fetchRadiusKm);
    const liveStations = payload.stations;
    const sourceList = Array.isArray(payload.sources) ? payload.sources : [];
    const sourceNames = {
      official: "France",
      fallback: "France (fallback)",
      tankerkonig: "Allemagne",
      "fuelfeed-uk": "Royaume-Uni",
      "cma-uk": "Royaume-Uni (CMA)",
      "directlease-benelux": "Benelux (DirectLease)",
      "anwb-benelux": "Benelux (ANWB)",
    };

    const sourceLabel =
      payload.source === "mixed"
        ? sourceList.map((src) => sourceNames[src] || src).filter(Boolean).join(" + ") || "Multi-source"
        : payload.source === "official"
        ? "France"
        : payload.source === "tankerkonig"
          ? "Allemagne"
          : payload.source === "fuelfeed-uk"
            ? "Royaume-Uni"
              : payload.source === "cma-uk"
                ? "Royaume-Uni (CMA)"
                : payload.source === "directlease-benelux"
                  ? "Benelux (DirectLease)"
                  : payload.source === "anwb-benelux"
                    ? "Benelux (ANWB)"
            : payload.source === "unavailable"
              ? "Sources indisponibles"
              : payload.source === "fallback"
                ? "France (fallback)"
                : "API fallback";

    if (liveStations.length === 0) {
      stations = [];
      renderStations();
      setLiveStatus(`${sourceLabel} · 0 station · rayon ${fetchRadiusKm} km`);
      return;
    }

    stations = liveStations;
    renderStations();

    const syncDate = payload.updatedAt ? new Date(payload.updatedAt) : new Date();
    setLiveStatus(
      `${sourceLabel} · ${stations.length} stations · rayon ${fetchRadiusKm} km · MàJ ${formatSyncTime(syncDate)}`
    );
  } catch (error) {
    if (stations.length === 0) {
      await loadLocalFallbackStations();
      renderStations();
    }
    setLiveStatus("API indisponible momentanément · affichage des dernières données");
  } finally {
    isRefreshing = false;
  }
}

function setUserLocation(lat, lon, label = "Ma position") {
  currentCenter = { lat, lon, label };
  map.setView([lat, lon], 11);

  if (userMarker) {
    map.removeLayer(userMarker);
  }

  userMarker = L.marker([lat, lon]).addTo(map).bindPopup(label);
  updateRadiusCircle();
  refreshLiveStations("géolocalisation");
}

async function searchLocation(query) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    alert("Entre une ville ou une adresse.");
    return;
  }

  setLiveStatus("Recherche de localisation...");

  try {
    const endpoint =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=fr,de,gb` +
      `&q=${encodeURIComponent(trimmedQuery)}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Geocoding error ${response.status}`);
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      alert("Aucune localisation trouvée.");
      setLiveStatus("Localisation non trouvée");
      return;
    }

    const ordered = [...results].sort((a, b) => {
      const aLat = Number(a.lat);
      const aLon = Number(a.lon);
      const bLat = Number(b.lat);
      const bLon = Number(b.lon);

      const aDist = Number.isFinite(aLat) && Number.isFinite(aLon)
        ? distanceKm(currentCenter.lat, currentCenter.lon, aLat, aLon)
        : Number.POSITIVE_INFINITY;
      const bDist = Number.isFinite(bLat) && Number.isFinite(bLon)
        ? distanceKm(currentCenter.lat, currentCenter.lon, bLat, bLon)
        : Number.POSITIVE_INFINITY;

      const aImportance = Number(a.importance) || 0;
      const bImportance = Number(b.importance) || 0;

      const scoreA = aImportance - aDist / 500;
      const scoreB = bImportance - bDist / 500;
      return scoreB - scoreA;
    });

    const top = ordered[0];
    const lat = Number(top.lat);
    const lon = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Coordonnées invalides");
    }

    setUserLocation(lat, lon, trimmedQuery);
  } catch (error) {
    alert("Impossible de rechercher cette localisation pour le moment.");
    setLiveStatus("Échec recherche localisation");
  }
}

function startLiveRefreshLoop() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
  }

  refreshIntervalId = setInterval(() => {
    refreshLiveStations("auto");
  }, LIVE_REFRESH_MS);
}

async function init() {
  createRadiusButtons();
  updateRadiusCircle();
  initFilterSections();

  fuelSelect.addEventListener("change", renderStations);
  onlyAvailableCheckbox.addEventListener("change", renderStations);
  priceMaxInput.addEventListener("input", renderStations);
  refreshBtn.addEventListener("click", () => refreshLiveStations("manuel"));
  applyRadiusBtn.addEventListener("click", () => {
    const radius = Number(customRadiusInput.value);
    if (!Number.isFinite(radius) || radius <= 0) {
      alert("Entre un rayon valide en km (ex: 35).");
      return;
    }
    setSelectedRadius(radius, "rayon personnalisé");
  });
  customRadiusInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyRadiusBtn.click();
    }
  });
  searchLocationBtn.addEventListener("click", () => searchLocation(locationInput.value));
  locationInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchLocation(locationInput.value);
    }
  });

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("La géolocalisation n'est pas disponible dans ce navigateur.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation(position.coords.latitude, position.coords.longitude);
      },
      () => {
        alert("Impossible de récupérer ta position.");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  await refreshLiveStations("initial");
  startLiveRefreshLoop();
}

init();
