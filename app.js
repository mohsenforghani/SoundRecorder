// ====================
// Part 1: Timeline & Recording Setup
// ====================

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);

// CONFIG
const PIXELS_PER_SECOND = 50;
const TRACK_DURATION_SECONDS = 600; // 10 دقیقه
const TRACK_WIDTH_PX = TRACK_DURATION_SECONDS * PIXELS_PER_SECOND;

const timelineContainer = document.getElementById("timelineContainer");
const cursorCanvas = document.getElementById("masterCursor");
const cursorCtx = cursorCanvas.getContext("2d");
const masterPlayBtn = document.getElementById("masterPlay");
const masterVolumeEl = document.getElementById("masterVolume");

function resizeCursorCanvas() {
  cursorCanvas.width = window.innerWidth;
  cursorCanvas.height = window.innerHeight - 140;
}
resizeCursorCanvas();
window.addEventListener("resize", resizeCursorCanvas);

if (masterVolumeEl) masterVolumeEl.oninput = e => masterGain.gain.value = Number(e.target.value);

// Model
const TIMELINE_COUNT = 10;
const timelines = [];

let isPlaying = false;
let projectStartTime = 0;
let animationId = null;

let currentPage = 0;
const pageWidth = window.innerWidth;

// resume audio context helper
async function ensureAudioContextRunning() {
  if (audioContext.state === "suspended") {
    try { await audioContext.resume(); } catch (e) { console.warn(e); }
  }
}

// -------------------------
// Timeline creation
// -------------------------
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
    timelines[index].isDraggingTimeline = true;
    timelines[index].dragStartX = e.clientX;
    timelines[index].dragStartOffset = timelines[index].startTime;
  });
  window.addEventListener("mouseup", () => { timelines[index].isDraggingTimeline = false; });
  window.addEventListener("mousemove", (e) => {
    const tl = timelines[index];
    if (!tl.isDraggingTimeline) return;
    const dx = e.clientX - tl.dragStartX;
    const deltaTime = dx / PIXELS_PER_SECOND;
    tl.startTime = Math.max(0, tl.dragStartOffset + deltaTime);
    const startDisplay = tl.trackEl.parentElement.querySelector(".start-time-display");
    if (startDisplay) startDisplay.innerText = `start: ${tl.startTime.toFixed(2)}s`;
  });

  // -------------------------
  // Buttons: REC & STOP
  // -------------------------
  const recBtn = el.querySelector(".rec");
  const stopBtn = el.querySelector(".stop");
  const startTimeDisplay = el.querySelector(".start-time-display");

  function updateStartDisplay() {
    startTimeDisplay.innerText = `start: ${timelines[index].startTime.toFixed(2)}s`;
  }

  recBtn.onclick = async () => {
    await ensureAudioContextRunning();
    if (timelines[index].isRecording) return;

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
      source.connect(masterGain);

      const recorder = new MediaRecorder(stream);
      timelines[index].recorder = recorder;

      recorder.ondataavailable = e => { if (e.data && e.data.size>0) timelines[index].chunks.push(e.data); };

      recorder.onstop = async () => {
        const blob = new Blob(timelines[index].chunks, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        try {
          timelines[index].buffer = await audioContext.decodeAudioData(arrayBuffer);
          drawPersistentWaveform(index);
        } catch(err){ console.error(err); }

        timelines[index].isRecording = false;
        if(timelines[index].mediaStream){ timelines[index].mediaStream.getTracks().forEach(t=>t.stop()); timelines[index].mediaStream = null; }
        timelines[index].recorder = null;
        recBtn.disabled = false;
        stopBtn.disabled = true;
      };

      recorder.start();
      drawLiveWaveform(index);

    } catch(err){
      console.error(err);
      timelines[index].isRecording = false;
      recBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };

  stopBtn.onclick = () => {
    if (timelines[index].recorder && timelines[index].recorder.state==="recording") timelines[index].recorder.stop();
  };

  // Click on track to set cursor
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = ev.clientX - rect.left;
    const globalX = clickX + trackEl.scrollLeft;
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  });

  // Scroll syncing across tracks
  trackEl.addEventListener("scroll", () => {
    const newPage = Math.floor(trackEl.scrollLeft / pageWidth);
    if (newPage !== currentPage){
      currentPage = newPage;
      syncAllTracksToPage(currentPage);
    }
  });
}

// -------------------------
// Live waveform (recording)
// -------------------------
function drawLiveWaveform(index){
  const tl = timelines[index];
  if (!tl.isRecording) return;
  const { analyser, analyserData, canvas, ctx } = tl;
  const w = canvas.width; const h = canvas.height;

  function loop(){
    if (!tl.isRecording) return;
    analyser.getByteTimeDomainData(analyserData);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0,0,w,h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#7be8a6";
    ctx.beginPath();
    const sliceWidth = w / analyserData.length;
    let x=0;
    for(let i=0;i<analyserData.length;i++){
      const v=analyserData[i]/128.0;
      const y=v*(h/2);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      x+=sliceWidth;
    }
    ctx.stroke();
    requestAnimationFrame(loop);
  }
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="rgba(0,0,0,0.3)";
  ctx.fillRect(0,0,w,h);
  loop();
}

