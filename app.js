const DEFAULT_CENTER = [48.8566, 2.3522];
const RADIUS_OPTIONS = [10, 20, 30, 40, 50];
const API_BASE = "/api";
const LIVE_REFRESH_MS = 60000;
const DEFAULT_FETCH_RADIUS_KM = 50;
const MAX_FREE_MODE_RADIUS_KM = 500;
const MAX_RENDER_MARKERS = 700;
const MAX_LIST_ITEMS = 300;
const DEAL_DISTANCE_WEIGHT_EUR_PER_KM = 0.006;
const FX_API_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/gbp.json",
  "https://latest.currency-api.pages.dev/v1/currencies/gbp.json",
];
const DEFAULT_GBP_TO_EUR = 1.17;

const map = L.map("map").setView(DEFAULT_CENTER, 10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const fuelSelect = document.getElementById("fuelSelect");
const viewModeSelect = document.getElementById("viewModeSelect");
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
const stationListCount = document.getElementById("stationListCount");
const mobileSortSelect = document.getElementById("mobileSortSelect");
const liveStatus = document.getElementById("liveStatus");
const loadingProgress = document.getElementById("loadingProgress");
const loadingProgressBar = document.getElementById("loadingProgressBar");
const loadingProgressText = document.getElementById("loadingProgressText");
const sectionToggleButtons = document.querySelectorAll(".section-toggle");
const mobileGateLocateBtn = document.getElementById("mobileGateLocateBtn");
const mobileShowSearchBtn = document.getElementById("mobileShowSearchBtn");
const mobileTabFiltersBtn = document.getElementById("mobileTabFiltersBtn");
const mobileTabListBtn = document.getElementById("mobileTabListBtn");
const mobileTabMapBtn = document.getElementById("mobileTabMapBtn");
const searchSection = document.getElementById("searchSection");
const topbar = document.querySelector(".topbar");
const mobileTabs = document.querySelector(".mobile-tabs");
const mapWrap = document.querySelector(".map-wrap");
const isDedicatedMobileViewPage = window.location.pathname.endsWith("/mobile-view/mobile-view.html");

let stations = [];
let stationLayerGroup = L.layerGroup().addTo(map);
let currentCenter = { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1], label: "Centre carte" };
let userMarker = null;
let radiusCircle = null;
let selectedRadius = 20;
let viewMode = "radius";
let refreshIntervalId = null;
let isRefreshing = false;
let renderedMarkerByCoord = new Map();
let loadingToken = 0;
let loadingHideTimer = null;
let hasResolvedInitialMobileLocation = isDedicatedMobileViewPage;
let mobileTab = "filters";
let liveLoopStarted = false;
let gbpToEurRate = DEFAULT_GBP_TO_EUR;
let liveStatusToken = 0;

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

function isMobileViewport() {
  return isDedicatedMobileViewPage || window.matchMedia("(max-width: 720px)").matches;
}

