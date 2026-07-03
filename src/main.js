import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue } from "firebase/database";

// --- 1. FIREBASE SETUP ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const etaDisplay = document.getElementById("eta-display");

// --- 2. MAP INITIALIZATION ---
const map = L.map('map').setView([4.3856, 100.9791], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// --- 3. THE DATA DICTIONARY ---
const stopCoords = {
  "PMMD": { lat: 4.3883576, lng: 100.9672179 },
  "An-Nur Mosque": { lat: 4.3860407, lng: 100.9738842 },
  "Main Gate": { lat: 4.3856013, lng: 100.9789672 },
  "V7": { lat: 4.383104, lng: 100.974502 }, // Corrected from V6
  "Chancellor Complex": { lat: 4.381329, lng: 100.970230 },
  "R&D": { lat: 4.3792507, lng: 100.9608721 },
  "V5": { lat: 4.3887305, lng: 100.9651686 },
  "V4": { lat: 4.3843636, lng: 100.9626794 },
  "Block L": { lat: 4.3851762, lng: 100.9709521 }
};

// The exact sequence the bus travels
const routeSequence = [
  "PMMD", "An-Nur Mosque", "Main Gate", "V7", "Chancellor Complex",
  "R&D", "V5", "V4", "PMMD", "Block L", "Chancellor Complex", "V7",
  "An-Nur Mosque", "PMMD"
];

// Draw markers for all physical stops
Object.entries(stopCoords).forEach(([name, coords]) => {
  L.marker([coords.lat, coords.lng]).addTo(map).bindPopup(`<b>${name}</b>`);
});

// Draw the full campus road route
const routeWaypoints = routeSequence.map(stop => L.latLng(stopCoords[stop].lat, stopCoords[stop].lng));
L.Routing.control({
    waypoints: routeWaypoints,
    routeWhileDragging: false,
    addWaypoints: false,
    show: false, 
    createMarker: function() { return null; }, 
    lineOptions: { styles: [{color: '#007bff', opacity: 0.6, weight: 5}] }
}).addTo(map);

// --- 4. THE GEOFENCING LOGIC ---
let busMarker = null;
let currentTargetIndex = 1; // We start at 1, looking for the 2nd stop in the loop

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

const busLocationRef = ref(db, 'bus1/location');

onValue(busLocationRef, (snapshot) => {
  const data = snapshot.val();
  
  if (data && data.lat && data.lng) {
    // 1. Move the Bus Marker
    if (busMarker === null) {
        busMarker = L.marker([data.lat, data.lng]).addTo(map);
    } else {
        busMarker.setLatLng([data.lat, data.lng]);
    }
    
    // 2. THE GEOFENCE SNAP (Self-Healing Logic)
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

    // 3. Identify Target Coordinates & Distance
    const targetStopName = routeSequence[currentTargetIndex];
    const targetCoords = stopCoords[targetStopName];
    const distanceKm = calculateDistance(data.lat, data.lng, targetCoords.lat, targetCoords.lng);
    
    // 4. Calculate ETA & Update UI
    const averageSpeedKmH = 25; 
    const timeHours = distanceKm / averageSpeedKmH;
    const timeMinutes = Math.round(timeHours * 60);
    
    if (distanceKm < 0.05 || timeMinutes < 1) {
        etaDisplay.innerText = `Arriving at ${targetStopName} Now!`;
        etaDisplay.style.color = "#28a745"; 
    } else {
        // Added a slight disclaimer so students account for campus traffic
        etaDisplay.innerText = `Next Stop: ${targetStopName} in ${timeMinutes} min (Optimal Traffic)`;
        etaDisplay.style.color = "#333";
    }

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
        views[index].style.display = 'block';
    });
});