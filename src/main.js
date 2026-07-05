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

// 2. Top-Down GPS Navigation Arrow
const gpsArrowIcon = L.divIcon({
    html: `<div id="bus-arrow" style="
        width: 0; height: 0; 
        border-left: 12px solid transparent;
        border-right: 12px solid transparent;
        border-bottom: 30px solid #3b82f6; /* Blue Accent */
        filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.5));
        transition: transform 0.1s linear; /* Smooth rotation */
    "></div>`,
    className: 'clear-icon',
    iconSize: [24, 30],
    iconAnchor: [12, 15]
});

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
  }).addTo(map).bindPopup(`<b>${displayName}</b>`);

  stopMarkers[name] = marker;
});

// --- EXHIBITION: 60FPS SMOOTH ROUTING SIMULATOR ---
let simCoordinates = [];
let simActive = false;

// Build the route waypoints cleanly (No alternative coordinates)
const routeWaypoints = [];
for (let i = 0; i < routeSequence.length; i++) {
    const stopName = routeSequence[i];
    routeWaypoints.push(L.latLng(stopCoords[stopName].lat, stopCoords[stopName].lng));
}

// Default standard routing engine
const routingControl = L.Routing.control({
    waypoints: routeWaypoints,
    routeWhileDragging: false,
    addWaypoints: false,
    show: false,
    createMarker: function() { return null; },
    lineOptions: { styles: [{color: '#3b82f6', opacity: 0.6, weight: 6}] }
}).addTo(map);

routingControl.on('routesfound', function(e) {
    simCoordinates = e.routes[0].coordinates;
    if (!simActive) {
        simActive = true;
        startSmoothSimulation();
    }
});

function updateHighlightedStop() {
    Object.entries(stopMarkers).forEach(([name, marker]) => {
        const isNextStop = name === routeSequence[currentTargetIndex];
        const color = isNextStop ? '#ef4444' : '#3b82f6';

        marker.setIcon(L.divIcon({
            html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: ${color}; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
            className: 'clear-icon',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        }));
    });
}


// --- ACCUMULATED ETA CALCULATOR ---
function calculateBusEtaToStop(currentLat, currentLng, targetStopIndex) {
    const campusBusSpeedKmH = 22; 
    const boardingDelayMinutes = 0.3; 

    let totalDistanceKm = 0;
    let intermediateStops = 0;

    // 1. Distance to the VERY NEXT immediate stop
    const nextStopName = routeSequence[currentTargetIndex];
    const nextStopCoords = stopCoords[nextStopName];
    totalDistanceKm += calculateDistance(currentLat, currentLng, nextStopCoords.lat, nextStopCoords.lng);

    // 2. Loop through the sequence and accumulate distance & boarding delays
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

    // 3. Final Math: Return the EXACT decimal so we can calculate live seconds
    const drivingTimeMins = (totalDistanceKm / campusBusSpeedKmH) * 60;
    return drivingTimeMins + (intermediateStops * boardingDelayMinutes);
}

