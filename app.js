// app.js - Smart Cursor DAW (complete)
// - Scrubbing (real-time) with fade
// - Click/drag/touch cursor => immediate sound
// - Play-from-cursor scheduling
// - 10-minute tracks, paging, per-track offset dragging
// - Mouse + touch support

// -------------------- Core audio setup --------------------
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);

// -------------------- Config --------------------
const PIXELS_PER_SECOND = 50;              // px per second (adjustable)
const TRACK_DURATION_SECONDS = 600;        // 10 minutes
const TRACK_WIDTH_PX = TRACK_DURATION_SECONDS * PIXELS_PER_SECOND;
const SCRUB_SLICE_SEC = 0.08;              // slice length when scrubbing (80ms)
const SCRUB_THROTTLE_MS = 30;              // minimum ms between scrub audio triggers
const SCRUB_FADE_MS = 0.008;               // 8ms fade in/out to avoid clicks

// -------------------- DOM refs --------------------
const timelineContainer = document.getElementById("timelineContainer");
const cursorCanvas = document.getElementById("masterCursor");
const cursorCtx = cursorCanvas.getContext("2d");
const masterPlayBtn = document.getElementById("masterPlay");
const masterVolumeEl = document.getElementById("masterVolume");


// create cursor handle element (one-time)
let cursorHandle = document.getElementById('cursorHandle');
if (!cursorHandle) {
  cursorHandle = document.createElement('div');
  cursorHandle.id = 'cursorHandle';
  // add a child for nicer hit area (optional)
  const hit = document.createElement('div');
  hit.className = 'hit';
  cursorHandle.appendChild(hit);
  document.body.appendChild(cursorHandle);
}


// ensure cursorCanvas size matches viewport area reserved for tracks (call on resize)
function resizeCursorCanvas() {
  cursorCanvas.width = window.innerWidth;
  cursorCanvas.height = Math.max(200, window.innerHeight - 140); // keep visible area
}
resizeCursorCanvas();
window.addEventListener("resize", resizeCursorCanvas);

// master volume
if (masterVolumeEl) masterVolumeEl.oninput = e => masterGain.gain.value = Number(e.target.value);

// -------------------- Model --------------------
const TIMELINE_COUNT = 10;
const timelines = []; // each: { buffer, startTime, canvas, ctx, trackEl, analyser, ... }

let isPlaying = false;
let projectStartTime = 0;              // audioContext.time corresponding to project time zero offset
let animationId = null;

// paging
let currentPage = 0;
const pageWidth = window.innerWidth;

// scrubbing state
let isScrubbing = false;
let lastScrubTime = 0;
let activeScrubSources = []; // { src, gainNode, stopTimeout }
let lastPerformScrubAt = 0;

// helper: resume audioContext on first gesture
async function ensureAudioContextRunning() {
  if (audioContext.state === "suspended") {
    try { await audioContext.resume(); } catch (e) { console.warn("resume failed", e); }
  }
}

// -------------------- Utility: stop/cleanup --------------------
function stopAllSources() {
  timelines.forEach(tl => {
    if (tl.sourceNodes && tl.sourceNodes.length) {
      tl.sourceNodes.forEach(s => {
        try { s.stop(); } catch (e) {}
      });
      tl.sourceNodes = [];
    }
  });
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  isPlaying = false;
}

// clear scrub short-sources
function clearScrubSources() {
  activeScrubSources.forEach(item => {
    try { item.src.stop(); } catch (e) {}
    clearTimeout(item.stopTimeout);
  });
  activeScrubSources = [];
}

// -------------------- Create timelines (record, draw) --------------------
for (let i = 0; i < TIMELINE_COUNT; i++) createTimeline(i);

