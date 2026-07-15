import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, push, get} from "firebase/database";

// ==========================================
// 1. FIREBASE SETUP
// ==========================================
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const etaDisplay = document.getElementById("eta-display");

// ==========================================
// 2. GLOBAL STATE VARIABLES
// ==========================================
let simActive = true; 
let liveBusMarker = null;
let currentBusAngle = 0;
let currentTargetIndex = 1; 

let seriBusMarker = null;      
let currentSeriAngle = 0;      
let seriTargetIndex = 0;       

let lastLoggedTimestamp = "";
let currentLocation = { lat: 4.3856013, lng: 100.9789672 }; 
let panelUpdateInterval = null;
let currentPanelBusType = 'campus';
let mapTrackingMode = 'campus'; 

// Teleportation Trackers
let campusInitialized = false;
let seriInitialized = false;
let lastCampusPos = null;
let lastSeriPos = null;

// ETA Anti-Bounce Memory
let lastCampusTargetIndex = -1;
let campusEtaMemory = {};
let lastSeriTargetIndex = -1;
let seriEtaMemory = {};

// ==========================================
// 3. MAP & ICON INITIALIZATION
// ==========================================
const map = L.map('map', { zoomControl: false });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

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

// ==========================================
// 4. THE DATA DICTIONARY
// ==========================================
const stopCoords = {
  // Campus Stops
  "PMMD": { lat: 4.388208, lng: 100.9679694 },
  "An-Nur Mosque": { lat: 4.3860407, lng: 100.9738842 },
  "Main Gate": { lat: 4.3856013, lng: 100.9789672 },
  "V7": { lat: 4.3832394, lng: 100.9747654 },
  "Chancellor Complex": { lat: 4.381329, lng: 100.970230 },
  "Chancellor Complex 2": { lat: 4.3823948, lng: 100.9703333 },
  "R&D": { lat: 4.3792507, lng: 100.9608721 },
  "V4": { lat: 4.3887305, lng: 100.9651686 },
  "V5": { lat: 4.3843636, lng: 100.9626794 },
  "Block L": { lat: 4.3851762, lng: 100.9709521 },
  
  // Seri Iskandar Town Stops
  "Pump Station, Tronoh": { lat: 4.41934, lng: 100.9904023 },
  "Lotus Bandar U": { lat: 4.3653742, lng: 100.9800968 },
  "Bandar Universiti": { lat: 4.3644669, lng: 100.9793297 },
  "Seri Iskandar Terminal": { lat: 4.3628764, lng: 100.9761312 },
  "SIBC @ Billion SI": { lat: 4.3549557, lng: 100.9693651 }, 
  "Apartment Seri Iskandar": { lat: 4.365308, lng: 100.9625477 },
  "Iskandar Prima SOHO": { lat: 4.3620317, lng: 100.9704162 },
  "IFS SOHO Apartment": { lat: 4.3733473, lng: 100.9794385 }
};

const routeSequence = [
  "PMMD", "An-Nur Mosque", "Main Gate", "V7", "Chancellor Complex",
  "R&D", "V5", "V4", "PMMD", "Block L", "Chancellor Complex 2", "V7",
  "An-Nur Mosque", "PMMD"
];

const seriRouteSequence = [
  "PMMD", "Main Gate", "Pump Station, Tronoh", "Lotus Bandar U", 
  "Bandar Universiti", "Seri Iskandar Terminal", "SIBC @ Billion SI", 
  "Apartment Seri Iskandar", "Iskandar Prima SOHO", "IFS SOHO Apartment", 
  "Main Gate", "Block L", "Chancellor Complex", "R&D", "V4", "V5", "PMMD" 
];

const utpBounds = L.latLngBounds(Object.values(stopCoords).map(({ lat, lng }) => [lat, lng]));

function focusUtpMap() {
  map.invalidateSize();
  setTimeout(() => map.fitBounds(utpBounds, { padding: [25, 25], maxZoom: 15 }), 150);
}
focusUtpMap();
window.addEventListener('load', focusUtpMap);
window.addEventListener('resize', focusUtpMap);

// ==========================================
// 5. HELPER FUNCTIONS (MATH & ETA)
// ==========================================
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