// -------------------------
// Persistent waveform draw
// -------------------------
function drawPersistentWaveform(index){
  const tl = timelines[index];
  if(!tl || !tl.buffer) return;
  const buffer = tl.buffer;
  const canvas = tl.canvas; const ctx = tl.ctx;
  const w = canvas.width; const h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const channel = buffer.numberOfChannels>0 ? buffer.getChannelData(0) : new Float32Array(0);
  const len = channel.length;
  if(len===0) return;

  const samplesPerPixel = Math.max(1, Math.floor(len/w));
  ctx.fillStyle="rgba(10,20,30,0.4)";
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle="#8fc1ff";
  const mid=h/2;

  for(let x=0;x<w;x++){
    const start=x*samplesPerPixel;
    let min=1.0,max=-1.0;
    for(let j=0;j<samplesPerPixel&&(start+j)<len;j++){
      const v=channel[start+j];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    const y1=mid+min*mid;
    const y2=mid+max*mid;
    ctx.fillRect(x,y1,1,Math.max(1,y2-y1));
  }
}

// -------------------------
// Cursor basic setup
// -------------------------
let projectCursorTime=0;
function setProjectCursorTime(t){ projectCursorTime = Math.max(0, Math.min(t, TRACK_DURATION_SECONDS)); updateCursorVisual(); }
function getProjectCursorTime(){ return projectCursorTime; }
let projectCursorTimeAtPlayStart=0;
function syncAllTracksToPage(pageIndex){
  const scrollLeft = pageIndex*pageWidth;
  timelines.forEach(tl=>{ if(tl && tl.trackEl) tl.trackEl.scrollLeft=scrollLeft; });
}
// ============================
// Part 2: Smart Cursor & Scrubbing
// ============================

// Draw cursor in viewport
function updateCursorVisual() {
  const globalX = projectCursorTime * PIXELS_PER_SECOND;
  const newPage = Math.floor(globalX / pageWidth);
  if (newPage !== currentPage) {
    currentPage = newPage;
    syncAllTracksToPage(currentPage);
  }
  const screenX = globalX - currentPage * pageWidth;

  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  cursorCtx.strokeStyle = "red";
  cursorCtx.lineWidth = 2;
  cursorCtx.beginPath();
  cursorCtx.moveTo(screenX, 0);
  cursorCtx.lineTo(screenX, cursorCanvas.height);
  cursorCtx.stroke();
}

// Click on cursor canvas sets cursor time
cursorCanvas.addEventListener("click", (e) => {
  const rect = cursorCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const globalX = currentPage * pageWidth + clickX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  if(isPlaying) scrubPlayFromCursor();
});

// Drag cursor
let isDraggingCursor = false;
cursorCanvas.addEventListener("mousedown", (e) => { isDraggingCursor = true; scrubPlayFromCursor(); });
window.addEventListener("mouseup", () => { isDraggingCursor = false; stopAllSources(); });
window.addEventListener("mousemove", (e) => {
  if (!isDraggingCursor) return;
  const rect = cursorCanvas.getBoundingClientRect();
  const moveX = e.clientX - rect.left;
  const globalX = currentPage * pageWidth + moveX;
  setProjectCursorTime(globalX / PIXELS_PER_SECOND);
  scrubPlayFromCursor();
});

// Also allow clicking on timeline track to set cursor
timelineContainer.addEventListener("click", (e) => {
  const target = e.target;
  if (target && target.classList && target.classList.contains("wave-canvas")) {
    const canvas = target;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const parent = canvas.parentElement;
    const globalX = clickX + parent.scrollLeft;
    setProjectCursorTime(globalX / PIXELS_PER_SECOND);
    if(isPlaying) scrubPlayFromCursor();
  }
});

// ---------------------------
// Scrubbing: play all timelines from cursor
// ---------------------------
function scrubPlayFromCursor() {
  if (!isPlaying) return;

  stopAllSources(); // stop previous playback

  const startAt = audioContext.currentTime + 0.01; // small delay
  projectCursorTimeAtPlayStart = projectCursorTime;
  projectStartTime = startAt - projectCursorTimeAtPlayStart;

  timelines.forEach(tl => {
    if (!tl.buffer) return;
    const buf = tl.buffer;
    const clipStart = tl.startTime || 0;
    const clipEnd = clipStart + buf.duration;
    const playFrom = projectCursorTimeAtPlayStart;

    if (clipEnd <= playFrom) return;

    const src = audioContext.createBufferSource();
    src.buffer = buf;
    const trackGain = audioContext.createGain();
    src.connect(trackGain).connect(masterGain);

    if (clipStart <= playFrom) {
      const offset = Math.max(0, playFrom - clipStart);
      try { src.start(startAt, offset); } catch(e){console.warn(e);}
    } else {
      const when = startAt + (clipStart - playFrom);
      try { src.start(when, 0); } catch(e){console.warn(e);}
    }

    tl.sourceNodes = tl.sourceNodes || [];
    tl.sourceNodes.push(src);
    src.onended = () => { tl.sourceNodes = tl.sourceNodes.filter(s => s!==src); };
  });

  animateCursorDuringPlay();
}

// animate cursor in real-time
function animateCursorDuringPlay() {
  if(!isPlaying) return;
  const elapsed = audioContext.currentTime - projectStartTime;
  projectCursorTime = elapsed;
  updateCursorVisual();

  if(projectCursorTime >= TRACK_DURATION_SECONDS){
    stopAllSources();
    return;
  }

  animationId = requestAnimationFrame(animateCursorDuringPlay);
}