function syncMobileMapLayout() {
  if (!mapWrap) {
    return;
  }

  if (!isMobileViewport() || mobileTab !== "map") {
    mapWrap.style.removeProperty("height");
    mapWrap.style.removeProperty("max-height");
    return;
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const topbarHeight = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  const tabsHeight = mobileTabs ? Math.ceil(mobileTabs.getBoundingClientRect().height) : 0;
  const verticalSpacing = 24;
  const mapHeight = Math.max(240, viewportHeight - topbarHeight - tabsHeight - verticalSpacing);

  mapWrap.style.height = `${mapHeight}px`;
  mapWrap.style.maxHeight = `${mapHeight}px`;
}

function setMobileTab(tab) {
  if (!isMobileViewport()) {
    return;
  }

  mobileTab = ["filters", "list", "map"].includes(tab) ? tab : "filters";
  document.body.classList.toggle("mobile-tab-filters", mobileTab === "filters");
  document.body.classList.toggle("mobile-tab-list", mobileTab === "list");
  document.body.classList.toggle("mobile-tab-map", mobileTab === "map");

  if (mobileTabFiltersBtn && mobileTabListBtn && mobileTabMapBtn) {
    const selected = {
      filters: mobileTab === "filters",
      list: mobileTab === "list",
      map: mobileTab === "map",
    };

    mobileTabFiltersBtn.classList.toggle("active", selected.filters);
    mobileTabFiltersBtn.setAttribute("aria-selected", String(selected.filters));
    mobileTabListBtn.classList.toggle("active", selected.list);
    mobileTabListBtn.setAttribute("aria-selected", String(selected.list));
    mobileTabMapBtn.classList.toggle("active", selected.map);
    mobileTabMapBtn.setAttribute("aria-selected", String(selected.map));
  }

  syncMobileMapLayout();

  if (mobileTab === "map") {
    map.invalidateSize();
    requestAnimationFrame(() => {
      syncMobileMapLayout();
      map.invalidateSize();
      map.setView([currentCenter.lat, currentCenter.lon], map.getZoom(), { animate: false });
    });
    setTimeout(() => {
      syncMobileMapLayout();
      map.invalidateSize();
    }, 120);
  }
}

function updateMobileOnboardingState() {
  if (!isMobileViewport()) {
    document.body.classList.remove("mobile-awaiting-location", "mobile-tab-filters", "mobile-tab-list", "mobile-tab-map");
    return;
  }

  const awaiting = !hasResolvedInitialMobileLocation;
  document.body.classList.toggle("mobile-awaiting-location", awaiting);

  if (awaiting) {
    setMobileTab("filters");
    stationListResult.innerHTML =
      '<div class="station-list-meta" data-i18n>Active la localisation ou recherche une ville pour afficher les prix proches.</div>';
    setLiveStatus("Localisation requise pour afficher les prix proches");
    if (typeof window.openOilRetranslate === "function") {
      window.openOilRetranslate();
    }
  }
}

function ensureLiveRefreshLoop() {
  if (liveLoopStarted) {
    return;
  }
  startLiveRefreshLoop();
  liveLoopStarted = true;
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

function isFreeModeEnabled() {
  return viewMode === "free";
}

function toggleRadiusControls() {
  const enabled = !isFreeModeEnabled();

  [...radiiContainer.children].forEach((button) => {
    button.disabled = !enabled;
  });

  customRadiusInput.disabled = !enabled;
  applyRadiusBtn.disabled = !enabled;

  radiiContainer.classList.toggle("is-disabled", !enabled);
  const customRadiusField = customRadiusInput.closest(".field-radius-custom");
  if (customRadiusField) {
    customRadiusField.classList.toggle("is-disabled", !enabled);
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

function formatGbp(value) {
  return `£${value.toFixed(3)}`;
}

function normalizeUkPriceToGbp(price) {
  if (!Number.isFinite(price)) {
    return NaN;
  }

  // CMA feeds are often in pence/litre, while some feeds already use GBP/litre.
  return price > 10 ? price / 100 : price;
}

function getPriceInEuro(station, fuel) {
  if (!station || !fuel || !Number.isFinite(fuel.price)) {
    return Number.NaN;
  }

  if (station.country === "GB") {
    const gbpPrice = normalizeUkPriceToGbp(fuel.price);
    if (!Number.isFinite(gbpPrice)) {
      return Number.NaN;
    }

    return gbpPrice * gbpToEurRate;
  }

  return fuel.price;
}

function formatStationPrice(station, fuel) {
  if (!station || !fuel || !Number.isFinite(fuel.price)) {
    return "-";
  }

  if (station.country === "GB") {
    const gbpPrice = normalizeUkPriceToGbp(fuel.price);
    const eurPrice = getPriceInEuro(station, fuel);
    if (!Number.isFinite(gbpPrice) || !Number.isFinite(eurPrice)) {
      return "-";
    }

    return `${formatGbp(gbpPrice)} (${formatEuro(eurPrice)})`;
  }

  return formatEuro(fuel.price);
}

async function refreshFxRate() {
  for (const endpoint of FX_API_URLS) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const rate = Number(payload?.gbp?.eur);
      if (!Number.isFinite(rate) || rate <= 0) {
        continue;
      }

      gbpToEurRate = rate;

      if (stations.length > 0) {
        renderStations();
      }
      return;
    } catch (_error) {
      // Try next endpoint.
    }
  }
}

function computeDealScore(entry) {
  // Converts distance into an equivalent price penalty for a quick "worth the detour" ranking.
  return entry.priceEur + entry.distance * DEAL_DISTANCE_WEIGHT_EUR_PER_KM;
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
      return `<li>${fuelLabels[fuelKey]}: <strong>${formatStationPrice(station, fuel)}</strong> (${state})</li>`;
    })
    .join("");

  const lastUpdate = station.lastUpdateText ? `<br />MàJ station: ${station.lastUpdateText}` : "";
  const country = station.country ? ` (${station.country})` : "";

  return `
    <div>
      <strong>${station.name}${country}</strong><br />
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
  const freeMode = isFreeModeEnabled();

  const filtered = [];
  let totalInScope = 0;

  stations.forEach((station) => {
    const distance = distanceKm(currentCenter.lat, currentCenter.lon, station.lat, station.lon);
    const inScope = freeMode || distance <= selectedRadius;
    if (inScope) totalInScope += 1;

    const fuel = station.fuels[selectedFuel];
    if (!fuel) return;
    if (!inScope) return;
    if (onlyAvailable && !fuel.available) return;
    const priceEur = getPriceInEuro(station, fuel);
    if (!Number.isFinite(priceEur)) return;
    if (hasMax && priceEur > maxPrice) return;

    filtered.push({ station, fuel, distance, priceEur });
  });

  return { filtered, totalInScope, selectedFuel, freeMode };
}

function renderStations() {
  const { filtered, totalInScope, selectedFuel, freeMode } = getFilteredStations();
  const sortedForList = [...filtered].sort((a, b) => a.priceEur - b.priceEur);
  const markerCandidates = freeMode ? sortedForList : sortedForList.slice(0, MAX_RENDER_MARKERS);

  stationLayerGroup.clearLayers();
  renderedMarkerByCoord.clear();

  markerCandidates.forEach((entry) => {
    const station = entry.station;
    const marker = L.marker([station.lat, station.lon], {
      icon: iconForStation(station, selectedFuel),
    });

    marker.bindPopup(stationPopup(station));

    stationLayerGroup.addLayer(marker);

    const markerKey = `${station.lat.toFixed(5)}:${station.lon.toFixed(5)}`;
    renderedMarkerByCoord.set(markerKey, marker);
  });

  const baseStatus = liveStatus.textContent;
  if (typeof baseStatus === "string" && baseStatus.trim().length > 0) {
    const statusPrefix = baseStatus.split(" · ")[0];
    const renderNote =
      filtered.length > markerCandidates.length
        ? ` · ${markerCandidates.length} marqueurs affichés`
        : "";
    const scopeLabel = freeMode ? "mode libre" : `rayon ${selectedRadius} km`;
    setLiveStatus(
      `${statusPrefix} · ${filtered.length}/${totalInScope} stations affichées${renderNote} · ${scopeLabel}`
    );
  }

  renderStationList(sortedForList, selectedFuel);
  renderComparison(filtered);
}

function renderStationList(filteredEntries, selectedFuel) {
  const freeMode = isFreeModeEnabled();
  const sortMode = ["price", "distance", "deal"].includes(mobileSortSelect?.value)
    ? mobileSortSelect.value
    : "price";
  const sorted = [...filteredEntries].sort((a, b) => {
    if (sortMode === "distance") {
      return a.distance - b.distance;
    }

    if (sortMode === "deal") {
      return computeDealScore(a) - computeDealScore(b);
    }

    return a.priceEur - b.priceEur;
  });

  if (stationListCount) {
    stationListCount.textContent =
      sorted.length <= 1 ? `${sorted.length} station` : `${sorted.length} stations`;
  }

  if (sorted.length === 0) {
    stationListResult.innerHTML = "Aucune station affichée avec les filtres actuels.";
    return;
  }

  const visibleEntries = freeMode ? sorted : sorted.slice(0, MAX_LIST_ITEMS);
  const items = visibleEntries
    .map((entry, index) => {
      const station = entry.station;
      const fuel = entry.fuel;
      const distance = entry.distance;
      const availability = fuel.available ? "Disponible" : "Indisponible";
      const country = station.country ? ` (${station.country})` : "";
      const stationUpdate = station.lastUpdateText || "Mise a jour inconnue";
      const badge =
        sortMode === "price"
          ? `#${index + 1}`
          : sortMode === "distance"
            ? `${distance.toFixed(1)} km`
            : `score ${computeDealScore(entry).toFixed(3)}`;
      const itemClass = index === 0 ? "station-list-item is-best" : "station-list-item";
      return `
        <div class="${itemClass}" data-lat="${station.lat}" data-lon="${station.lon}" style="cursor:pointer">
          <div class="station-list-top">
            <span class="station-rank">${badge}</span>
            <span class="station-name">${station.name}${country}</span>
            <span class="station-price">${formatStationPrice(station, fuel)}</span>
          </div>
          <div class="station-list-meta">${station.city || "Ville inconnue"} · ${distance.toFixed(1)} km · ${availability}</div>
          <div class="station-list-bottom">
            <span class="station-list-meta">MàJ: ${stationUpdate}</span>
            <button class="station-map-btn" type="button" data-lat="${station.lat}" data-lon="${station.lon}">Voir carte</button>
          </div>
        </div>
      `;
    })
    .join("");

  const truncatedNote =
    !freeMode && sorted.length > visibleEntries.length
      ? `<div class="station-list-meta">Affichage limité à ${visibleEntries.length} stations pour garder une interface fluide.</div>`
      : "";
  stationListResult.innerHTML = `${truncatedNote}${items}`;
}