function getNextBusStopIndex(stopName, seqArray = routeSequence) {
    const startIndex = (seqArray === routeSequence) ? currentTargetIndex : seriTargetIndex;
    for (let i = 0; i < seqArray.length; i++) {
        let checkIndex = (startIndex + i) % seqArray.length;
        if (seqArray[checkIndex] === stopName) return checkIndex;
    }
    return 0; 
}

function calculateBusEtaToStop(currentLat, currentLng, targetStopIndex, seqArray = routeSequence) {
    const isCampus = (seqArray === routeSequence);
    const activeTargetIndex = isCampus ? currentTargetIndex : seriTargetIndex;

    // 1. Reset memory cache if the bus has advanced to a new stop
    if (isCampus && activeTargetIndex !== lastCampusTargetIndex) {
        campusEtaMemory = {};
        lastCampusTargetIndex = activeTargetIndex;
    } else if (!isCampus && activeTargetIndex !== lastSeriTargetIndex) {
        seriEtaMemory = {};
        lastSeriTargetIndex = activeTargetIndex;
    }

    const campusBusSpeedKmH = 22; 
    const boardingDelayMinutes = 0.3; 
    let totalDistanceKm = 0;
    let intermediateStops = 0;

    const nextStopName = seqArray[activeTargetIndex];
    const nextStopCoords = stopCoords[nextStopName];
    
    if(!nextStopCoords) return 0;
    
    totalDistanceKm += calculateDistance(currentLat, currentLng, nextStopCoords.lat, nextStopCoords.lng);

    let scanIndex = activeTargetIndex;
    let maxLoops = seqArray.length + 2; 

    while (scanIndex !== targetStopIndex && maxLoops > 0) {
        let currentLegName = seqArray[scanIndex];
        let nextLegIndex = (scanIndex + 1) % seqArray.length;
        let nextLegName = seqArray[nextLegIndex];
        totalDistanceKm += calculateDistance(
            stopCoords[currentLegName].lat, stopCoords[currentLegName].lng,
            stopCoords[nextLegName].lat, stopCoords[nextLegName].lng
        );
        intermediateStops++; 
        scanIndex = nextLegIndex;
        maxLoops--;
    }
    
    // 2. Calculate the Raw ETA
    const drivingTimeMins = (totalDistanceKm / campusBusSpeedKmH) * 60;
    const rawMins = drivingTimeMins + (intermediateStops * boardingDelayMinutes);

    // ==========================================
    // 3. SEAMLESS EPOCH TRACKING
    // Instead of locking the "Minutes Remaining" (which freezes the UI),
    // we lock the exact clock time the bus is expected to arrive.
    // ==========================================
    const memoryCache = isCampus ? campusEtaMemory : seriEtaMemory;
    const now = Date.now();
    const calculatedArrivalEpoch = now + (rawMins * 60000); // Current time + ETA in milliseconds

    // If we haven't tracked this stop yet, OR the newly calculated arrival time is SOONER, update memory!
    if (memoryCache[targetStopIndex] === undefined || calculatedArrivalEpoch < memoryCache[targetStopIndex]) {
        memoryCache[targetStopIndex] = calculatedArrivalEpoch;
    } 
    // Failsafe: If the arrival time gets pushed back by > 1.5 minutes, accept the delay
    else if (calculatedArrivalEpoch > memoryCache[targetStopIndex] + 90000) {
        memoryCache[targetStopIndex] = calculatedArrivalEpoch;
    }

    // 4. Return the smoothly draining seconds!
    const remainingMins = (memoryCache[targetStopIndex] - now) / 60000;
    return Math.max(0, remainingMins); // Never let it drop below 0
}

function updateEtaDisplay(targetStopName, distanceKm, isArriving = false, busType = 'campus') {
    if (busType !== mapTrackingMode) return;

    if (!targetStopName || !Number.isFinite(distanceKm)) {
        etaDisplay.innerText = "Waiting for GPS signal...";
        etaDisplay.style.color = "#94a3b8";
        return;
    }
    
    const displayName = targetStopName.replace(" 2", ""); 
    
    if (isArriving || distanceKm < 0.08) { 
        etaDisplay.innerText = `Arriving at ${displayName} Now!`;
        etaDisplay.style.color = (busType === 'campus') ? "#10b981" : "#f59e0b"; 
    } else {
        if (busType === 'campus' && !liveBusMarker) return;
        if (busType === 'seri' && !seriBusMarker) return;

        let currentBusPos = (busType === 'campus') ? liveBusMarker.getLatLng() : seriBusMarker.getLatLng();
        const seqArray = (busType === 'campus') ? routeSequence : seriRouteSequence;
        const targetIndex = (busType === 'campus') ? currentTargetIndex : seriTargetIndex;

        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetIndex, seqArray);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);
        
        etaDisplay.innerText = `Next Stop: ${displayName} in ${m}m ${s}s`;
        etaDisplay.style.color = "#94a3b8";
    }
}