function createTimeline(index) {
  const el = document.createElement("div");
  el.className = "timeline";

  el.innerHTML = `
    <div class="timeline-header">
      <div style="display:flex;align-items:center;">
        <button class="rec">● REC</button>
        <button class="stop" disabled>■ STOP</button>
        <span class="timeline-info" style="margin-left:10px;">Track ${index+1}</span>
      </div>
      <div style="display:flex;align-items:center;">
        <span class="start-time-display" style="font-size:12px;color:#bbb;margin-left:12px;">start: 0.00s</span>
      </div>
    </div>
    <div class="timeline-track" style="overflow-x:auto;">
      <canvas class="wave-canvas"></canvas>
    </div>
  `;

  timelineContainer.appendChild(el);

  const trackEl = el.querySelector(".timeline-track");
  const canvas = el.querySelector(".wave-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = TRACK_WIDTH_PX;
  canvas.height = 100;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const analyserData = new Uint8Array(analyser.fftSize);

  timelines[index] = {
    buffer: null,
    startTime: 0,
    canvas,
    ctx,
    trackEl,
    analyser,
    analyserData,
    isRecording: false,
    chunks: null,
    recorder: null,
    mediaStream: null,
    sourceNodes: [],
    // drag timeline
    isDraggingTimeline: false,
    dragStartX: 0,
    dragStartOffset: 0
  };

  // drag timeline to adjust startTime (mouse + touch)
  canvas.addEventListener("pointerdown", (e) => {
    // only start drag if pointer is primary
    if (e.isPrimary) {
      timelines[index].isDraggingTimeline = true;
      timelines[index].dragStartX = e.clientX;
      timelines[index].dragStartOffset = timelines[index].startTime;
      e.preventDefault();
    }
  });

  window.addEventListener("pointerup", () => {
    timelines[index].isDraggingTimeline = false;
  });

  window.addEventListener("pointermove", (e) => {
    const tl = timelines[index];
    if (!tl.isDraggingTimeline) return;
    const dx = e.clientX - tl.dragStartX;
    const deltaTime = dx / PIXELS_PER_SECOND;
    tl.startTime = Math.max(0, tl.dragStartOffset + deltaTime);
    const startDisplay = tl.trackEl.parentElement.querySelector(".start-time-display");
    if (startDisplay) startDisplay.innerText = `start: ${tl.startTime.toFixed(2)}s`;
  });

  // Buttons
  const recBtn = el.querySelector(".rec");
  const stopBtn = el.querySelector(".stop");
  const startTimeDisplay = el.querySelector(".start-time-display");

  function updateStartDisplay() {
    startTimeDisplay.innerText = `start: ${timelines[index].startTime.toFixed(2)}s`;
  }

  // Click canvas to set project cursor
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = ev.clientX - rect.left;
    const globalX = clickX + trackEl.scrollLeft;
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  });

  // REC handler
  recBtn.addEventListener("click", async () => {
    await ensureAudioContextRunning();
    if (timelines[index].isRecording) return;

    // set startTime to current cursor position (use project cursor)
    timelines[index].startTime = Math.max(0, projectCursorTime);
    updateStartDisplay();

    recBtn.disabled = true;
    stopBtn.disabled = false;
    timelines[index].chunks = [];
    timelines[index].isRecording = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      timelines[index].mediaStream = stream;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(timelines[index].analyser);
      source.connect(masterGain); // monitor while recording

      const recorder = new MediaRecorder(stream);
      timelines[index].recorder = recorder;

      recorder.ondataavailable = e => { if (e.data && e.data.size>0) timelines[index].chunks.push(e.data); };

      recorder.onstop = async () => {
        const blob = new Blob(timelines[index].chunks, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        try {
          timelines[index].buffer = await audioContext.decodeAudioData(arrayBuffer);
          drawPersistentWaveform(index);
        } catch (err) {
          console.error("decodeAudioData error", err);
        }
        timelines[index].isRecording = false;
        if (timelines[index].mediaStream) {
          timelines[index].mediaStream.getTracks().forEach(t => t.stop());
          timelines[index].mediaStream = null;
        }
        timelines[index].recorder = null;
        recBtn.disabled = false;
        stopBtn.disabled = true;
      };

      recorder.start();
      drawLiveWaveform(index);
    } catch (err) {
      console.error("getUserMedia error", err);
      timelines[index].isRecording = false;
      recBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });

  // STOP handler
  stopBtn.addEventListener("click", () => {
    const rec = timelines[index].recorder;
    if (rec && rec.state === "recording") rec.stop();
  });

  // scroll syncing across tracks
  trackEl.addEventListener("scroll", () => {
    const newPage = Math.floor(trackEl.scrollLeft / pageWidth);
    if (newPage !== currentPage) {
      currentPage = newPage;
      syncAllTracksToPage(currentPage);
    }
  });
}

// -------------------- draw live waveform --------------------
function drawLiveWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.isRecording) return;
  const { analyser, analyserData, canvas, ctx } = tl;
  const w = canvas.width; const h = canvas.height;

  function loop() {
    if (!tl.isRecording) return;
    analyser.getByteTimeDomainData(analyserData);
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(0,0,w,h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#7be8a6";
    ctx.beginPath();
    const sliceW = w / analyserData.length;
    let x=0;
    for (let i=0;i<analyserData.length;i++){
      const v = analyserData[i]/128.0;
      const y = v * (h/2);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      x += sliceW;
    }
    ctx.stroke();
    requestAnimationFrame(loop);
  }

  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="rgba(0,0,0,0.26)";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  loop();
}