function updateEtaDisplay(targetStopName, distanceKm, isArriving = false) {
    if (!targetStopName || !Number.isFinite(distanceKm)) {
        etaDisplay.innerText = "Waiting for GPS signal...";
        etaDisplay.style.color = "#94a3b8";
        return;
    }

    const displayName = targetStopName.replace(" 2", ""); // Hide ghost stop name

    if (isArriving || distanceKm < 0.05) {
        etaDisplay.innerText = `Arriving at ${displayName} Now!`;
        etaDisplay.style.color = "#10b981";
    } else {
        let currentBusPos = simBusMarker ? simBusMarker.getLatLng() : { lat: stopCoords["PMMD"].lat, lng: stopCoords["PMMD"].lng };
        if (liveBusMarker) currentBusPos = liveBusMarker.getLatLng();

        // Convert the exact decimal into Minutes and Seconds
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, currentTargetIndex);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);
        
        etaDisplay.innerText = `Next Stop: ${displayName} in ${m}m ${s}s`;
        etaDisplay.style.color = "#94a3b8";
    }
}
function startSmoothSimulation() {
    let currentIndex = 0;
    let isPaused = false;
    
    if (!simBusMarker) {
        simBusMarker = L.marker([simCoordinates[0].lat, simCoordinates[0].lng], {icon: gpsArrowIcon}).addTo(map);
    }

    setInterval(() => {
        if (isPaused || currentIndex >= simCoordinates.length - 1) {
            if (currentIndex >= simCoordinates.length - 1) currentIndex = 0; 
            return;
        }

        const currentCoord = simCoordinates[currentIndex];
        const nextCoord = simCoordinates[currentIndex + 1];

        // 1. Rotation logic (with jitter protection)
        const pointDist = calculateDistance(currentCoord.lat, currentCoord.lng, nextCoord.lat, nextCoord.lng);
        if (pointDist > 0.00005) { 
            const dy = nextCoord.lat - currentCoord.lat;
            const dx = nextCoord.lng - currentCoord.lng;
            const angle = Math.atan2(dx, dy) * (180 / Math.PI); 
            const arrowEl = document.getElementById('bus-arrow');
            if (arrowEl) arrowEl.style.transform = `rotate(${angle}deg)`;
        }

        simBusMarker.setLatLng([nextCoord.lat, nextCoord.lng]);

        // 2. Exhibition ETA & Stop Logic (Safe Check)
        const targetStopName = routeSequence[currentTargetIndex];
        const targetCoords = stopCoords[targetStopName];
        
        if (targetCoords) {
            const distToStop = calculateDistance(nextCoord.lat, nextCoord.lng, targetCoords.lat, targetCoords.lng);

            if (distToStop < 0.05) {
                isPaused = true;
                updateEtaDisplay(targetStopName, distToStop, true);

                setTimeout(() => {
                    // Safely increment index
                    currentTargetIndex = (currentTargetIndex + 1) % routeSequence.length;
                    updateHighlightedStop();
                    isPaused = false;
                }, 3000);
            } else {
                updateEtaDisplay(targetStopName, distToStop, false);
            }
        }
        currentIndex++;
        updateHighlightedStop();
        refreshNearbyStops();    }, 1500); // 1500ms speed for exhibition
}

// --- 4. THE GEOFENCING LOGIC ---
let simBusMarker = null;
let liveBusMarker = null;
let currentTargetIndex = 1; // We start at 1, looking for the 2nd stop in the loop

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

onValue(busLocationRef, (snapshot) => {
  const data = snapshot.val();
  
  if (data && data.lat && data.lng) {
    
    // --- 1. HISTORICAL DATA LOGGER ---
    // If the data has alerts, and we haven't already logged this exact timestamp...
    if (data.alerts && data.timestamp !== lastLoggedTimestamp) {
        
        const isBraking = data.alerts.harsh_brake === true;
        const isPothole = data.alerts.pothole === true;
        const isSpeeding = data.alerts.overspeed === true;

        if (isBraking || isPothole || isSpeeding) {
            lastLoggedTimestamp = data.timestamp; // Remember this event
            
            // Push a permanent record to the Database
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

            // Pop an alert on the UI for the judges!
            let alertMsg = "";
            if (isBraking) alertMsg += "🚨 HARSH BRAKING DETECTED!\n";
            if (isPothole) alertMsg += "⚠️ POTHOLE DETECTED!\n";
            alert(alertMsg + `Time: ${data.timestamp}`);
        }
    }

    // --- 2. Move the Live Bus Marker ---
    if (liveBusMarker === null) {
        liveBusMarker = L.marker([data.lat, data.lng]).addTo(map);
    } else {
        liveBusMarker.setLatLng([data.lat, data.lng]);
    }
    
    // --- 3. THE GEOFENCE SNAP (Self-Healing Logic) ---
    // Scan all stops to see if the bus is physically at one right now
    for (let i = 0; i < routeSequence.length; i++) {
        const checkCoords = stopCoords[routeSequence[i]];
        const checkDist = calculateDistance(data.lat, data.lng, checkCoords.lat, checkCoords.lng);
        
        // If the bus is within 50 meters of stop 'i', it has arrived. 
        // Snap the target index to the NEXT stop in the sequence.
        if (checkDist < 0.05) { 
            currentTargetIndex = (i + 1) % routeSequence.length; 
            break; // We found the location, stop looping.
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
        // --- HIDE THE GHOST STOP SO IT DOESN'T SHOW UP TWICE ---
        if (name === "Chancellor Complex 2") return; 

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

    let currentBusPos = simBusMarker ? simBusMarker.getLatLng() : { lat: stopCoords["PMMD"].lat, lng: stopCoords["PMMD"].lng };
    if (liveBusMarker) currentBusPos = liveBusMarker.getLatLng();

    // 4. Inject into HTML with LIVE SECONDS
    nearbyList.innerHTML = top3Stops.map((stop) => {
        
        const targetRouteIndex = getNextBusStopIndex(stop.name);
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetRouteIndex);
        
        // Convert the decimal to Minutes and Seconds!
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