function updateHighlightedStop() {
    Object.entries(stopMarkers).forEach(([name, marker]) => {
        const isNextStop = name === routeSequence[currentTargetIndex];
        const color = isNextStop ? '#ef4444' : '#3b82f6';
        
        if (!routeSequence.includes(name)) return;
        
        marker.setIcon(L.divIcon({
            html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: ${color}; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
            className: 'clear-icon',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        }));
    });
}

function checkTeleport(lastPos, currentPos) {
    if (!lastPos) return true; 
    if (calculateDistance(lastPos.lat, lastPos.lng, currentPos.lat, currentPos.lng) > 1.0) {
        return true; 
    }
    return false;
}

function advanceTargetIndex(lat, lng, currentIndex, sequence) {
    const targetName = sequence[currentIndex];
    const targetCoords = stopCoords[targetName];
    if (!targetCoords) return currentIndex;

    const dist = calculateDistance(lat, lng, targetCoords.lat, targetCoords.lng);
    if (dist < 0.05) { 
        return (currentIndex + 1) % sequence.length;
    }
    return currentIndex;
}

// ==========================================
// 6. POPULATE MAP STOPS
// ==========================================
const stopMarkers = {};
const dynamicPopup = L.popup(); // ONE unified popup fixes the open/close glitch!

Object.entries(stopCoords).forEach(([name, coords]) => {
  const displayName = name.replace(" 2", ""); 
  const isSeriStop = !routeSequence.includes(name);
  const markerColor = isSeriStop ? '#f59e0b' : '#3b82f6';

  const marker = L.marker([coords.lat, coords.lng], {
    icon: L.divIcon({
      html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: ${markerColor}; border: 2px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.35);"></div>`,
      className: 'clear-icon',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    })
  }).addTo(map);

  marker.on('click', (e) => {
      let activeType = mapTrackingMode;
      const isCampusOnly = !seriRouteSequence.includes(name);
      if (isCampusOnly) activeType = 'campus';
      if (isSeriStop) activeType = 'seri';

      const activeMarker = activeType === 'seri' ? seriBusMarker : liveBusMarker;
      const seqArray = activeType === 'seri' ? seriRouteSequence : routeSequence;
      
      if (!activeMarker) {
          dynamicPopup.setLatLng(e.latlng).setContent(`
            <div style="text-align:center; font-family: system-ui, sans-serif;">
                <b style="font-size:14px; color:#1e293b;">${displayName}</b><br>
                <div style="margin-top:4px; font-size:13px; color:#ef4444; font-weight:bold; background:#fef2f2; padding:4px 8px; border-radius:6px; border: 1px solid #fca5a5;">
                    Bus Offline
                </div>
            </div>
          `).openOn(map);
          return; 
      }
      
      let currentBusPos = activeMarker.getLatLng();
      const targetRouteIndex = getNextBusStopIndex(name, seqArray);
      const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetRouteIndex, seqArray);
      
      const m = Math.floor(rawMins);
      const s = Math.floor((rawMins - m) * 60);
      
      dynamicPopup.setLatLng(e.latlng).setContent(`
        <div style="text-align:center; font-family: system-ui, sans-serif;">
            <b style="font-size:14px; color:#1e293b;">${displayName}</b><br>
            <div style="margin-top:4px; font-size:13px; color:${markerColor}; font-weight:bold; background:#eff6ff; padding:4px 8px; border-radius:6px; border: 1px solid #bfdbfe;">
                Bus ETA: ${m}m ${s}s
            </div>
        </div>
      `).openOn(map);
  });
  stopMarkers[name] = marker;
});

