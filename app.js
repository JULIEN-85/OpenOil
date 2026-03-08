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
const priceMinInput = document.getElementById("priceMin");
const priceMaxInput = document.getElementById("priceMax");
const locateBtn = document.getElementById("locateBtn");
const refreshBtn = document.getElementById("refreshBtn");
const radiiContainer = document.getElementById("radii");
const customRadiusInput = document.getElementById("customRadiusInput");
const applyRadiusBtn = document.getElementById("applyRadiusBtn");
const comparisonResult = document.getElementById("comparisonResult");
const stationListResult = document.getElementById("stationListResult");
const liveStatus = document.getElementById("liveStatus");

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
  const minPrice = Number(priceMinInput.value);
  const maxPrice = Number(priceMaxInput.value);
  const hasMin = Number.isFinite(minPrice) && minPrice > 0;
  const hasMax = Number.isFinite(maxPrice) && maxPrice > 0;

  return stations.filter((station) => {
    const fuel = station.fuels[selectedFuel];
    const distance = distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon);
    if (!fuel) return false;
    if (distance > selectedRadius) return false;
    if (onlyAvailable && !fuel.available) return false;
    if (hasMin && fuel.price < minPrice) return false;
    if (hasMax && fuel.price > maxPrice) return false;
    return true;
  });
}

function renderStations() {
  const selectedFuel = fuelSelect.value;
  const filtered = getFilteredStations();

  stationLayerGroup.clearLayers();

  filtered.forEach((station) => {
    const marker = L.marker([station.lat, station.lon], {
      icon: iconForStation(station, selectedFuel),
    });

    marker.bindPopup(stationPopup(station));

    marker.on("click", () => {
      currentCenter = { lat: station.lat, lon: station.lon, label: station.name };
      updateRadiusCircle();
      renderStations();
    });

    stationLayerGroup.addLayer(marker);
  });

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
        <div class="station-list-item">
          <div class="station-list-top">
            <strong>${station.name}</strong>
            <strong>${formatEuro(fuel.price)}</strong>
          </div>
          <div class="station-list-meta">${station.city || "Ville inconnue"} · ${distance.toFixed(1)} km</div>
        </div>
      `;
    })
    .join("");

  stationListResult.innerHTML = items;
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
  const selectedFuel = fuelSelect.value;
  const inRange = stationsInRadius();

  if (inRange.length === 0) {
    comparisonResult.innerHTML = `Aucune station avec ${fuelLabels[selectedFuel]} disponible dans ${selectedRadius} km autour de <strong>${currentCenter.label}</strong>.`;
    return;
  }

  const prices = inRange.map((item) => item.fuel.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((acc, value) => acc + value, 0) / prices.length;
  const cheapest = inRange[0];
  const savingPerL = avg - cheapest.fuel.price;

  comparisonResult.innerHTML = `
    <strong>${inRange.length}</strong> station(s) trouvée(s) dans <strong>${selectedRadius} km</strong> autour de <strong>${currentCenter.label}</strong><br />
    Moins cher: <strong>${cheapest.station.name}</strong> (${formatEuro(cheapest.fuel.price)}) à ${cheapest.distance.toFixed(1)} km<br />
    Prix moyen: <strong>${formatEuro(avg)}</strong> · Min: <strong>${formatEuro(min)}</strong> · Max: <strong>${formatEuro(max)}</strong><br />
    Économie potentielle: <strong>${formatEuro(savingPerL)}</strong> / litre vs moyenne
  `;
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

    if (liveStations.length === 0) {
      throw new Error("Aucune station reçue");
    }

    stations = liveStations;
    renderStations();

    const syncDate = payload.updatedAt ? new Date(payload.updatedAt) : new Date();
    const sourceLabel = payload.source === "official" ? "API officielle" : "API fallback";
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
    const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(trimmedQuery)}`;
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

    const top = results[0];
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

  fuelSelect.addEventListener("change", renderStations);
  onlyAvailableCheckbox.addEventListener("change", renderStations);
  priceMinInput.addEventListener("input", renderStations);
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
