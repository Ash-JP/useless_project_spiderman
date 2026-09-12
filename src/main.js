import './style.css';

// DOM Elements
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('gameCanvas');
const canvasCtx = canvasElement.getContext('2d');
const loadingOverlay = document.getElementById('loadingOverlay');
const calibrationOverlay = document.getElementById('calibrationOverlay');
const hud = document.getElementById('hud');
const scoreElement = document.getElementById('score');

// Game State
let isCalibrating = true;
let calibrationStep = 0;
let score = 0;
let lives = 10;
let isGameOver = false;
let combo = 1;
let level = 1;
let lastHitTime = 0;
let lastSpawnTime = 0;
let lastFrameTime = performance.now();
let isMuted = false;
let shakeAmount = 0;

const livesElement = document.getElementById('lives');
const comboElement = document.getElementById('combo');
const startMenu = document.getElementById('startMenu');
const startBtn = document.getElementById('startBtn');
const muteBtn = document.getElementById('muteBtn');

// Coordinate Mapping
let minX = Infinity, maxX = -Infinity;
let minY = Infinity, maxY = -Infinity;

// Screen Dimensions
let screenW = window.innerWidth;
let screenH = window.innerHeight;

// Game Entities
const targets = [];
const particles = [];
let webLines = [];
let webDecals = [];
let textDecals = [];
let targetHandPos = { x: screenW / 2, y: screenH / 2 };

canvasElement.width = screenW;
canvasElement.height = screenH;

window.addEventListener('resize', () => {
  screenW = window.innerWidth;
  screenH = window.innerHeight;
  canvasElement.width = screenW;
  canvasElement.height = screenH;
});

// Load Villains (Fallback colors if images fail to load)
const villainImages = [];
const villainSources = [
  'https://cdn-icons-png.flaticon.com/512/11513/11513074.png', // Generic alien/venom placeholder
  'https://cdn-icons-png.flaticon.com/512/11513/11513083.png',
  'https://cdn-icons-png.flaticon.com/512/11513/11513054.png'
];

villainSources.forEach(src => {
  const img = new Image();
  img.src = src;
  villainImages.push(img);
});

// Gesture Detection Logic
let previousExtendedFingers = 4;
let gestureCooldown = 0;

// Returns true if a sudden change in finger shape/count is detected
function isWebShooterGesture(landmarks) {
  if (!landmarks || landmarks.length < 21) return false;

  const getDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wrist = landmarks[0];
  
  // A finger is considered extended if its tip is further from the wrist than its PIP joint
  // Index: tip 8, pip 6
  // Middle: tip 12, pip 10
  // Ring: tip 16, pip 14
  // Pinky: tip 20, pip 18
  
  let extendedFingers = 0;
  if (getDist(landmarks[8], wrist) > getDist(landmarks[6], wrist)) extendedFingers++;
  if (getDist(landmarks[12], wrist) > getDist(landmarks[10], wrist)) extendedFingers++;
  if (getDist(landmarks[16], wrist) > getDist(landmarks[14], wrist)) extendedFingers++;
  if (getDist(landmarks[20], wrist) > getDist(landmarks[18], wrist)) extendedFingers++;

  let isShot = false;
  
  // Detect a sudden change in the number of extended fingers (e.g. closing or opening hand rapidly)
  // We check if the count changes by at least 2 to avoid accidental single-finger twitches
  if (Math.abs(extendedFingers - previousExtendedFingers) >= 2) {
    const now = Date.now();
    // Use an internal cooldown so it doesn't double-trigger on the way down and up instantly
    if (now - gestureCooldown > 400) {
       isShot = true;
       gestureCooldown = now;
    }
  }

  // Smooth the previous fingers count slightly so it doesn't get stuck on a flicker, 
  // but for rapid changes, just assigning it works fine.
  previousExtendedFingers = extendedFingers;
  
  return isShot;
}

// Audio System Setup
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const bgm = new Audio('https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3');
bgm.loop = true;
bgm.volume = 0.3;

