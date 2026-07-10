import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, push } from "firebase/database";

// --- 1. FIREBASE SETUP ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const etaDisplay = document.getElementById("eta-display");

// --- 2. MAP INITIALIZATION ---
const map = L.map('map', { zoomControl: false });

// --- CUSTOM ICONS ---
// 1. The Droppable Person (Pegman)
const pegmanIcon = L.divIcon({
    html: `
      <div style="position: relative; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; z-index: 1000;">
        <div class="user-marker-pulse" style="position: absolute; width: 64px; height: 64px; border-radius: 50%; background: rgba(59, 130, 246, 0.45); z-index: -1;"></div>
        <div style="font-size: 40px; filter: drop-shadow(2px 4px 4px rgba(0,0,0,0.6));">🧍‍♂️</div>
      </div>
    `,
    className: 'clear-icon',
    iconSize: [48, 48],
    iconAnchor: [24, 40],
    popupAnchor: [0, -40]
});

// 2. Top-Down GPS Navigation Arrow (Dynamic Generator)
function getGpsArrowIcon(idName, hexColor) {
    return L.divIcon({
        html: `<div id="${idName}" style="
            width: 0; height: 0; 
            border-left: 12px solid transparent;
            border-right: 12px solid transparent;
            border-bottom: 30px solid ${hexColor}; 
            filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.5));
            transition: transform 0.1s linear;
        "></div>`,
        className: 'clear-icon',
        iconSize: [24, 30],
        iconAnchor: [12, 15]
    });
}

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- 3. THE DATA DICTIONARY ---
const stopCoords = {
  "PMMD": { lat: 4.3883576, lng: 100.9672179 },
  "An-Nur Mosque": { lat: 4.3860407, lng: 100.9738842 },
  "Main Gate": { lat: 4.3856013, lng: 100.9789672 },
  "V6": { lat: 4.383104, lng: 100.974502 }, // Renamed from V7 based on the Excel schedule
  "Chancellor Complex": { lat: 4.381329, lng: 100.970230 },
  "Chancellor Complex 2": { lat: 4.3823948, lng: 100.9703333 }, // The NEW second stop
  "R&D": { lat: 4.3792507, lng: 100.9608721 },
  "V4": { lat: 4.3887305, lng: 100.9651686 },
  "V5": { lat: 4.3843636, lng: 100.9626794 },
  "Block L": { lat: 4.3851762, lng: 100.9709521 }
};

// The exact sequence from your Excel CSV
const routeSequence = [
  "PMMD", "An-Nur Mosque", "Main Gate", "V6", "Chancellor Complex",
  "R&D", "V5", "V4", "PMMD", "Block L", "Chancellor Complex 2", "V6",
  "An-Nur Mosque", "PMMD"
];

const utpBounds = L.latLngBounds(
  Object.values(stopCoords).map(({ lat, lng }) => [lat, lng])
);

function focusUtpMap() {
  map.invalidateSize();
  setTimeout(() => {
    map.fitBounds(utpBounds, { padding: [25, 25], maxZoom: 15 });
  }, 150);
}

focusUtpMap();
window.addEventListener('load', focusUtpMap);
window.addEventListener('resize', focusUtpMap);

const stopMarkers = {};

// Draw markers for all physical stops
Object.entries(stopCoords).forEach(([name, coords]) => {
  const displayName = name.replace(" 2", ""); // Hides the '2' from the judges

  const marker = L.marker([coords.lat, coords.lng], {
    icon: L.divIcon({
      html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: #3b82f6; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
      className: 'clear-icon',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    })
  }).addTo(map);

// THE FIX: Calculate live ETA when the stop is clicked!
  marker.on('click', () => {
      if (!liveBusMarker) return; // Wait for Firebase to load the bus
      let currentBusPos = liveBusMarker.getLatLng();
      
      const targetRouteIndex = getNextBusStopIndex(name);
      const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetRouteIndex);
      const m = Math.floor(rawMins);
      const s = Math.floor((rawMins - m) * 60);
      
      marker.bindPopup(`
        <div style="text-align:center; font-family: system-ui, sans-serif;">
            <b style="font-size:14px; color:#1e293b;">${displayName}</b><br>
            <div style="margin-top:4px; font-size:13px; color:#3b82f6; font-weight:bold; background:#eff6ff; padding:4px 8px; border-radius:6px; border: 1px solid #bfdbfe;">
                Bus ETA: ${m}m ${s}s
            </div>
        </div>
      `).openPopup();
  });
});

