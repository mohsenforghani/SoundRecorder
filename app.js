// app.js - Multitrack DAW: Click/Drag cursor, Paging, 10-minute tracks, Play-from-cursor

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);

// CONFIG
const PIXELS_PER_SECOND = 50;      // پیکسل به ازای هر ثانیه (می‌توان کم/زیاد کرد)
const TRACK_DURATION_SECONDS = 600; // 10 minutes = 600s
const TRACK_WIDTH_PX = TRACK_DURATION_SECONDS * PIXELS_PER_SECOND;

const timelineContainer = document.getElementById("timelineContainer");
const cursorCanvas = document.getElementById("masterCursor");
const cursorCtx = cursorCanvas.getContext("2d");
const masterPlayBtn = document.getElementById("masterPlay");
const masterVolumeEl = document.getElementById("masterVolume");

// resize cursor canvas to viewport area reserved for timelines
function resizeCursorCanvas() {
  cursorCanvas.width = window.innerWidth;
  cursorCanvas.height = window.innerHeight - 140; // اگر header ارتفاع فردی دارد تنظیم کن
}
resizeCursorCanvas();
window.addEventListener("resize", resizeCursorCanvas);

if (masterVolumeEl) masterVolumeEl.oninput = e => masterGain.gain.value = Number(e.target.value);

// Model
const TIMELINE_COUNT = 10;
const timelines = []; // each: { buffer, startTime, canvas, ctx, trackEl, analyser, isRecording, ... }

let isPlaying = false;
let projectStartTime = 0; // audioContext.currentTime at which playback reference starts
let animationId = null;

// Paging state (which page is visible)
let currentPage = 0;
const pageWidth = window.innerWidth; // viewport width in px

// helper resume
async function ensureAudioContextRunning() {
  if (audioContext.state === "suspended") {
    try { await audioContext.resume(); } catch (e) { console.warn(e); }
  }
}

// Create timelines
for (let i = 0; i < TIMELINE_COUNT; i++) createTimeline(i);

function createTimeline(index) {
  const el = document.createElement("div");
  el.className = "timeline";

  el.innerHTML = `
    <div class="timeline-header">
      <button class="rec">● REC</button>
      <button class="stop" disabled>■ STOP</button>
      <span class="timeline-info">Track ${index + 1}</span>
      <span class="start-time-display">start: 0.00s</span>
    </div>
    <div class="timeline-track" style="overflow-x:auto;">
      <canvas class="wave-canvas"></canvas>
    </div>
  `;

  timelineContainer.appendChild(el);

  const trackEl = el.querySelector(".timeline-track");
  const canvas = el.querySelector(".wave-canvas");
  const ctx = canvas.getContext("2d");
  // set full width for 10 minutes
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
  dragOffsetX: 0,    
  isDraggingTimeline: false
};


  // -------------------------