// -------------------- draw persistent waveform --------------------
function drawPersistentWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.buffer) return;
  const buffer = tl.buffer;
  const canvas = tl.canvas;
  const ctx = tl.ctx;
  const w = canvas.width; const h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const channel = buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array(0);
  const len = channel.length;
  if (len === 0) return;
  const spp = Math.max(1, Math.floor(len / w));
  ctx.fillStyle = "rgba(10,20,30,0.4)"; ctx.fillRect(0,0,w,h);
  ctx.fillStyle = "#8fc1ff";
  const mid = h/2;
  for (let x=0; x < w; x++) {
    const start = x*spp;
    let min = 1.0, max = -1.0;
    for (let j=0; j < spp && (start+j) < len; j++){
      const v = channel[start+j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min*mid;
    const y2 = mid + max*mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// -------------------- Cursor management --------------------
let projectCursorTime = 0;            // seconds
let projectCursorTimeAtPlayStart = 0; // seconds recorded at play start (offset)
function setProjectCursorTime(t) {
  projectCursorTime = Math.max(0, Math.min(t, TRACK_DURATION_SECONDS));
  updateCursorVisual();
}

function getProjectCursorTime() {
  if (isPlaying) {
    const elapsedSinceStart = audioContext.currentTime - projectStartTime;
    return Math.max(0, elapsedSinceStart + projectCursorTimeAtPlayStart);
  }
  return projectCursorTime;
}

// update cursor visual and handle paging
function updateCursorVisual() {
  const globalX = projectCursorTime * PIXELS_PER_SECOND;
  const newPage = Math.floor(globalX / pageWidth);
  if (newPage !== currentPage) {
    currentPage = newPage;
    syncAllTracksToPage(currentPage);
  }
  const screenX = globalX - currentPage * pageWidth;

  // draw cursor line on canvas
  cursorCtx.clearRect(0,0,cursorCanvas.width,cursorCanvas.height);
  cursorCtx.strokeStyle = "red";
  cursorCtx.lineWidth = 2;
  cursorCtx.beginPath();
  cursorCtx.moveTo(screenX, 0);
  cursorCtx.lineTo(screenX, cursorCanvas.height);
  cursorCtx.stroke();

  // position the handle centered on the same X (handle is absolute positioned in body)
  if (cursorHandle) {
    // compute top relative to document: use cursorCanvas.getBoundingClientRect().top
    const rect = cursorCanvas.getBoundingClientRect();
    const handleLeft = (currentPage * pageWidth + screenX) - (cursorHandle.offsetWidth / 2);
    cursorHandle.style.left = `${handleLeft}px`;
    cursorHandle.style.top = `${rect.top}px`;
    cursorHandle.style.height = `${rect.height}px`;
  }
}

// sync scrollLeft of all tracks to pageIndex
function syncAllTracksToPage(pageIndex) {
  const scrollLeft = pageIndex * pageWidth;
  timelines.forEach(tl => { if (tl && tl.trackEl) tl.trackEl.scrollLeft = scrollLeft; });
}

// -------------------- Scrubbing (real-time) --------------------
function performScrubAt(cursorTime) {
  const now = performance.now();
  if (now - lastPerformScrubAt < SCRUB_THROTTLE_MS) return; // throttle
  lastPerformScrubAt = now;

  if (!timelines || timelines.length === 0) return;
  clearScrubSources();

  timelines.forEach(tl => {
    if (!tl || !tl.buffer) return;
    const clipStart = tl.startTime || 0;
    const bufDur = tl.buffer.duration;
    const localPos = cursorTime - clipStart;
    if (localPos < 0 || localPos >= bufDur) return;

    // create source for short slice
    const src = audioContext.createBufferSource();
    src.buffer = tl.buffer;

    // create gain with tiny fade-in/out to avoid clicks
    const g = audioContext.createGain();
    const nowTime = audioContext.currentTime;
    g.gain.setValueAtTime(0.0, nowTime);
    g.gain.linearRampToValueAtTime(1.0, nowTime + SCRUB_FADE_MS);
    // schedule fade out slightly before stop (will call stop via timeout still)
    g.connect(masterGain);
    src.connect(g);

    try {
      src.start(0, Math.max(0, localPos), SCRUB_SLICE_SEC);
    } catch (e) {
      try { src.start(0, Math.max(0, localPos), SCRUB_SLICE_SEC / 2); } catch (e2) { console.warn("scrub start failed", e2); }
    }

    // schedule fade out
    const stopAt = audioContext.currentTime + SCRUB_SLICE_SEC;
    g.gain.linearRampToValueAtTime(0.0, stopAt - SCRUB_FADE_MS);
    // ensure src stop via timeout in case onended not timely
    const stopTimeout = setTimeout(()=> {
      try { src.stop(); } catch(e) {}
    }, Math.ceil(SCRUB_SLICE_SEC*1000)+50);

    activeScrubSources.push({ src, gainNode: g, stopTimeout });
    // cleanup onended
    src.onended = () => { clearTimeout(stopTimeout); activeScrubSources = activeScrubSources.filter(it => it.src !== src); };
  });
}

// scrubbing loop (called while scrubbing)
let scrubRAF = null;
function scrubLoop() {
  if (!isScrubbing) return;
  performScrubAt(projectCursorTime);
  scrubRAF = requestAnimationFrame(scrubLoop);
}

// start scrubbing (enter scrub mode)
function startScrubMode() {
  // stop any full playback
  if (isPlaying) stopAllSources();
  isScrubbing = true;
  lastPerformScrubAt = 0;
  if (!scrubRAF) scrubLoop();
}

// stop scrubbing and cleanup
function stopScrubMode() {
  isScrubbing = false;
  if (scrubRAF) { cancelAnimationFrame(scrubRAF); scrubRAF = null; }
  clearScrubSources();
}

// -------------------- Cursor interactions (mouse/touch/pointer unified) --------------------

// allow pointer events — ensure in CSS #masterCursor { pointer-events: auto; }
let draggingCursor = false;

cursorCanvas.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary) return;
  // compute pointer position
  const rect = cursorCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const globalX = currentPage * pageWidth + clickX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  // start scrubbing
  startScrubMode();
  draggingCursor = true;
  e.preventDefault();
});