function renderComparison(filteredEntries) {
  const inRange = filteredEntries
    .filter((item) => item.fuel && item.fuel.available)
    .sort((a, b) => a.fuel.price - b.fuel.price);

  if (inRange.length === 0) {
    comparisonResult.innerHTML =
      "<div class=\"comparison-empty\" data-i18n>Aucune station disponible avec les filtres actuels.</div>";
    if (typeof window.openOilRetranslate === "function") {
      window.openOilRetranslate();
    }
    return;
  }

  const prices = inRange.map((item) => item.fuel.price);
  const comparablePrices = inRange.map((item) => item.priceEur);
  const min = Math.min(...comparablePrices);
  const max = Math.max(...comparablePrices);
  const avg = comparablePrices.reduce((acc, value) => acc + value, 0) / comparablePrices.length;
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
    radiusCircle = null;
  }

  if (isFreeModeEnabled()) {
    return;
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
  if (!liveStatus) {
    return;
  }

  const sourceText = String(text || "");
  const token = ++liveStatusToken;
  liveStatus.textContent = sourceText;

  if (typeof window.openOilTranslateText !== "function") {
    return;
  }

  window.openOilTranslateText(sourceText)
    .then((translated) => {
      if (token !== liveStatusToken) {
        return;
      }

      if (typeof translated === "string" && translated.trim().length > 0) {
        liveStatus.textContent = translated;
      }
    })
    .catch(() => {
      // Keep source text on translation errors.
    });
}