// --- 4. THE GEOFENCING LOGIC ---
let simBusMarker = null;
let liveBusMarker = null;
let currentTargetIndex = 1; // We start at 1, looking for the 2nd stop in the loop

function updateHighlightedStop() {
    Object.entries(stopMarkers).forEach(([name, marker]) => {
        const isNextStop = name === routeSequence[currentTargetIndex];
        const color = isNextStop ? '#ef4444' : '#3b82f6'; // Red for next stop, blue for others

        marker.setIcon(L.divIcon({
            html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: ${color}; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
            className: 'clear-icon',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        }));
    });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

let lastLoggedTimestamp = "";

const busLocationRef = ref(db, 'bus1/location');

// --- FIREBASE LIVE LISTENER ---
const busLocationRef = ref(db, 'bus1/location');
let lastLoggedTimestamp = "";
let currentTargetIndex = 1; // Start looking for the 2nd stop

// --- ACCUMULATED ETA CALCULATOR ---
function calculateBusEtaToStop(currentLat, currentLng, targetStopIndex) {
    const campusBusSpeedKmH = 22; 
    const boardingDelayMinutes = 0.3; 
    let totalDistanceKm = 0;
    let intermediateStops = 0;

    const nextStopName = routeSequence[currentTargetIndex];
    const nextStopCoords = stopCoords[nextStopName];
    totalDistanceKm += calculateDistance(currentLat, currentLng, nextStopCoords.lat, nextStopCoords.lng);

    let scanIndex = currentTargetIndex;
    while (scanIndex !== targetStopIndex) {
        let currentLegName = routeSequence[scanIndex];
        let nextLegIndex = (scanIndex + 1) % routeSequence.length;
        let nextLegName = routeSequence[nextLegIndex];
        totalDistanceKm += calculateDistance(
            stopCoords[currentLegName].lat, stopCoords[currentLegName].lng,
            stopCoords[nextLegName].lat, stopCoords[nextLegName].lng
        );
        intermediateStops++; 
        scanIndex = nextLegIndex;
    }
    const drivingTimeMins = (totalDistanceKm / campusBusSpeedKmH) * 60;
    return drivingTimeMins + (intermediateStops * boardingDelayMinutes);
}

function updateEtaDisplay(targetStopName, distanceKm, isArriving = false) {
    if (!targetStopName || !Number.isFinite(distanceKm)) {
        etaDisplay.innerText = "Waiting for GPS signal...";
        etaDisplay.style.color = "#94a3b8";
        return;
    }
    const displayName = targetStopName.replace(" 2", ""); 
    if (isArriving || distanceKm < 0.08) { 
        etaDisplay.innerText = `Arriving at ${displayName} Now!`;
        etaDisplay.style.color = "#10b981";
    } else {
        if (!liveBusMarker) return;
        let currentBusPos = liveBusMarker.getLatLng();
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, currentTargetIndex);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);
        etaDisplay.innerText = `Next Stop: ${displayName} in ${m}m ${s}s`;
        etaDisplay.style.color = "#94a3b8";
    }
}

onValue(busLocationRef, (snapshot) => {
  const data = snapshot.val();
  
  if (data && data.lat && data.lng) {
    
    // --- 1. HISTORICAL DATA LOGGER ---
    if (data.alerts && data.timestamp !== lastLoggedTimestamp) {
        const isBraking = data.alerts.harsh_brake === true;
        const isPothole = data.alerts.pothole === true;
        const isSpeeding = data.alerts.overspeed === true;

        if (isBraking || isPothole || isSpeeding) {
            lastLoggedTimestamp = data.timestamp; 
            const logsRef = ref(db, 'bus1/event_logs');
            push(logsRef, {
                time: data.timestamp,
                lat: data.lat,
                lng: data.lng,
                speed_kmh: data.speed,
                harsh_brake: isBraking,
                pothole_hit: isPothole,
                speeding: isSpeeding
            });

            let alertMsg = "";
            if (isBraking) alertMsg += "🚨 HARSH BRAKING DETECTED!\n";
            if (isPothole) alertMsg += "⚠️ POTHOLE DETECTED!\n";
            alert(alertMsg + `Time: ${data.timestamp}`);
        }
    }

    // --- 2. Move the Live Bus Marker ---
    if (liveBusMarker === null) {
        liveBusMarker = L.marker([data.lat, data.lng], { icon: getGpsArrowIcon('live-bus-arrow', '#10b981') })
            .on('click', () => openLiveSchedulePanel('campus'))
            .addTo(map); 
    } else {
        liveBusMarker.setLatLng([data.lat, data.lng]);
    }
    
    // --- 3. THE GEOFENCE SNAP (Self-Healing Logic) ---
    for (let i = 0; i < routeSequence.length; i++) {
        const checkCoords = stopCoords[routeSequence[i]];
        const checkDist = calculateDistance(data.lat, data.lng, checkCoords.lat, checkCoords.lng);
        
        if (checkDist < 0.05) { 
            currentTargetIndex = (i + 1) % routeSequence.length; 
            updateHighlightedStop(); 
            break; 
        }
    }

    // --- 4. Identify Target Coordinates & Distance ---
    const targetStopName = routeSequence[currentTargetIndex];
    const targetCoords = stopCoords[targetStopName];
    const distanceKm = calculateDistance(data.lat, data.lng, targetCoords.lat, targetCoords.lng);

    // --- 5. Calculate ETA & Update UI ---
    updateEtaDisplay(targetStopName, distanceKm, distanceKm < 0.05);
    refreshNearbyStops();

  } else {
    etaDisplay.innerText = "Bus Offline";
    etaDisplay.style.color = "#dc3545"; 
  }
});

