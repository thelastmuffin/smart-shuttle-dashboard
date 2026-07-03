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
        <div class="user-marker-pulse" style="position: absolute; width: 24px; height: 24px; border-radius: 50%; background: rgba(59, 130, 246, 0.35);"></div>
        <div style="font-size: 45px; filter: drop-shadow(2px 4px 4px rgba(0,0,0,0.6));">🧍‍♂️</div>
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
  "V7": { lat: 4.383104, lng: 100.974502 },
  "Chancellor Complex": { lat: 4.381329, lng: 100.970230 },
  "R&D": { lat: 4.3792507, lng: 100.9608721 },
  "V4": { lat: 4.3887305, lng: 100.9651686 },
  "V5": { lat: 4.3843636, lng: 100.9626794 },
  "Block L": { lat: 4.3851762, lng: 100.9709521 }
};

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

// The exact sequence the bus travels
const routeSequence = [
  "PMMD", "An-Nur Mosque", "Main Gate", "V7", "Chancellor Complex",
  "R&D", "V5", "V4", "PMMD", "Block L", "Chancellor Complex", "V7",
  "An-Nur Mosque", "PMMD"
];

const stopMarkers = {};

// Draw markers for all physical stops
Object.entries(stopCoords).forEach(([name, coords]) => {
  const marker = L.marker([coords.lat, coords.lng], {
    icon: L.divIcon({
      html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: #3b82f6; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
      className: 'clear-icon',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    })
  }).addTo(map).bindPopup(`<b>${name}</b>`);

  stopMarkers[name] = marker;
});

// --- EXHIBITION: 60FPS SMOOTH ROUTING SIMULATOR ---
let simCoordinates = [];
let simActive = false;

const routeWaypoints = routeSequence.map(stop => L.latLng(stopCoords[stop].lat, stopCoords[stop].lng));

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

function updateEtaDisplay(targetStopName, distanceKm, isArriving = false) {
    if (!targetStopName || !Number.isFinite(distanceKm)) {
        etaDisplay.innerText = "Waiting for GPS signal...";
        etaDisplay.style.color = "#94a3b8";
        return;
    }

    if (isArriving || distanceKm < 0.02) {
        etaDisplay.innerText = `Arriving at ${targetStopName} Now!`;
        etaDisplay.style.color = "#10b981";
    } else {
        const timeMinutes = Math.max(1, Math.round((distanceKm / 25) * 60));
        etaDisplay.innerText = `Next Stop: ${targetStopName} in ${timeMinutes} min`;
        etaDisplay.style.color = "#94a3b8";
    }
}

function startSmoothSimulation() {
    let currentIndex = 0;
    let isPaused = false;
    
    // Spawn the bus with the top-down GPS arrow
    if (!simBusMarker) {
        simBusMarker = L.marker([simCoordinates[0].lat, simCoordinates[0].lng], {icon: gpsArrowIcon}).addTo(map);
    }

    // Animation Loop (Runs every 40 milliseconds for smooth movement)
    // Animation Loop (Changed from 40ms to 120ms to slow the bus down)
    setInterval(() => {
        if (isPaused || currentIndex >= simCoordinates.length - 1) {
            if (currentIndex >= simCoordinates.length - 1) currentIndex = 0; 
            return;
        }

        const currentCoord = simCoordinates[currentIndex];
        const nextCoord = simCoordinates[currentIndex + 1];

        // 1. Calculate Heading/Rotation (WITH ANTI-JITTER)
        const pointDist = calculateDistance(currentCoord.lat, currentCoord.lng, nextCoord.lat, nextCoord.lng);
        
        // Only calculate a new rotation if the points are far enough apart
        if (pointDist > 0.00005) { 
            const dy = nextCoord.lat - currentCoord.lat;
            const dx = nextCoord.lng - currentCoord.lng;
            const angle = Math.atan2(dx, dy) * (180 / Math.PI); 
            const arrowEl = document.getElementById('bus-arrow');
            if (arrowEl) arrowEl.style.transform = `rotate(${angle}deg)`;
        }

        // 2. Move Bus
        simBusMarker.setLatLng([nextCoord.lat, nextCoord.lng]);

        // 3. Exhibition ETA & Stop Logic
        const targetStopName = routeSequence[currentTargetIndex];
        const targetCoords = stopCoords[targetStopName];
        const distToStop = calculateDistance(nextCoord.lat, nextCoord.lng, targetCoords.lat, targetCoords.lng);

        if (distToStop < 0.02) {
            isPaused = true;
            updateEtaDisplay(targetStopName, distToStop, true);

            setTimeout(() => {
                currentTargetIndex = (currentTargetIndex + 1) % routeSequence.length;
                updateHighlightedStop();
                isPaused = false;
            }, 3000);
        } else {
            updateEtaDisplay(targetStopName, distToStop, false);
        }

        currentIndex++;
        updateHighlightedStop();
        refreshNearbyStops();
    }, 500);
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

function getReferencePosition() {
    if (simBusMarker) {
        const busPos = simBusMarker.getLatLng();
        return { lat: busPos.lat, lng: busPos.lng };
    }

    if (liveBusMarker) {
        const busPos = liveBusMarker.getLatLng();
        return { lat: busPos.lat, lng: busPos.lng };
    }

    return currentLocation;
}

function updateNearbyStopInfo(lat, lng, mode = "distance") {
    const averageSpeedKmH = 25;
    const nearbyList = document.getElementById("nearby-stops-list");

    if (!nearbyList) return;

    const stopNames = mode === "bus"
        ? [...new Set(routeSequence.slice(currentTargetIndex).concat(routeSequence.slice(0, currentTargetIndex)))]
        : Object.keys(stopCoords);

    const stopEntries = stopNames
        .map((name) => {
            const coords = stopCoords[name];
            if (!coords) return null;

            const distToStop = calculateDistance(lat, lng, coords.lat, coords.lng);
            const distMeters = Math.round(distToStop * 1000);
            const directMinutes = Math.max(1, Math.round((distToStop / averageSpeedKmH) * 60));

            return {
                name,
                distMeters,
                timeMinutes: directMinutes
            };
        })
        .filter(Boolean)
        .slice(0, 3);

    const now = new Date();

    nearbyList.innerHTML = stopEntries.map(({ name, distMeters, timeMinutes }) => {
        const etaTime = new Date(now.getTime() + timeMinutes * 60000);
        const etaLabel = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const etaText = mode === "bus"
            ? `Arrive ${etaLabel}`
            : `${etaLabel}`;

        return `
            <div class="ui-card nearby-stop-card">
              <div class="icon-circle">📍</div>
              <div class="nearby-stop-info">
                <h4>${name}</h4>
                <p>${distMeters} meters away</p>
              </div>
              <div class="nearby-stop-time">
                <div>${etaText}</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${timeMinutes} min</div>
              </div>
            </div>
        `;
    }).join("");
}

let currentLocation = { lat: 4.3856013, lng: 100.9789672 };

function refreshNearbyStops() {
    const reference = getReferencePosition();
    updateNearbyStopInfo(reference.lat, reference.lng, "bus");
}

// --- EXHIBITION DEMO: DRAGGABLE USER LOCATION ---
// Places a blue pin at the Main Gate by default
// Replace your current userMarker definition with this:
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
    document.getElementById('live-time').innerText = timeString;
}
setInterval(updateTime, 1000);
updateTime(); // Run immediately on load