function playSound(type) {
  if (isMuted || audioCtx.state !== 'running') return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  const now = audioCtx.currentTime;
  if (type === 'thwip') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  } else if (type === 'hit') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.2);
    gain.gain.setValueAtTime(0.8, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.2);
  } else if (type === 'miss') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.3);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  }
}

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  muteBtn.innerText = isMuted ? '🔇' : '🔊';
  if (isMuted) bgm.pause();
  else if (startMenu.classList.contains('hidden') && !isGameOver) bgm.play();
});

startBtn.addEventListener('click', () => {
  startMenu.classList.add('hidden');
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (!isMuted) bgm.play();
});

// MediaPipe Setup
const hands = new Hands({
  locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
  }
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});

let lastShotTime = 0;
let currentHandPos = { x: screenW / 2, y: screenH / 2 };

hands.onResults((results) => {
  // Hide loading screen on first result
  if (!loadingOverlay.classList.contains('hidden')) {
    loadingOverlay.classList.add('hidden');
    document.getElementById('target-0').classList.add('active');
  }

  // Draw loop handles clearing and drawing everything, 
  // but we update state here based on hand position.
  
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    
    // Landmark 0 is wrist, 9 is middle finger base (good center point)
    // The video is mirrored, so we mirror X
    const rawX = 1 - landmarks[9].x; 
    const rawY = landmarks[9].y;
    
    // Update mapping extremes during calibration
    if (isCalibrating) {
      // Just track the raw position, crosshair will move 1:1 with screen initially to help them aim at targets
      targetHandPos.x = rawX * screenW;
      targetHandPos.y = rawY * screenH;
    } else {
      // Apply mapped coordinates
      // Add a small buffer so they don't have to reach the exact extremes
      const mapX = (rawX - minX) / (maxX - minX);
      const mapY = (rawY - minY) / (maxY - minY);
      
      targetHandPos.x = Math.max(0, Math.min(screenW, mapX * screenW));
      targetHandPos.y = Math.max(0, Math.min(screenH, mapY * screenH));
    }
    
    // Detect gesture
    if (isWebShooterGesture(landmarks)) {
      const now = Date.now();
      if (now - lastShotTime > 500) { // 500ms cooldown
        fireWeb(currentHandPos.x, currentHandPos.y, rawX, rawY);
        lastShotTime = now;
      }
    }
  }
});

const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({image: videoElement});
  },
  width: 1280,
  height: 720
});
camera.start();

// Game Logic
function fireWeb(screenX, screenY, rawX, rawY) {
  if (isGameOver) return;
  if (isCalibrating) {
    // Record calibration extreme
    if (rawX < minX) minX = rawX;
    if (rawX > maxX) maxX = rawX;
    if (rawY < minY) minY = rawY;
    if (rawY > maxY) maxY = rawY;
    
    // Deactivate current, activate next
    document.getElementById(`target-${calibrationStep}`).classList.remove('active');
    calibrationStep++;
    
    // Visual web effect for calibration
    addWebLine(screenW/2, screenH, screenX, screenY);
    
    if (calibrationStep < 4) {
      document.getElementById(`target-${calibrationStep}`).classList.add('active');
    } else {
      finishCalibration();
    }
    return;
  }
  
  // Aim Assist Logic: Snap to target if close enough
  let closestTarget = null;
  let minDistance = Infinity;
  for (const t of targets) {
     const dist = Math.hypot(t.x - screenX, t.y - screenY);
     if (dist < minDistance) {
         minDistance = dist;
         closestTarget = t;
     }
  }

  // Snap threshold is 150px
  if (closestTarget && minDistance < 150) {
      screenX = closestTarget.x;
      screenY = closestTarget.y;
  }

  // Visual web and sound effect
  playSound('thwip');
  addWebLine(screenW / 2, screenH, screenX, screenY);
  
  let hit = false;
  // Check collisions
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    // Slightly more forgiving bounding box since we have aim assist snapping exactly
    if (screenX > t.x - t.size && screenX < t.x + t.size &&
        screenY > t.y - t.size && screenY < t.y + t.size) {
      
      // Hit!
      playSound('hit');
      shakeAmount = 15; // Screen shake
      createExplosion(t.x, t.y);
      addTextDecal(t.x, t.y, 'hit');
      targets.splice(i, 1);
      
      // Combo logic
      const now = Date.now();
      if (now - lastHitTime < 2000 && !isCalibrating) {
        combo++;
      } else {
        combo = 1;
      }
      lastHitTime = now;
      if (comboElement) comboElement.innerText = combo;

      score += 10 * combo;
      scoreElement.innerText = score;
      
      // Level up logic
      if (score >= level * 150) {
          level++;
          // Show big LEVEL UP text decal
          textDecals.push({
            x: screenW/2, y: screenH/2, text: `LEVEL ${level}`, color: '#00ff00',
            life: 2.0, vy: -1.0, size: 80, rotation: 0
          });
      }
      
      hit = true;
      break; // Only hit one target per shot
    }
  }
  
  if (!hit && !isCalibrating) {
    playSound('miss');
    addTextDecal(screenX, screenY, 'miss');
    combo = 1;
    if (comboElement) comboElement.innerText = combo;
  }

  if (hit || !isCalibrating) {
    addWebDecal(screenX, screenY);
  }
}