function setLoadingProgress(value, text) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

  if (loadingHideTimer) {
    clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }

  if (loadingProgress) {
    loadingProgress.hidden = false;
  }

  if (loadingProgressBar) {
    loadingProgressBar.style.width = `${clamped}%`;
    const track = loadingProgressBar.parentElement;
    if (track) {
      track.setAttribute("aria-valuenow", String(clamped));
    }
  }

  if (loadingProgressText && typeof text === "string" && text.trim().length > 0) {
    loadingProgressText.textContent = `${text} (${clamped}%)`;
  }
}

function completeLoadingProgress(text = "Termine") {
  setLoadingProgress(100, text);

  loadingHideTimer = setTimeout(() => {
    if (loadingProgress) {
      loadingProgress.hidden = true;
    }
  }, 500);
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
    cacheState: payload?.cacheState || null,
  };
}

async function fetchFreeModeStationsFromBackend() {
  const endpoint = `${API_BASE}/stations/free`;
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
    cacheState: payload?.cacheState || null,
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
  loadingToken += 1;
  const currentToken = loadingToken;
  setLoadingProgress(8, `Recherche stations (${source})`);
  setLiveStatus(`Mise à jour live (${source})...`);

  try {
    const fetchRadiusKm = isFreeModeEnabled()
      ? MAX_FREE_MODE_RADIUS_KM
      : Math.max(DEFAULT_FETCH_RADIUS_KM, selectedRadius);
    if (currentToken === loadingToken) {
      setLoadingProgress(28, "Interrogation des sources carburant");
    }

    const payload = isFreeModeEnabled()
      ? await fetchFreeModeStationsFromBackend()
      : await fetchLiveStationsFromBackend(currentCenter.lat, currentCenter.lon, fetchRadiusKm);
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

    if (currentToken === loadingToken) {
      setLoadingProgress(72, "Traitement des stations");
    }

    if (liveStations.length === 0) {
      stations = [];
      renderStations();
      const scopeLabel = isFreeModeEnabled() ? "mode libre" : `rayon ${fetchRadiusKm} km`;
      setLiveStatus(`${sourceLabel} · 0 station · ${scopeLabel}`);
      if (currentToken === loadingToken) {
        completeLoadingProgress("Recherche terminee");
      }
      return;
    }

    stations = liveStations;
    if (currentToken === loadingToken) {
      setLoadingProgress(88, "Rendu de la carte");
    }
    renderStations();

    const syncDate = payload.updatedAt ? new Date(payload.updatedAt) : new Date();
    const scopeLabel = isFreeModeEnabled() ? "mode libre" : `rayon ${fetchRadiusKm} km`;
    setLiveStatus(
      `${sourceLabel} · ${stations.length} stations · ${scopeLabel} · MàJ ${formatSyncTime(syncDate)}`
    );

    if (currentToken === loadingToken) {
      completeLoadingProgress("Recherche terminee");
    }
  } catch (error) {
    if (stations.length === 0) {
      if (currentToken === loadingToken) {
        setLoadingProgress(60, "Chargement des donnees locales");
      }
      await loadLocalFallbackStations();
      renderStations();
    }
    setLiveStatus("API indisponible momentanément · affichage des dernières données");
    if (currentToken === loadingToken) {
      completeLoadingProgress("Termine avec secours local");
    }
  } finally {
    isRefreshing = false;
  }
}

