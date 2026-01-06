// app.js - Web Audio DAW (Recorder + Multitrack Playhead + Persistent Waveforms)

/*
  توضیحات:
  - 10 تایم‌لاین می‌سازیم.
  - هر تایم‌لاین: دکمه REC و STOP، یک canvas برای wave.
  - ضبط: MediaRecorder -> chunks -> decode -> AudioBuffer
  - رسم زنده: از AnalyserNode برای نمایش waveform هنگام ضبط استفاده می‌کنیم.
  - پس از Stop: AudioBuffer را رسم (persistent) می‌کنیم.
  - Play: همه کلیپ‌هایی که buffer دارند طبق timeline.startTime زمان‌بندی می‌شوند.
*/

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);

// master volume control
const masterVolumeEl = document.getElementById("masterVolume");
if (masterVolumeEl) {
  masterVolumeEl.oninput = e => {
    masterGain.gain.value = Number(e.target.value);
  };
}

const timelineContainer = document.getElementById("timelineContainer");
const cursorCanvas = document.getElementById("masterCursor");
const cursorCtx = cursorCanvas.getContext("2d");

function resizeCursorCanvas() {
  cursorCanvas.width = window.innerWidth;
  cursorCanvas.height = window.innerHeight - 140; // مطابق style top
}
resizeCursorCanvas();
window.addEventListener("resize", resizeCursorCanvas);

const TIMELINE_COUNT = 10;
const timelines = []; // هر المان: { buffer, startTime, analyser, isRecording, chunks, sourceNodes, canvas, ctx }

let isPlaying = false;
let projectStartTime = 0; // audioContext.currentTime وقتی play زده شد
let animationId = null;
const PIXELS_PER_SECOND = 100; // برای محاسبه موقعیت کرسر

// helper: resume audio context on first user gesture
async function ensureAudioContextRunning() {
  if (audioContext.state === "suspended") {
    try { await audioContext.resume(); } catch (e) { console.warn("resume audioContext failed", e); }
  }
}

// ==========================
// create timelines
// ==========================
for (let i = 0; i < TIMELINE_COUNT; i++) createTimeline(i);

function createTimeline(index) {
  const el = document.createElement("div");
  el.className = "timeline";

  el.innerHTML = `
    <div class="timeline-header">
      <button class="rec">● REC</button>
      <button class="stop" disabled>■ STOP</button>
      <span class="timeline-info">Track ${index + 1}</span>
    </div>
    <div class="timeline-track">
      <canvas class="wave-canvas"></canvas>
    </div>
  `;

  // append to DOM
  timelineContainer.appendChild(el);

  const canvas = el.querySelector(".wave-canvas");
  const ctx = canvas.getContext("2d");

  // set canvas size; width large so waveform can be wide — we'll scale to width
  canvas.width = Math.max(800, timelineContainer.clientWidth - 40);
  canvas.height = 80;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048; // زمان‌نمایی بهتر برای wave
  const analyserBufferLength = analyser.fftSize;
  const analyserData = new Uint8Array(analyserBufferLength);

  // timeline model
  timelines[index] = {
    buffer: null,            // AudioBuffer after decode
    startTime: 0,           // start time in project (seconds)
    analyser,
    analyserData,
    isRecording: false,
    chunks: null,
    recorder: null,
    mediaStream: null,
    sourceNodes: [],        // active playback sources (for stop)
    canvas,
    ctx,
    widthScale: 1           // used when drawing persistent waveform
  };

  // UI buttons
  const recBtn = el.querySelector(".rec");
  const stopBtn = el.querySelector(".stop");

  // ==========================
  // REC handler
  // ==========================
  recBtn.onclick = async () => {
    await ensureAudioContextRunning();

    // prevent double start
    if (timelines[index].isRecording) return;

    try {
      // set track's startTime to current project cursor if playing, else 0
      const timelineStart = isPlaying ? Math.max(0, audioContext.currentTime - projectStartTime) : 0;
      timelines[index].startTime = timelineStart;

      recBtn.disabled = true;
      stopBtn.disabled = false;

      // prepare recording
      timelines[index].chunks = [];
      timelines[index].isRecording = true;

      // get microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      timelines[index].mediaStream = stream;

      // create nodes
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(timelines[index].analyser);
      // also connect to master so user hears monitoring during recording:
      source.connect(masterGain);

      // create media recorder
      const recorder = new MediaRecorder(stream);
      timelines[index].recorder = recorder;

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) timelines[index].chunks.push(e.data);
      };

      recorder.onstop = async () => {
        // decode recorded data into AudioBuffer
        const blob = new Blob(timelines[index].chunks, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer).catch(err => {
          console.error("decodeAudioData failed:", err);
          return null;
        });
        if (audioBuffer) {
          timelines[index].buffer = audioBuffer;
          // draw persistent waveform based on buffer
          drawPersistentWaveform(index);
        }

        // cleanup
        timelines[index].isRecording = false;
        timelines[index].recorder = null;
        // stop tracks on stream
        if (timelines[index].mediaStream) {
          timelines[index].mediaStream.getTracks().forEach(t => t.stop());
          timelines[index].mediaStream = null;
        }

        recBtn.disabled = false;
        stopBtn.disabled = true;
      };

      // start recording and live visualization
      recorder.start();
      drawLiveWaveform(index); // starts animation loop until recording ends
    } catch (err) {
      console.error("Could not start recording:", err);
      recBtn.disabled = false;
      stopBtn.disabled = true;
      timelines[index].isRecording = false;
    }
  };

  // ==========================
  // STOP handler (per-track)
  // ==========================
  stopBtn.onclick = () => {
    const rec = timelines[index].recorder;
    if (rec && rec.state === "recording") {
      rec.stop();
    }
  };
}