// ==========================================
// 7. NEW: LIVE ROUTES TAB UI LOGIC
// ==========================================
function renderLiveTimeline(containerId, sequence, currentIndex) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let html = "";
    sequence.forEach((stop, index) => {
        let className = "";
        let status = "Upcoming";
        
        if (index < currentIndex) {
            className = "passed";
            status = "Passed";
        } else if (index === currentIndex) {
            className = "active";
            status = "Next Stop";
        }

        html += `
            <div class="timeline-item ${className}">
                <h4>${stop.replace(" 2", "")}</h4>
                <span>${status}</span>
            </div>
        `;
    });
    container.innerHTML = html;
}

function updateLiveRoutesPanel() {
    renderLiveTimeline('live-timeline-u1', routeSequence, currentTargetIndex);
    renderLiveTimeline('live-timeline-u2', seriRouteSequence, seriTargetIndex);
}
// Init the panel
updateLiveRoutesPanel();

// ==========================================
// 8. FIREBASE LIVE LISTENER (DUAL MODE)
// ==========================================

function processFirebaseData(data) {
  if (data && data.lat && data.lng) {
    
    if (data.alerts && data.timestamp !== lastLoggedTimestamp) {
        const isBraking = data.alerts.harsh_brake === true;
        const isPothole = data.alerts.pothole === true;
        const isSpeeding = data.alerts.overspeed === true;

        if (isBraking || isPothole || isSpeeding) {
            lastLoggedTimestamp = data.timestamp; 
            const logsRef = ref(db, 'bus1/event_logs');
            push(logsRef, {
                time: data.timestamp, lat: data.lat, lng: data.lng,
                speed_kmh: data.speed, harsh_brake: isBraking,
                pothole_hit: isPothole, speeding: isSpeeding
            });

            let alertMsg = "";
            if (isBraking) alertMsg += "🚨 HARSH BRAKING DETECTED!\n";
            if (isPothole) alertMsg += "⚠️ POTHOLE DETECTED!\n";
            alert(alertMsg + `Time: ${data.timestamp}`);
        }
    }

    if (liveBusMarker === null) {
        const busImage = L.divIcon({
            html: `
              <div style="width: 60px; height: 60px; display: flex; align-items: center; justify-content: center;">
                <img id="live-bus-img" src="/bus-blue.png" style="width: 50px; height: auto; transform: rotate(0deg); transition: transform 0.6s linear; filter: drop-shadow(2px 5px 4px rgba(0,0,0,0.4));">
              </div>
            `,
            className: 'clear-icon',
            iconSize: [60, 60],
            iconAnchor: [30, 30], 
            popupAnchor: [0, -30]
        });

        liveBusMarker = L.marker([data.lat, data.lng], { icon: busImage })
            .on('click', () => openLiveSchedulePanel('campus'))
            .addTo(map); 

    } else {
        const oldPos = liveBusMarker.getLatLng();
        const dx = data.lng - oldPos.lng;
        const dy = data.lat - oldPos.lat;

        if (Math.abs(dx) > 0.00001 || Math.abs(dy) > 0.00001) {
            const targetAngle = -Math.atan2(dy, dx) * (180 / Math.PI);
            let angleDiff = targetAngle - (currentBusAngle % 360);
            if (angleDiff > 180) angleDiff -= 360;
            if (angleDiff < -180) angleDiff += 360;

            currentBusAngle += angleDiff;

            const busImgElement = document.getElementById('live-bus-img');
            if (busImgElement) {
                busImgElement.style.transform = `rotate(${currentBusAngle}deg)`;
            }
        }
        liveBusMarker.setLatLng([data.lat, data.lng]);
    }
    
    // --- TELEPORT RECOVERY & GEOFENCE (CAMPUS) ---
    if (checkTeleport(lastCampusPos, {lat: data.lat, lng: data.lng})) {
        campusInitialized = false; 
    }
    lastCampusPos = {lat: data.lat, lng: data.lng};

    if (!campusInitialized) {
        let closestIndex = 0;
        let minDist = 999;
        
        for(let i=0; i<routeSequence.length; i++) {
            let d = calculateDistance(data.lat, data.lng, stopCoords[routeSequence[i]].lat, stopCoords[routeSequence[i]].lng);
            if (d < 0.05) {
                closestIndex = i;
                break; 
            }
            if (d < minDist) {
                minDist = d;
                closestIndex = i;
            }
        }
        currentTargetIndex = (closestIndex + 1) % routeSequence.length;
        campusInitialized = true;
        updateHighlightedStop();
    } else {
        const newTarget = advanceTargetIndex(data.lat, data.lng, currentTargetIndex, routeSequence);
        if (newTarget !== currentTargetIndex) {
            currentTargetIndex = newTarget;
            updateHighlightedStop();
        }
    }

    const targetStopName = routeSequence[currentTargetIndex];
    const targetCoords = stopCoords[targetStopName];
    const distanceKm = calculateDistance(data.lat, data.lng, targetCoords.lat, targetCoords.lng);

    updateEtaDisplay(targetStopName, distanceKm, distanceKm < 0.05, 'campus'); 
    refreshNearbyStops();
    updateLiveRoutesPanel(); 

  } else {
    etaDisplay.innerText = "Bus Offline";
    etaDisplay.style.color = "#dc3545"; 
  }
}