function setUserLocation(lat, lon, label = "Ma position") {
  if (isMobileViewport()) {
    hasResolvedInitialMobileLocation = true;
    updateMobileOnboardingState();
    setMobileTab("list");
  }

  currentCenter = { lat, lon, label };
  map.setView([lat, lon], 11);

  // When map container was previously hidden, force a second layout pass
  // to keep the map centered on the latest user location.
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.setView([lat, lon], map.getZoom(), { animate: false });
  });

  if (userMarker) {
    map.removeLayer(userMarker);
  }

  userMarker = L.marker([lat, lon]).addTo(map).bindPopup(label);
  updateRadiusCircle();
  ensureLiveRefreshLoop();
  refreshLiveStations("géolocalisation");
}

function requestUserGeolocation() {
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
}

async function searchLocation(query) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    alert("Entre une ville ou une adresse.");
    return;
  }

  setLiveStatus("Recherche de localisation...");
  setLoadingProgress(10, "Recherche de localisation");

  try {
    const endpoint =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=fr,de,gb` +
      `&q=${encodeURIComponent(trimmedQuery)}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    setLoadingProgress(45, "Analyse de la localisation");

    if (!response.ok) {
      throw new Error(`Geocoding error ${response.status}`);
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      alert("Aucune localisation trouvée.");
      setLiveStatus("Localisation non trouvée");
      completeLoadingProgress("Aucun resultat");
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

    setLoadingProgress(65, "Localisation trouvee");
    setUserLocation(lat, lon, trimmedQuery);
  } catch (error) {
    alert("Impossible de rechercher cette localisation pour le moment.");
    setLiveStatus("Échec recherche localisation");
    completeLoadingProgress("Echec de la recherche");
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
  refreshFxRate();
  createRadiusButtons();
  if (viewModeSelect) {
    viewModeSelect.value = viewMode;
  }
  toggleRadiusControls();
  updateRadiusCircle();
  initFilterSections();
  updateMobileOnboardingState();
  if (isMobileViewport()) {
    setMobileTab(mobileTab);
  }

  window.addEventListener("resize", () => {
    if (!isMobileViewport()) {
      return;
    }

    syncMobileMapLayout();
    if (mobileTab === "map") {
      map.invalidateSize();
    }
  });

  if (mobileTabFiltersBtn && mobileTabListBtn && mobileTabMapBtn) {
    mobileTabFiltersBtn.addEventListener("click", () => setMobileTab("filters"));
    mobileTabListBtn.addEventListener("click", () => {
      if (!hasResolvedInitialMobileLocation) {
        return;
      }
      setMobileTab("list");
    });
    mobileTabMapBtn.addEventListener("click", () => {
      if (!hasResolvedInitialMobileLocation) {
        return;
      }
      setMobileTab("map");
    });
  }

  if (mobileGateLocateBtn) {
    mobileGateLocateBtn.addEventListener("click", requestUserGeolocation);
  }

  if (mobileShowSearchBtn && searchSection) {
    mobileShowSearchBtn.addEventListener("click", () => {
      searchSection.scrollIntoView({ behavior: "smooth", block: "start" });
      const input = locationInput;
      if (input) {
        input.focus();
      }
    });
  }

  fuelSelect.addEventListener("change", renderStations);
  if (mobileSortSelect) {
    mobileSortSelect.addEventListener("change", renderStations);
  }
  if (viewModeSelect) {
    viewModeSelect.addEventListener("change", () => {
      viewMode = viewModeSelect.value === "free" ? "free" : "radius";
      toggleRadiusControls();
      updateRadiusCircle();
      renderStations();
      refreshLiveStations("mode affichage");
    });
  }
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
    requestUserGeolocation();
  });

  if (isMobileViewport()) {
    setMobileTab(hasResolvedInitialMobileLocation ? "list" : "filters");
  }

  if (!isMobileViewport()) {
    await refreshLiveStations("initial");
    ensureLiveRefreshLoop();
  }
}