// Navigation Logic
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

navItems.forEach((item, index) => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        
        // 1. Remove 'active' class from all, add to clicked
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        
        // 2. Hide all views, show the one matching the index
        views.forEach(view => view.style.display = 'none');
        views[index].style.display = 'flex'; // Changed from 'block' to 'flex'
        
        // 3. THE LEAFLET FIX: Force the map to redraw if the Map tab (index 0) is clicked
        if (index === 0) {
            focusUtpMap();
        }
    });
});

// --- 5. NEARBY STOPS LOGIC (HYBRID: USER DISTANCE, BUS ETA) ---
let currentLocation = { lat: 4.3856013, lng: 100.9789672 }; // Main Gate default

// HELPER: Finds the bus's NEXT encounter with a specific stop
function getNextBusStopIndex(stopName) {
    for (let i = 0; i < routeSequence.length; i++) {
        // Start checking from where the bus is currently heading
        let checkIndex = (currentTargetIndex + i) % routeSequence.length;
        if (routeSequence[checkIndex] === stopName) {
            return checkIndex;
        }
    }
    return 0; // Fallback
}

function refreshNearbyStops() {
    const nearbyList = document.getElementById("nearby-stops-list"); 
    if (!nearbyList) return;

    let allStops = [];

    // 1. Calculate true geometric distance from PEGMAN to EVERY stop
    Object.entries(stopCoords).forEach(([name, coords]) => {
        if (name === "Chancellor Complex 2") return; // Hide ghost stop

        const distKm = calculateDistance(currentLocation.lat, currentLocation.lng, coords.lat, coords.lng);
        allStops.push({ 
            name: name, 
            distanceKm: distKm,
            distMeters: Math.round(distKm * 1000)
        });
    });

    // 2. SORT the array by distance to the user (closest first)
    allStops.sort((a, b) => a.distanceKm - b.distanceKm);

    // 3. Slice the top 3 nearest physical stops to the user
    const top3Stops = allStops.slice(0, 3);
    const now = new Date();

    // THE NEW WAY:
    if (!liveBusMarker) return; 
    let currentBusPos = liveBusMarker.getLatLng();

    // 4. Inject into HTML with LIVE SECONDS
    nearbyList.innerHTML = top3Stops.map((stop) => {
        
        const targetRouteIndex = getNextBusStopIndex(stop.name);
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetRouteIndex);
        
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);

        const etaTime = new Date(now.getTime() + rawMins * 60000);
        const etaLabel = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const displayName = stop.name.replace(" 2", "");

        return `
            <div class="ui-card nearby-stop-card">
              <div class="icon-circle">📍</div>
              <div class="nearby-stop-info">
                <h4>${displayName}</h4>
                <p>${stop.distMeters} meters from you</p>
              </div>
              <div class="nearby-stop-time">
                <div style="font-weight: bold;">Bus in: ${m}m ${s}s</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Arrives ${etaLabel}</div>
              </div>
            </div>
        `;
    }).join("");
}

// --- EXHIBITION DEMO: DRAGGABLE USER LOCATION ---
const userMarker = L.marker([currentLocation.lat, currentLocation.lng], { 
    draggable: true, 
    icon: pegmanIcon 
}).addTo(map);

userMarker.bindPopup("<b>Exhibition Mode</b><br>Drag me to find the nearest stop!").openPopup();

userMarker.on('dragend', function (event) {
    const userPos = event.target.getLatLng();
    currentLocation = { lat: userPos.lat, lng: userPos.lng };
    refreshNearbyStops();
});

refreshNearbyStops();