// ==========================================
// 8.5 SERI ISKANDAR BUS PROCESSING
// ==========================================
function processSeriFirebaseData(data) {
  if (data && data.lat && data.lng) {
      if (seriBusMarker === null) {
          const seriBusImage = L.divIcon({
              html: `
                <div style="width: 60px; height: 60px; display: flex; align-items: center; justify-content: center;">
                  <img id="seri-bus-img" src="/bus-yellow.png" style="width: 50px; height: auto; transform: rotate(0deg); transition: transform 0.6s linear; filter: drop-shadow(2px 5px 4px rgba(0,0,0,0.4));">
                </div>
              `,
              className: 'clear-icon',
              iconSize: [60, 60],
              iconAnchor: [30, 30],
              popupAnchor: [0, -30]
          });

          seriBusMarker = L.marker([data.lat, data.lng], { icon: seriBusImage })
              .on('click', () => openLiveSchedulePanel('seri'))
              .addTo(map);

      } else {
          const oldPos = seriBusMarker.getLatLng();
          const dx = data.lng - oldPos.lng;
          const dy = data.lat - oldPos.lat;

          if (Math.abs(dx) > 0.00001 || Math.abs(dy) > 0.00001) {
              const targetAngle = -Math.atan2(dy, dx) * (180 / Math.PI);
              let angleDiff = targetAngle - (currentSeriAngle % 360);
              if (angleDiff > 180) angleDiff -= 360;
              if (angleDiff < -180) angleDiff += 360;

              currentSeriAngle += angleDiff;

              const busImgElement = document.getElementById('seri-bus-img');
              if (busImgElement) {
                  busImgElement.style.transform = `rotate(${currentSeriAngle}deg)`;
              }
          }
          seriBusMarker.setLatLng([data.lat, data.lng]);
      }

      // --- TELEPORT RECOVERY & GEOFENCE (SERI) ---
      if (checkTeleport(lastSeriPos, {lat: data.lat, lng: data.lng})) {
          seriInitialized = false; 
      }
      lastSeriPos = {lat: data.lat, lng: data.lng};

      if (!seriInitialized) {
          let closestIndex = 0;
          let minDist = 999;
          
          for(let i=0; i<seriRouteSequence.length; i++) {
              let d = calculateDistance(data.lat, data.lng, stopCoords[seriRouteSequence[i]].lat, stopCoords[seriRouteSequence[i]].lng);
              if (d < 0.05) {
                  closestIndex = i;
                  break; 
              }
              if (d < minDist) {
                  minDist = d;
                  closestIndex = i;
              }
          }
          seriTargetIndex = (closestIndex + 1) % seriRouteSequence.length;
          seriInitialized = true;
      } else {
          seriTargetIndex = advanceTargetIndex(data.lat, data.lng, seriTargetIndex, seriRouteSequence);
      }

      const targetStopName = seriRouteSequence[seriTargetIndex];
      const targetCoords = stopCoords[targetStopName];
      if (targetCoords) {
          const distanceKm = calculateDistance(data.lat, data.lng, targetCoords.lat, targetCoords.lng);
          updateEtaDisplay(targetStopName, distanceKm, distanceKm < 0.05, 'seri');
      }
      refreshNearbyStops();

      updateLiveRoutesPanel(); 
  }
}