// Drag timeline to adjust startTime
// -------------------------
canvas.addEventListener("mousedown", (e) => {
  if (e.target !== canvas) return;
  timelines[index].isDraggingTimeline = true;
  timelines[index].dragStartX = e.clientX;
  timelines[index].dragStartOffset = timelines[index].startTime;
});
window.addEventListener("mouseup", () => {
  timelines[index].isDraggingTimeline = false;
});
window.addEventListener("mousemove", (e) => {
  const tl = timelines[index];
  if (!tl.isDraggingTimeline) return;
  
  const dx = e.clientX - tl.dragStartX; // پیکسل تغییر
  const deltaTime = dx / PIXELS_PER_SECOND; // تبدیل px → ثانیه
  tl.startTime = Math.max(0, tl.dragStartOffset + deltaTime);
  
  // بروزرسانی نمایش startTime
  const startDisplay = tl.trackEl.parentElement.querySelector(".start-time-display");
  if (startDisplay) startDisplay.innerText = `start: ${tl.startTime.toFixed(2)}s`;
});


  
  // show start time text
  const startTimeDisplay = el.querySelector(".start-time-display");
  function updateStartDisplay() {
    startTimeDisplay.innerText = `start: ${timelines[index].startTime.toFixed(2)}s`;
  }

  // Buttons
  const recBtn = el.querySelector(".rec");
  const stopBtn = el.querySelector(".stop");

  // Click-on-canvas to set clip start or set global cursor (we'll use click on canvas to set cursor)
  canvas.addEventListener("click", (ev) => {
    // compute globalX: clickX + trackEl.scrollLeft
    const rect = canvas.getBoundingClientRect();
    const clickX = ev.clientX - rect.left;
    const globalX = clickX + trackEl.scrollLeft;
    // set clip start to clicked time (optional) OR set global cursor time — user requested cursor by click on page
    // we set project cursor here:
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  });

  // REC handler
  recBtn.onclick = async () => {
    await ensureAudioContextRunning();
    if (timelines[index].isRecording) return;

    // set startTime to current cursor position (if playing) or to current project cursor
    const curTime = getProjectCursorTime();
    timelines[index].startTime = Math.max(0, curTime);
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
      source.connect(masterGain); // monitor

      const recorder = new MediaRecorder(stream);
      timelines[index].recorder = recorder;

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) timelines[index].chunks.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(timelines[index].chunks, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        try {
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          timelines[index].buffer = audioBuffer;
          drawPersistentWaveform(index);
        } catch (err) {
          console.error("decode error", err);
        }

        // cleanup stream
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
      drawLiveWaveform(index); // loop while recording
    } catch (err) {
      console.error("getUserMedia error:", err);
      timelines[index].isRecording = false;
      recBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };

  // STOP handler
  stopBtn.onclick = () => {
    const rec = timelines[index].recorder;
    if (rec && rec.state === "recording") rec.stop();
  };

  // make track horizontally large and pageable: ensure its scrollLeft aligns to pages
  // when user scrolls manually we update currentPage accordingly (optional)
  trackEl.addEventListener("scroll", () => {
    const newPage = Math.floor(trackEl.scrollLeft / pageWidth);
    if (newPage !== currentPage) {
      // if user scrolls a single track manually, sync pages across all tracks
      currentPage = newPage;
      syncAllTracksToPage(currentPage);
    }
  });
}

// ---------------------------
// Live waveform (during recording)
// ---------------------------
function drawLiveWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.isRecording) return;
  const { analyser, analyserData, canvas, ctx } = tl;
  const w = canvas.width;
  const h = canvas.height;

  function loop() {
    if (!tl.isRecording) return;
    analyser.getByteTimeDomainData(analyserData);

    // draw background translucent to create "tail" effect
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#7be8a6";
    ctx.beginPath();

    const sliceWidth = w / analyserData.length;
    let x = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const v = analyserData[i] / 128.0; // 0..2
      const y = v * (h / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();

    requestAnimationFrame(loop);
  }

  // clear and prepare
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, w, h);
  loop();
}