// ==========================
// Live waveform drawing (during recording)
// uses analyser.getByteTimeDomainData
// ==========================
function drawLiveWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.isRecording) return;

  const { analyser, analyserData, canvas, ctx } = tl;
  const w = canvas.width;
  const h = canvas.height;

  function draw() {
    if (!tl.isRecording) return; // stop loop when recording finished

    analyser.getByteTimeDomainData(analyserData);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#0f0";
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

    requestAnimationFrame(draw);
  }
  // clear canvas before start
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, w, h);

  draw();
}

// ==========================
// Persistent waveform drawing from AudioBuffer
// drawPersistentWaveform(index)
// ==========================
function drawPersistentWaveform(index) {
  const tl = timelines[index];
  if (!tl || !tl.buffer) return;

  const buffer = tl.buffer;
  const canvas = tl.canvas;
  const ctx = tl.ctx;
  const w = canvas.width;
  const h = canvas.height;

  // take first channel (mono) or mix channels
  const channelData = buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array(0);
  const len = channelData.length;
  if (len === 0) {
    ctx.clearRect(0, 0, w, h);
    return;
  }

  // samples per pixel
  const samplesPerPixel = Math.max(1, Math.floor(len / w));
  ctx.clearRect(0, 0, w, h);

  // background
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, w, h);

  // waveform color
  ctx.fillStyle = "#8fc1ff";
  const mid = h / 2;

  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPixel;
    let min = 1.0;
    let max = -1.0;
    for (let j = 0; j < samplesPerPixel && (start + j) < len; j++) {
      const v = channelData[start + j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // store widthScale for potential future zoom
  tl.widthScale = 1;
}

// ==========================
// PLAY / SCHEDULER
// - we schedule BufferSource nodes to start at projectStartTime + timeline.startTime
// - this makes the global cursor playback match "cursor crossing" semantics
// ==========================
const masterPlayBtn = document.getElementById("masterPlay");
if (masterPlayBtn) {
  masterPlayBtn.addEventListener("click", async () => {
    if (isPlaying) return;
    await ensureAudioContextRunning();

    // clear any previous sources
    stopAllSources();

    isPlaying = true;
    projectStartTime = audioContext.currentTime + 0.05; // small delay for scheduling
    timelines.forEach((tl, idx) => {
      if (!tl || !tl.buffer) return;

      // create source
      const src = audioContext.createBufferSource();
      src.buffer = tl.buffer;

      // connect through a per-track gain (future per-track volume)
      const trackGain = audioContext.createGain();
      trackGain.gain.value = 1.0;
      src.connect(trackGain).connect(masterGain);

      // record active source for potential stopping
      tl.sourceNodes = tl.sourceNodes || [];
      tl.sourceNodes.push(src);

      // start at projectStartTime + tl.startTime
      const startAt = projectStartTime + Math.max(0, tl.startTime || 0);
      try {
        src.start(startAt);
      } catch (e) {
        console.warn("src.start error", e);
      }

      // cleanup when ended
      src.onended = () => {
        // remove from active list
        tl.sourceNodes = tl.sourceNodes.filter(s => s !== src);
      };
    });

    animateCursor();
  });
}

// Stop all active playback sources
function stopAllSources() {
  timelines.forEach(tl => {
    if (tl.sourceNodes && tl.sourceNodes.length) {
      tl.sourceNodes.forEach(src => {
        try {
          src.stop();
        } catch (e) {}
      });
      tl.sourceNodes = [];
    }
  });
  cancelAnimationFrame(animationId);
  animationId = null;
  isPlaying = false;
}

// allow stopping playback by clicking masterPlay again? we'll leave as simple: add a masterStop button handling if exists
const masterStopBtn = document.getElementById("masterStop");
if (masterStopBtn) {
  masterStopBtn.addEventListener("click", () => {
    stopAllSources();
    // clear cursor visually
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  });
}

// ==========================
// Cursor animation - shows current project time
// ==========================
function animateCursor() {
  if (!isPlaying) return;

  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

  const elapsed = audioContext.currentTime - projectStartTime; // seconds since play started
  const x = elapsed * PIXELS_PER_SECOND;

  // draw vertical cursor line
  cursorCtx.strokeStyle = "red";
  cursorCtx.lineWidth = 2;
  cursorCtx.beginPath();
  cursorCtx.moveTo(x, 0);
  cursorCtx.lineTo(x, cursorCanvas.height);
  cursorCtx.stroke();

  animationId = requestAnimationFrame(animateCursor);
}

// ==========================
// Utility: when a recording finished, ensure persistent waveform is visible
// ==========================
// (Already handled in recorder.onstop -> drawPersistentWaveform)

// ==========================
// Optional: set timeline start time by clicking on its canvas
// (so user can move where the recorded clip starts)
// ==========================
timelineContainer.addEventListener("click", (e) => {
  const target = e.target;
  if (target && target.classList && target.classList.contains("wave-canvas")) {
    // find which timeline index
    for (let i = 0; i < timelines.length; i++) {
      if (timelines[i].canvas === target) {
        // compute clicked time in seconds relative to canvas left
        const rect = target.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const newStartSeconds = clickX / PIXELS_PER_SECOND;
        timelines[i].startTime = Math.max(0, newStartSeconds);
        // optional: draw an indicator of startTime (not implemented here)
        break;
      }
    }
  }
});