function finishCalibration() {
  isCalibrating = false;
  calibrationOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  
  // ---------------------------------------------------------
  // SPEED CONTROL 1: SENSITIVITY (Padding)
  // Increase these numbers (e.g., 0.4) to make the aim SLOWER (less sensitive).
  // Decrease these numbers (e.g., 0.1) to make the aim FASTER (more sensitive).
  // ---------------------------------------------------------
  const xPadding = (maxX - minX) * 0.2;
  const yPadding = (maxY - minY) * 0.2;
  minX -= xPadding;
  maxX += xPadding;
  minY -= yPadding;
  maxY += yPadding;
  
  // Spawning is now handled dynamically in the draw loop
}

function addWebLine(startX, startY, endX, endY) {
  webLines.push({
    startX, startY, endX, endY,
    life: 1.0 // Alpha
  });
}

function createExplosion(x, y) {
  for (let i = 0; i < 20; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 5 + 2;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      size: Math.random() * 5 + 2
    });
  }
}

function addWebDecal(x, y) {
  webDecals.push({
    x, y,
    life: 1.0,
    size: 50,
    vy: Math.random() * 2 + 1 // falling speed
  });
}

const hitTexts = ["THWIP!", "BAM!", "POW!", "ZAP!", "SMASH!"];
const missTexts = ["MISS!", "WHOOPS!", "DODGED!", "NOPE!"];

function addTextDecal(x, y, type) {
  const texts = type === 'hit' ? hitTexts : missTexts;
  const text = texts[Math.floor(Math.random() * texts.length)];
  const color = type === 'hit' ? '#ffff00' : '#ff5555';
  textDecals.push({
    x, y, text, color,
    life: 1.5,
    vy: -1.5,
    size: type === 'hit' ? 60 : 40,
    rotation: (Math.random() - 0.5) * 0.5
  });
}

function spawnTarget() {
  if (isCalibrating || isGameOver) return;
  const size = 100;
  // Spawn outside left or right edge
  const side = Math.random() > 0.5 ? 1 : -1;
  const x = side === 1 ? -size : screenW + size;
  const y = Math.random() * (screenH * 0.6) + (screenH * 0.1); // Upper 70% of screen
  
  // Base speed is now faster and scales with level
  const baseSpeed = Math.random() * 4 + 4 + (level * 1.5);
  const vx = side === 1 ? baseSpeed : -baseSpeed;
  const vy = Math.sin(Date.now() / 1000) * 3; // slight bobbing
  
  // Pick random image
  const imgIndex = Math.floor(Math.random() * villainImages.length);
  
  targets.push({
    x, y, vx, size, img: villainImages[imgIndex]
  });
}