// THE GATEKEEPERS (DUAL-BUS LISTENERS)
const liveBusRef = ref(db, 'bus1/location');
onValue(liveBusRef, (snapshot) => {
    if (!simActive) processFirebaseData(snapshot.val());
});

const demoBusRef = ref(db, 'bus_demo/location');
onValue(demoBusRef, (snapshot) => {
    if (simActive) processFirebaseData(snapshot.val());
});

const liveBus2Ref = ref(db, 'bus2/location');
onValue(liveBus2Ref, (snapshot) => {
    if (!simActive) processSeriFirebaseData(snapshot.val());
});

const demoBus2Ref = ref(db, 'bus2_demo/location');
onValue(demoBus2Ref, (snapshot) => {
    if (simActive) processSeriFirebaseData(snapshot.val());
});

// ==========================================
// 9. NAVIGATION, UI, & NEARBY STOPS
// ==========================================
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

navItems.forEach((item, index) => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        
        views.forEach(view => view.style.display = 'none');
        views[index].style.display = 'block'; 
        
        if (index === 0) {
            setTimeout(() => {
                map.invalidateSize();
            }, 50);
        }
    });
});

function refreshNearbyStops() {
    const nearbyList = document.getElementById("nearby-stops-list"); 
    if (!nearbyList) return;

    let allStops = [];
    Object.entries(stopCoords).forEach(([name, coords]) => {
        if (name === "Chancellor Complex 2") return; 

        const isSeriStop = !routeSequence.includes(name);
        if (mapTrackingMode === 'campus' && isSeriStop) return;
        if (mapTrackingMode === 'seri' && !seriRouteSequence.includes(name)) return;

        const distKm = calculateDistance(currentLocation.lat, currentLocation.lng, coords.lat, coords.lng);
        allStops.push({ 
            name: name, 
            distanceKm: distKm,
            distMeters: Math.round(distKm * 1000)
        });
    });

    allStops.sort((a, b) => a.distanceKm - b.distanceKm);
    const top3Stops = allStops.slice(0, 3);
    const now = new Date();

    const activeMarker = mapTrackingMode === 'campus' ? liveBusMarker : seriBusMarker;
    const seqArray = mapTrackingMode === 'campus' ? routeSequence : seriRouteSequence;

    if (!activeMarker) {
        nearbyList.innerHTML = `<div style="text-align:center; padding: 15px; color:#94a3b8;">Waiting for GPS signal...</div>`;
        return;
    }

    let currentBusPos = activeMarker.getLatLng();

    nearbyList.innerHTML = top3Stops.map((stop) => {
        const targetRouteIndex = getNextBusStopIndex(stop.name, seqArray);
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, targetRouteIndex, seqArray);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);

        const etaTime = new Date(now.getTime() + rawMins * 60000);
        const etaLabel = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const displayName = stop.name.replace(" 2", "");
        
        const timerColor = mapTrackingMode === 'campus' ? '#3b82f6' : '#f59e0b';

        return `
            <div class="ui-card nearby-stop-card">
              <div class="icon-circle">📍</div>
              <div class="nearby-stop-info">
                <h4>${displayName}</h4>
                <p>${stop.distMeters} meters from you</p>
              </div>
              <div class="nearby-stop-time">
                <div style="font-weight: bold; color: ${timerColor};">Bus in: ${m}m ${s}s</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Arrives ${etaLabel}</div>
              </div>
            </div>
        `;
    }).join("");
}

const userMarker = L.marker([currentLocation.lat, currentLocation.lng], { 
    draggable: true, icon: pegmanIcon 
}).addTo(map);

userMarker.bindPopup("<b>Exhibition Mode</b><br>Drag me to find the nearest stop!").openPopup();
userMarker.on('dragend', function (event) {
    const userPos = event.target.getLatLng();
    currentLocation = { lat: userPos.lat, lng: userPos.lng };
    refreshNearbyStops();
});

refreshNearbyStops();

function updateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const liveTimeEl = document.getElementById('live-time');
    if (liveTimeEl) liveTimeEl.innerText = timeString;
}
setInterval(updateTime, 1000);
updateTime(); 

const recenterBtn = document.createElement('div');
recenterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="6"></circle><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4" y1="12" x2="2" y2="12"></line><line x1="22" y1="12" x2="18" y2="12"></line></svg>`;