// --- LIVE CLOCK ---
function updateTime() {
    const now = new Date();
    // Formats time as HH:MM (e.g., 14:30)
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const liveTimeEl = document.getElementById('live-time');
    if (liveTimeEl) liveTimeEl.innerText = timeString;
}
setInterval(updateTime, 1000);
updateTime(); // Run immediately on load

// --- CUSTOM RECENTER BUTTON ---
const recenterBtn = document.createElement('div');
recenterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="6"></circle><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4" y1="12" x2="2" y2="12"></line><line x1="22" y1="12" x2="18" y2="12"></line></svg>`;

Object.assign(recenterBtn.style, {
    position: 'absolute',
    right: '15px',
    bottom: '15px', // CHANGED FROM 100px: Drops it perfectly into the corner!
    width: '42px',
    height: '42px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '12px',
    backgroundColor: '#1e293b', 
    color: '#3b82f6',          
    boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
    border: '1px solid rgba(255,255,255,0.1)',
    zIndex: '9999'
});

// Make it clickable
recenterBtn.onclick = () => map.flyTo([currentLocation.lat, currentLocation.lng], 16, { animate: true, duration: 1.5 });

// Append it directly to the map wrapper so it stays in bounds
const mapWrapper = document.querySelector('.map-wrapper');
if (mapWrapper) mapWrapper.appendChild(recenterBtn);

// --- LIVE ROUTE SIDE PANEL (STATEFUL FOR MULTIPLE BUSES) ---
const panelStyle = document.createElement('style');
panelStyle.innerHTML = `
    #bus-side-panel {
        position: fixed; top: 0; right: -380px; width: 350px; height: 100vh;
        background: #0f172a; box-shadow: -4px 0 25px rgba(0,0,0,0.5);
        z-index: 99999; transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex; flex-direction: column; font-family: system-ui, sans-serif; color: #f8fafc;
    }
    #bus-side-panel.open { right: 0; }
    .panel-header { background: #1e293b; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
    .panel-header h2 { margin: 0; font-size: 18px; display: flex; align-items: baseline; gap: 8px; }
    .bus-plate { font-size: 13px; color: #94a3b8; font-weight: 500; }
    .close-btn { background: rgba(255,255,255,0.1); border: none; color: white; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-weight: bold; }
    .bus-details-bar { background: #162032; padding: 12px 20px; border-bottom: 1px solid #334155; font-size: 13px; color: #94a3b8; display: flex; flex-direction: column; gap: 6px; }
    .detail-row { display: flex; justify-content: space-between; align-items: center; }
    .route-badge { padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; border: 1px solid; }
    .panel-content { flex: 1; overflow-y: auto; padding: 15px 20px; }
    .route-stop-item { display: flex; align-items: center; padding: 14px 0; border-bottom: 1px solid #1e293b; }
    .stop-dot { width: 14px; height: 14px; border-radius: 50%; background: #475569; margin-right: 15px; border: 3px solid #0f172a; box-shadow: 0 0 0 2px #475569; }
    .stop-dot.next-stop { background: #f87171; box-shadow: 0 0 0 2px #f87171; }
    .stop-info { flex: 1; }
    .stop-name { font-weight: 600; font-size: 14.5px; color: #f1f5f9; }
    .stop-eta { font-size: 13px; color: #94a3b8; margin-top: 3px; }
    .stop-time-badge { background: #1e293b; border: 1px solid #334155; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; color: #60a5fa; }
`;
document.head.appendChild(panelStyle);

const panelHtml = `
    <div id="bus-side-panel">
        <div class="panel-header">
            <h2 id="panel-bus-title">🚌 Shuttle 1 <span class="bus-plate">ALM 4021</span></h2>
            <button class="close-btn" id="close-panel-btn">✕</button>
        </div>
        <div class="bus-details-bar">
            <div class="detail-row">
                <span>Driver: <strong style="color:white;" id="panel-driver-name">Ahmad F.</strong></span>
                <span>⭐ <strong style="color:white;">4.9</strong></span>
            </div>
            <div class="detail-row" style="margin-top: 2px;">
                <span style="display:flex; align-items:center; gap:6px;">
                    Route: <strong id="panel-route-badge" style="font-size:13px; letter-spacing:0.5px;">WITHIN UTP CAMPUS</strong>
                </span>
            </div>
        </div>
        <div class="panel-content" id="panel-stop-list"></div>
    </div>
`;
document.body.insertAdjacentHTML('beforeend', panelHtml);

const sidePanel = document.getElementById('bus-side-panel');
const panelStopList = document.getElementById('panel-stop-list');
let panelUpdateInterval = null;
let currentPanelBusType = 'campus'; // Tracks which bus we are viewing