// ---------------------------
// Persistent waveform draw (from AudioBuffer)
// ---------------------------
function drawPersistentWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.buffer) return;
  const buffer = tl.buffer;
  const canvas = tl.canvas;
  const ctx = tl.ctx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // mix down first channel (or average channels)
  const channel = buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array(0);
  const len = channel.length;
  if (len === 0) return;

  const samplesPerPixel = Math.max(1, Math.floor(len / w));
  ctx.fillStyle = "rgba(10,20,30,0.4)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#8fc1ff";
  const mid = h / 2;

  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPixel;
    let min = 1.0, max = -1.0;
    for (let j = 0; j < samplesPerPixel && (start + j) < len; j++) {
      const v = channel[start + j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// ---------------------------
// Cursor management
// ---------------------------
let projectCursorTime = 0; // seconds: global project cursor
function setProjectCursorTime(t) {
  projectCursorTime = Math.max(0, Math.min(t, TRACK_DURATION_SECONDS));
  // update visible cursor and paging
  updateCursorVisual();
}

// get current project cursor: if playing, reflect audioContext time offset
function getProjectCursorTime() {
  if (isPlaying) {
    const elapsedSinceStart = audioContext.currentTime - projectStartTime;
    return Math.max(0, elapsedSinceStart + projectCursorTimeAtPlayStart); // handled below
  }
  return projectCursorTime;
}

// When play starts we capture the start cursor and treat it as offset
let projectCursorTimeAtPlayStart = 0;

// draw cursor in the viewport (cursorCanvas). It should consider current page offset.
function updateCursorVisual() {
  // compute global pixel x of cursor
  const globalX = projectCursorTime * PIXELS_PER_SECOND;
  // compute which page it belongs to
  const newPage = Math.floor(globalX / pageWidth);
  if (newPage !== currentPage) {
    currentPage = newPage;
    syncAllTracksToPage(currentPage);
  }
  // compute screen x (relative to viewport)
  const screenX = globalX - currentPage * pageWidth;

  // draw
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  cursorCtx.strokeStyle = "red";
  cursorCtx.lineWidth = 2;
  cursorCtx.beginPath();
  cursorCtx.moveTo(screenX, 0);
  cursorCtx.lineTo(screenX, cursorCanvas.height);
  cursorCtx.stroke();
}

// Sync all timeline horizontal scroll to page
function syncAllTracksToPage(pageIndex) {
  const scrollLeft = pageIndex * pageWidth;
  timelines.forEach(tl => {
    if (tl && tl.trackEl) tl.trackEl.scrollLeft = scrollLeft;
  });
}

// Click on the cursor canvas sets cursor time
cursorCanvas.addEventListener("click", (e) => {
  const rect = cursorCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  // compute globalX = page*pageWidth + clickX
  const globalX = currentPage * pageWidth + clickX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
});

// Dragging the cursor
let isDraggingCursor = false;
cursorCanvas.addEventListener("mousedown", (e) => {
  isDraggingCursor = true;
});
window.addEventListener("mouseup", () => {
  isDraggingCursor = false;
});
window.addEventListener("mousemove", (e) => {
  if (!isDraggingCursor) return;
  const rect = cursorCanvas.getBoundingClientRect();
  const moveX = e.clientX - rect.left;
  const globalX = currentPage * pageWidth + moveX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
});

// Also allow clicking on any timeline area (the track) to set the cursor to that spot
timelineContainer.addEventListener("click", (e) => {
  const target = e.target;
  if (target && target.classList && target.classList.contains("wave-canvas")) {
    const canvas = target;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const parent = canvas.parentElement; // .timeline-track
    const globalX = clickX + parent.scrollLeft;
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  }
});

// ---------------------------
// PLAY from cursor
// ---------------------------
masterPlayBtn.addEventListener("click", async () => {
  if (isPlaying) return;
  await ensureAudioContextRunning();

  // record cursor time at start (so we can compute offsets)
  projectCursorTimeAtPlayStart = projectCursorTime;

  // small scheduling delay
  const startAt = audioContext.currentTime + 0.05;
  projectStartTime = startAt - projectCursorTimeAtPlayStart; // so audioContext.currentTime - projectStartTime == elapsed from cursor start

  // stop any previous sources
  stopAllSources();

  // schedule each timeline buffer relative to projectStartTime
  timelines.forEach(tl => {
    if (!tl.buffer) return;
    const buf = tl.buffer;
    const clipStart = tl.startTime || 0;
    const clipEnd = clipStart + buf.duration;

    // If the clip ends before the cursor position, skip
    const playFrom = projectCursorTimeAtPlayStart; // seconds into project where playback begins
    if (clipEnd <= playFrom) return; // clip already finished before cursor

    // create source
    const src = audioContext.createBufferSource();
    src.buffer = buf;
    const trackGain = audioContext.createGain();
    src.connect(trackGain).connect(masterGain);

    // compute offset into buffer and when to start
    if (clipStart <= playFrom) {
      // clip started before or at cursor -> start immediately from offset = playFrom - clipStart
      const offset = Math.max(0, playFrom - clipStart);
      try {
        src.start(startAt, offset);
      } catch (e) { console.warn(e); }
    } else {
      // clip starts after cursor -> schedule later at time (clipStart - playFrom) from startAt
      const when = startAt + (clipStart - playFrom);
      try {
        src.start(when, 0);
      } catch (e) { console.warn(e); }
    }

    tl.sourceNodes = tl.sourceNodes || [];
    tl.sourceNodes.push(src);
    src.onended = () => { tl.sourceNodes = tl.sourceNodes.filter(s => s !== src); };
  });

  isPlaying = true;
  animateCursorDuringPlay();
});

// animate cursor during play; keep projectCursorTime updated as audioContext moves
function animateCursorDuringPlay() {
  if (!isPlaying) return;
  // compute elapsed since projectStartTime
  const elapsed = audioContext.currentTime - projectStartTime;
  projectCursorTime = elapsed; // absolute project time
  updateCursorVisual();

  // if cursor goes beyond track duration stop playback automatically
  if (projectCursorTime >= TRACK_DURATION_SECONDS) {
    stopAllSources();
    return;
  }

  animationId = requestAnimationFrame(animateCursorDuringPlay);
}

// stop all active sources and cancel animation
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

// allow master stop if exists externally (you removed header stop previously) — we'll support double-clicking Play to stop
masterPlayBtn.addEventListener("dblclick", () => {
  stopAllSources();
});

// initial draw of cursor
updateCursorVisual();