Object.assign(recenterBtn.style, {
    position: 'absolute', right: '15px', bottom: '15px', width: '42px', height: '42px',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '12px', backgroundColor: '#1e293b', color: '#3b82f6',          
    boxShadow: '0 4px 15px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', zIndex: '9999'
});

recenterBtn.onclick = () => map.flyTo([currentLocation.lat, currentLocation.lng], 16, { animate: true, duration: 1.5 });
const mapWrapper = document.querySelector('.map-wrapper');
if (mapWrapper) mapWrapper.appendChild(recenterBtn);


// ==========================================
// 10. SIDE PANEL (SCHEDULE UI)
// ==========================================
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

document.getElementById('close-panel-btn').addEventListener('click', () => sidePanel.classList.remove('open'));
map.on('click', () => sidePanel.classList.remove('open'));

function updatePanelData() {
    const isCampus = currentPanelBusType === 'campus';
    const activeMarker = isCampus ? liveBusMarker : seriBusMarker;

    if (!activeMarker) return; 
    let currentBusPos = activeMarker.getLatLng();

    const activeSequence = isCampus ? routeSequence : seriRouteSequence;
    const activeIndex = isCampus ? currentTargetIndex : seriTargetIndex;
    
    const now = new Date();

    document.getElementById('panel-bus-title').innerHTML = isCampus ? '🚌 Shuttle 1 <span class="bus-plate">ALM 4021</span>' : '🚌 Shuttle 2 <span class="bus-plate">VAF 9091</span>';
    document.getElementById('panel-driver-name').innerText = isCampus ? 'Ahmad F.' : 'Kamal R.';
    
    const badge = document.getElementById('panel-route-badge');
    badge.innerText = isCampus ? 'WITHIN UTP CAMPUS' : 'SERI ISKANDAR';
    badge.style.color = isCampus ? '#60a5fa' : '#f59e0b';
    badge.style.backgroundColor = 'transparent';
    badge.style.border = 'none';
    badge.style.padding = '0';

    let listHTML = "";
    for (let i = 0; i < activeSequence.length; i++) {
        const checkIndex = (activeIndex + i) % activeSequence.length;
        const stopName = activeSequence[checkIndex];
        
        const rawMins = calculateBusEtaToStop(currentBusPos.lat, currentBusPos.lng, checkIndex, activeSequence);
        const m = Math.floor(rawMins);
        const s = Math.floor((rawMins - m) * 60);
        
        const etaTime = new Date(now.getTime() + rawMins * 60000);
        const etaLabel = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const displayName = stopName.replace(" 2", "");
        const isNextStop = (i === 0);
        
        const activeColor = isCampus ? '#f87171' : '#f59e0b';
        const dotClass = isNextStop ? "stop-dot next-stop" : "stop-dot";
        const dotStyle = (isNextStop && !isCampus) ? `background: ${activeColor}; box-shadow: 0 0 0 2px ${activeColor};` : "";

        const nameDisplay = isNextStop 
            ? `${displayName} <span style="background:${isCampus ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)'}; color:${activeColor}; border: 1px solid ${isCampus ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}; font-size:10px; padding:2px 6px; border-radius:4px; margin-left:8px; font-weight:bold;">HEADING HERE</span>` 
            : displayName;
            
        let etaText = `ETA: ${m}m ${s}s`;
        if (isNextStop) etaText = `<span style="color:${activeColor}; font-weight:600;">Arriving in: ${m}m ${s}s</span>`;

        listHTML += `
            <div class="route-stop-item">
                <div class="${dotClass}" style="${dotStyle}"></div>
                <div class="stop-info">
                    <div class="stop-name">${nameDisplay}</div>
                    <div class="stop-eta">${etaText}</div>
                </div>
                <div class="stop-time-badge">${etaLabel}</div>
            </div>
        `;
    }
    panelStopList.innerHTML = listHTML;
}

function openLiveSchedulePanel(busType) {
    currentPanelBusType = busType;
    sidePanel.classList.add('open');
    updatePanelData(); 
    
    if (panelUpdateInterval) clearInterval(panelUpdateInterval);
    
    panelUpdateInterval = setInterval(() => {
        if (sidePanel.classList.contains('open')) updatePanelData();
        else clearInterval(panelUpdateInterval); 
    }, 1000);
}