// Main Draw Loop
function draw(timestamp) {
  if (!timestamp) timestamp = performance.now();
  // Calculate delta time, normalize to 60fps (16.6ms per frame)
  // Cap at 3.0 (50ms) to prevent huge physics jumps on severe lag spikes
  const dt = Math.min((timestamp - lastFrameTime) / 16.666, 3.0);
  lastFrameTime = timestamp;

  // Spawn Targets dynamically based on level
  const now = Date.now();
  const spawnInterval = Math.max(500, 2000 - (level * 120));
  if (now - lastSpawnTime > spawnInterval && !isCalibrating && !isGameOver) {
    spawnTarget();
    lastSpawnTime = now;
  }

  // Clear canvas
  canvasCtx.clearRect(0, 0, screenW, screenH);
  
  canvasCtx.save();
  // Apply Screen Shake
  if (shakeAmount > 0) {
    canvasCtx.translate((Math.random() - 0.5) * shakeAmount, (Math.random() - 0.5) * shakeAmount);
    shakeAmount *= 0.9;
    if (shakeAmount < 0.5) shakeAmount = 0;
  }

  // Draw Webs
  for (let i = webLines.length - 1; i >= 0; i--) {
    const web = webLines[i];
    canvasCtx.beginPath();
    canvasCtx.moveTo(web.startX, web.startY);
    canvasCtx.lineTo(web.endX, web.endY);
    canvasCtx.strokeStyle = `rgba(255, 255, 255, ${web.life})`;
    canvasCtx.lineWidth = 15;
    canvasCtx.stroke();
    
    // Draw some web texture (a few smaller lines around it)
    canvasCtx.beginPath();
    canvasCtx.moveTo(web.startX + 15, web.startY);
    canvasCtx.lineTo(web.endX, web.endY);
    canvasCtx.strokeStyle = `rgba(230, 230, 255, ${web.life * 0.8})`;
    canvasCtx.lineWidth = 5;
    canvasCtx.stroke();

    canvasCtx.beginPath();
    canvasCtx.moveTo(web.startX - 15, web.startY);
    canvasCtx.lineTo(web.endX, web.endY);
    canvasCtx.strokeStyle = `rgba(230, 230, 255, ${web.life * 0.8})`;
    canvasCtx.lineWidth = 5;
    canvasCtx.stroke();

    web.life -= 0.05 * dt;
    if (web.life <= 0) {
      webLines.splice(i, 1);
    }
  }
  
  // Draw Targets
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    t.x += t.vx * dt;
    // Guaranteed smooth wavy movement based purely on position, not jittery timestamps
    t.y += Math.sin(t.x * 0.015) * 3 * dt;
    
    // Draw image with 3D shadow effect
    canvasCtx.shadowColor = 'rgba(0,0,0,0.5)';
    canvasCtx.shadowBlur = 20;
    canvasCtx.shadowOffsetX = 10;
    canvasCtx.shadowOffsetY = 10;
    
    if (t.img && t.img.complete) {
      canvasCtx.drawImage(t.img, t.x - t.size/2, t.y - t.size/2, t.size, t.size);
    } else {
      // Fallback
      canvasCtx.fillStyle = 'purple';
      canvasCtx.fillRect(t.x - t.size/2, t.y - t.size/2, t.size, t.size);
    }
    
    // Reset shadow
    canvasCtx.shadowColor = 'transparent';
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowOffsetX = 0;
    canvasCtx.shadowOffsetY = 0;
    
    // Remove if off screen
    if (t.x < -t.size * 2 || t.x > screenW + t.size * 2) {
      targets.splice(i, 1);
      if (!isCalibrating && !isGameOver) {
         lives--;
         if (livesElement) livesElement.innerText = lives;
         if (lives <= 0) {
             isGameOver = true;
         }
      }
    }
  }
  
  // Draw Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= 0.02 * dt;
    
    canvasCtx.fillStyle = `rgba(255, 255, 255, ${p.life})`;
    canvasCtx.beginPath();
    canvasCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    canvasCtx.fill();
    
    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  }
  
  // Draw Web Decals (Spiderweb falling)
  for (let i = webDecals.length - 1; i >= 0; i--) {
    const d = webDecals[i];
    d.y += d.vy * dt; // Falling down
    d.life -= 0.01 * dt;
    
    // Draw a simple spiderweb star pattern
    canvasCtx.strokeStyle = `rgba(255, 255, 255, ${d.life})`;
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    for (let j = 0; j < 8; j++) {
      const angle = (j / 8) * Math.PI * 2;
      canvasCtx.moveTo(d.x, d.y);
      canvasCtx.lineTo(d.x + Math.cos(angle) * d.size, d.y + Math.sin(angle) * d.size);
    }
    // Concentric circles for the web
    canvasCtx.moveTo(d.x + d.size * 0.5, d.y);
    canvasCtx.arc(d.x, d.y, d.size * 0.5, 0, Math.PI * 2);
    canvasCtx.moveTo(d.x + d.size * 0.8, d.y);
    canvasCtx.arc(d.x, d.y, d.size * 0.8, 0, Math.PI * 2);
    canvasCtx.stroke();
    
    if (d.life <= 0) {
      webDecals.splice(i, 1);
    }
  }

  // ---------------------------------------------------------
  // SPEED CONTROL 2: SMOOTHING (LERP)
  // Increase this number (closer to 1.0) to make the crosshair follow your hand FASTER.
  // Decrease this number (closer to 0.01) to make the crosshair HEAVIER and SLOWER.
  // ---------------------------------------------------------
  currentHandPos.x += (targetHandPos.x - currentHandPos.x) * (0.15 * dt);
  currentHandPos.y += (targetHandPos.y - currentHandPos.y) * (0.15 * dt);

  // Draw Crosshair (Hand Position)
  canvasCtx.beginPath();
  canvasCtx.arc(currentHandPos.x, currentHandPos.y, 20, 0, Math.PI * 2);
  canvasCtx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
  canvasCtx.lineWidth = 3;
  canvasCtx.stroke();
  
  canvasCtx.beginPath();
  canvasCtx.arc(currentHandPos.x, currentHandPos.y, 2, 0, Math.PI * 2);
  canvasCtx.fillStyle = 'red';
  canvasCtx.fill();
  
  // Draw Text Decals (Comical hits/misses)
  for (let i = textDecals.length - 1; i >= 0; i--) {
    const d = textDecals[i];
    d.y += d.vy * dt;
    d.life -= 0.02 * dt;
    
    canvasCtx.save();
    canvasCtx.translate(d.x, d.y);
    canvasCtx.rotate(d.rotation);
    canvasCtx.font = `900 ${d.size}px 'Arial Black', sans-serif`;
    canvasCtx.fillStyle = d.color;
    canvasCtx.strokeStyle = 'black';
    canvasCtx.lineWidth = 6;
    canvasCtx.textAlign = 'center';
    canvasCtx.textBaseline = 'middle';
    canvasCtx.globalAlpha = Math.max(0, d.life);
    
    // Draw stroke then fill
    canvasCtx.strokeText(d.text, 0, 0);
    canvasCtx.fillText(d.text, 0, 0);
    canvasCtx.restore();
    
    if (d.life <= 0) {
      textDecals.splice(i, 1);
    }
  }

  if (isGameOver) {
      bgm.pause();
  }

  // Draw Game Over Screen
  if (isGameOver) {
    canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    canvasCtx.fillRect(0, 0, screenW, screenH);
    canvasCtx.font = "bold 100px sans-serif";
    canvasCtx.fillStyle = "red";
    canvasCtx.textAlign = "center";
    canvasCtx.textBaseline = "middle";
    canvasCtx.fillText("GAME OVER", screenW/2, screenH/2 - 50);
    canvasCtx.font = "bold 40px sans-serif";
    canvasCtx.fillStyle = "white";
    canvasCtx.fillText("Refresh to play again", screenW/2, screenH/2 + 50);
  }

  canvasCtx.restore();

  requestAnimationFrame(draw);
}

// Start loop
draw();