window.addEventListener("pointermove", (e) => {
  if (!draggingCursor) return;
  const rect = cursorCanvas.getBoundingClientRect();
  const moveX = e.clientX - rect.left;
  const globalX = currentPage * pageWidth + moveX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  // scrub will pick up via scrubLoop
});

window.addEventListener("pointerup", (e) => {
  if (!draggingCursor) return;
  draggingCursor = false;
  // stop scrubbing but also start full playback from cursor if desired
  stopScrubMode();
  // auto-start playback from cursor on release if user prefers:
  // startPlaybackFromCursor();
});

// clicking on track canvases: single-shot scrub
timelineContainer.addEventListener("click", (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains("wave-canvas")) {
    const rect = t.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const parent = t.parentElement; // trackEl
    const globalX = clickX + parent.scrollLeft;
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
    // single-shot scrub (play short slices)
    performScrubAt(projectCursorTime);
    setTimeout(()=> clearScrubSources(), Math.ceil(SCRUB_SLICE_SEC*1000)+60);
  }
});

// -------------------- Play-from-cursor (master play) --------------------
masterPlayBtn.addEventListener("click", async () => {
  if (isPlaying) {
    // stop if playing
    stopAllSources();
    updateCursorVisual();
    return;
  }
  await ensureAudioContextRunning();

  // prepare playback starting at current cursor
  projectCursorTimeAtPlayStart = projectCursorTime;
  const startAt = audioContext.currentTime + 0.05; // small scheduling delay
  projectStartTime = startAt - projectCursorTimeAtPlayStart;

  // stop any scrub-sources
  stopScrubMode();
  clearScrubSources();
  stopAllSources();

  // schedule buffers
  timelines.forEach(tl => {
    if (!tl || !tl.buffer) return;
    const buf = tl.buffer;
    const clipStart = tl.startTime || 0;
    const clipEnd = clipStart + buf.duration;
    const playFrom = projectCursorTimeAtPlayStart;
    if (clipEnd <= playFrom) return; // nothing to play

    const src = audioContext.createBufferSource();
    src.buffer = buf;
    const trackGain = audioContext.createGain();
    trackGain.gain.value = 1.0;
    src.connect(trackGain).connect(masterGain);

    if (clipStart <= playFrom) {
      // clip started earlier -> start immediately and offset into buffer
      const offset = Math.max(0, playFrom - clipStart);
      try { src.start(startAt, offset); } catch(e){ console.warn("start error", e); }
    } else {
      // clip starts after cursor -> schedule later
      const when = startAt + (clipStart - playFrom);
      try { src.start(when, 0); } catch(e){ console.warn("start error", e); }
    }

    tl.sourceNodes = tl.sourceNodes || [];
    tl.sourceNodes.push(src);
    src.onended = () => { tl.sourceNodes = tl.sourceNodes.filter(s => s !== src); };
  });

  isPlaying = true;
  animateCursorDuringPlay();
});

// animate cursor while playing
function animateCursorDuringPlay() {
  if (!isPlaying) return;
  const elapsed = audioContext.currentTime - projectStartTime;
  projectCursorTime = elapsed; // updates absolute project time
  updateCursorVisual();

  // if reach end
  if (projectCursorTime >= TRACK_DURATION_SECONDS) {
    stopAllSources();
    return;
  }
  animationId = requestAnimationFrame(animateCursorDuringPlay);
}

// convenience: start playback from cursor (callable)
async function startPlaybackFromCursor() {
  if (isPlaying) return;
  masterPlayBtn.click();
}

// initial visual
updateCursorVisual();