document.getElementById('close-panel-btn').addEventListener('click', () => sidePanel.classList.remove('open'));
map.on('click', () => sidePanel.classList.remove('open'));

function updatePanelData() {
    if (!liveBusMarker) return; 
    let currentBusPos = liveBusMarker.getLatLng();

    const isCampus = currentPanelBusType === 'campus';
    const now = new Date();

    // 1. DYNAMIC HEADER INFO
    document.getElementById('panel-bus-title').innerHTML = isCampus ? '🚌 Shuttle 1 <span class="bus-plate">ALM 4021</span>' : '🚌 Shuttle 2 <span class="bus-plate">VAF 9091</span>';
    document.getElementById('panel-driver-name').innerText = isCampus ? 'Ahmad F.' : 'Kamal R.';
    
    const badge = document.getElementById('panel-route-badge');
    badge.innerText = isCampus ? 'WITHIN UTP CAMPUS' : 'SERI ISKANDAR';
    badge.style.color = isCampus ? '#60a5fa' : '#f59e0b';
    
    // Clear the old box styling out
    badge.style.backgroundColor = 'transparent';
    badge.style.border = 'none';
    badge.style.padding = '0';

    // 2. LIST GENERATOR
    let listHTML = "";
    for (let i = 0; i < routeSequence.length; i++) {
        const checkIndex = (currentTargetIndex + i) % routeSequence.length;
        const stopName = routeSequence[checkIndex];
        
        if (stopName === "Chancellor Complex 2") continue; 

        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, checkIndex);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);
        
        const etaTime = new Date(now.getTime() + rawMins * 60000);
        const etaLabel = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const displayName = stopName.replace(" 2", "");
        const isNextStop = (i === 0);
        const dotClass = (isNextStop && isCampus) ? "stop-dot next-stop" : "stop-dot";

        // THE FIX: Hide ETAs for Seri Iskandar bus
        const nameDisplay = (isNextStop && isCampus) 
            ? `${displayName} <span style="background:rgba(239, 68, 68, 0.2); color:#f87171; border: 1px solid rgba(239,68,68,0.3); font-size:10px; padding:2px 6px; border-radius:4px; margin-left:8px; font-weight:bold;">HEADING HERE</span>` 
            : displayName;
            
        let etaText = `ETA: ${m}m ${s}s`;
        if (isNextStop && isCampus) etaText = `<span style="color:#f87171; font-weight:600;">Arriving in: ${m}m ${s}s</span>`;
        if (!isCampus) etaText = `<span style="color:#94a3b8;">Status: Standby</span>`;

        const timeBadge = isCampus ? etaLabel : '--:--';

        listHTML += `
            <div class="route-stop-item">
                <div class="${dotClass}"></div>
                <div class="stop-info">
                    <div class="stop-name">${nameDisplay}</div>
                    <div class="stop-eta">${etaText}</div>
                </div>
                <div class="stop-time-badge" style="${!isCampus ? 'color:#475569; border-color:#1e293b;' : ''}">${timeBadge}</div>
            </div>
        `;
    }
    panelStopList.innerHTML = listHTML;
}

// Added the parameter requirement here!
function openLiveSchedulePanel(busType) {
    currentPanelBusType = busType;
    sidePanel.classList.add('open');
    updatePanelData(); 
    
    if (panelUpdateInterval) clearInterval(panelUpdateInterval);
    if (busType === 'campus') { // Only live-tick the seconds if it's the moving bus!
        panelUpdateInterval = setInterval(() => {
            if (sidePanel.classList.contains('open')) updatePanelData();
            else clearInterval(panelUpdateInterval); 
        }, 1000);
    }
}

// --- STATIONARY SERI ISKANDAR BUS ---
// 1. Create a distinct Amber/Orange icon for the off-campus bus
const stationaryBusIcon = L.divIcon({
    html: `<div style="
        width: 34px; height: 34px; 
        background: #f59e0b; /* Amber background */
        border: 2px solid white; 
        border-radius: 50%; 
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 8px rgba(0,0,0,0.4);
        font-size: 18px;
    ">🚌</div>`,
    className: 'clear-icon',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20]
});

// 2. Place the marker and bind a styled popup
const seriIskandarBus = L.marker([4.365577, 100.9803029], { 
    icon: getGpsArrowIcon('seri-bus-arrow', '#f59e0b') // <--- FIXED THIS (Now Amber!)
})
    .addTo(map)
    .on('click', () => openLiveSchedulePanel('seri'));