// ==========================================
// MAP ROUTE SELECTOR LOGIC
// ==========================================
const btnTrackCampus = document.getElementById('btn-track-campus');
const btnTrackSeri = document.getElementById('btn-track-seri');

function refreshMapTrackingUI() {
    if (mapTrackingMode === 'campus') {
        if (liveBusMarker) {
            const targetStopName = routeSequence[currentTargetIndex];
            const distanceKm = calculateDistance(liveBusMarker.getLatLng().lat, liveBusMarker.getLatLng().lng, stopCoords[targetStopName].lat, stopCoords[targetStopName].lng);
            updateEtaDisplay(targetStopName, distanceKm, distanceKm < 0.05, 'campus');
        } else {
            etaDisplay.innerText = "U1 Campus Bus Offline";
            etaDisplay.style.color = "#dc3545";
        }
    } else {
        if (seriBusMarker) {
            const targetStopName = seriRouteSequence[seriTargetIndex];
            const distanceKm = calculateDistance(seriBusMarker.getLatLng().lat, seriBusMarker.getLatLng().lng, stopCoords[targetStopName].lat, stopCoords[targetStopName].lng);
            updateEtaDisplay(targetStopName, distanceKm, distanceKm < 0.05, 'seri');
        } else {
            etaDisplay.innerText = "U2 Seri Iskandar Bus Offline";
            etaDisplay.style.color = "#dc3545";
        }
    }
    refreshNearbyStops(); 
}

if (btnTrackCampus && btnTrackSeri) {
    btnTrackCampus.addEventListener('click', () => {
        mapTrackingMode = 'campus';
        btnTrackCampus.classList.add('active');
        btnTrackSeri.classList.remove('active');
        refreshMapTrackingUI();
    });

    btnTrackSeri.addEventListener('click', () => {
        mapTrackingMode = 'seri';
        btnTrackSeri.classList.add('active');
        btnTrackCampus.classList.remove('active');
        refreshMapTrackingUI();
    });
}

// --- SETTINGS TOGGLE SWITCH LOGIC ---
const toggleSlider = document.getElementById('toggle-slider');
const toggleKnob = document.getElementById('toggle-knob');
const modeLabel = document.getElementById('mode-label');

if (toggleSlider && toggleKnob && modeLabel) {
    toggleSlider.addEventListener('click', () => {
        simActive = !simActive; 
        
        if (simActive) {
            modeLabel.innerText = "Demo Mode";
            modeLabel.style.color = "#3b82f6";
            toggleSlider.style.backgroundColor = "#3b82f6";
            toggleKnob.style.transform = "translateX(0)";
        } else {
            modeLabel.innerText = "Live Mode";
            modeLabel.style.color = "#ef4444"; 
            toggleSlider.style.backgroundColor = "#ef4444";
            toggleKnob.style.transform = "translateX(20px)"; 
        }
        
        if (liveBusMarker) {
            map.removeLayer(liveBusMarker);
            liveBusMarker = null; 
        }
        if (seriBusMarker) {
            map.removeLayer(seriBusMarker);
            seriBusMarker = null; 
        }

        const targetPath = simActive ? 'bus_demo/location' : 'bus1/location';
        get(ref(db, targetPath)).then((snapshot) => {
            if (snapshot.exists()) {
                processFirebaseData(snapshot.val()); 
            } else {
                etaDisplay.innerText = "Bus Offline";
                etaDisplay.style.color = "#dc3545"; 
            }
        });
        
        const targetPath2 = simActive ? 'bus2_demo/location' : 'bus2/location';
        get(ref(db, targetPath2)).then((snapshot) => {
            if (snapshot.exists()) processSeriFirebaseData(snapshot.val());
        });
    });
}

// ==========================================
// SCHEDULE DROPDOWN LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const dropdowns = document.querySelectorAll('.trip-dropdown');
    dropdowns.forEach(dropdown => {
        dropdown.addEventListener('change', function() {
            const routeClass = this.getAttribute('data-route-class');
            document.querySelectorAll('.' + routeClass).forEach(el => el.style.display = 'none');
            document.getElementById(this.value).style.display = 'block';
        });
    });
});