stationListResult.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const mapButton = target.closest(".station-map-btn");
  const stationItem = target.closest(".station-list-item");
  if (!stationItem) {
    return;
  }

  const lat = Number(stationItem.getAttribute("data-lat"));
  const lon = Number(stationItem.getAttribute("data-lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return;
  }

  if (mapButton && isMobileViewport()) {
    setMobileTab("map");
  }

  map.flyTo([lat, lon], 16, { duration: 0.8 });

  const markerKey = `${lat.toFixed(5)}:${lon.toFixed(5)}`;
  const marker = renderedMarkerByCoord.get(markerKey);
  if (marker) {
    marker.openPopup();
    return;
  }

  stationLayerGroup.eachLayer((layer) => {
    if (layer instanceof L.Marker) {
      const pos = layer.getLatLng();
      if (Math.abs(pos.lat - lat) < 0.0001 && Math.abs(pos.lng - lon) < 0.0001) {
        layer.openPopup();
      }
    }
  });
});

// Toggle mode mobile
const toggleMobileViewBtn = document.getElementById("toggleMobileViewBtn");
if (toggleMobileViewBtn) {
  toggleMobileViewBtn.addEventListener("click", () => {
    const mobilePath = "/mobile-view/mobile-view.html";
    const isAlreadyOnMobileView = window.location.pathname.endsWith(mobilePath);
    window.location.assign(isAlreadyOnMobileView ? "/index.html" : mobilePath);
  });
}

init();
