// ==========================
// Web Audio DAW - app.js
// ==========================

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);

// کنترل ولوم اصلی
document.getElementById("masterVolume").oninput = e => {
  masterGain.gain.value = e.target.value;
};

const timelineContainer = document.getElementById("timelineContainer");
const cursorCanvas = document.getElementById("masterCursor");
const cursorCtx = cursorCanvas.getContext("2d");

cursorCanvas.width = window.innerWidth;
cursorCanvas.height = window.innerHeight;

const TIMELINE_COUNT = 10;
const timelines = [];

let isPlaying = false;
let projectStartTime = 0;
let animationId = null;

// ==========================
// ساخت تایم‌لاین‌ها
// ==========================
for (let i = 0; i < TIMELINE_COUNT; i++) {
  createTimeline(i);
}

function createTimeline(index) {
  const el = document.createElement("div");
  el.className = "timeline";

  el.innerHTML = `
    <div class="timeline-header">
      <button class="rec">● REC</button>
      <button class="stop" disabled>■ STOP</button>
    </div>
    <canvas></canvas>
  `;

  const canvas = el.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = timelineContainer.clientWidth - 40;
  canvas.height = 60;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  timelines[index] = {
    buffer: null,
    startTime: 0,
    analyser,
    isRecording: false
  };

  let recorder;
  let chunks = [];

  const recBtn = el.querySelector(".rec");
  const stopBtn = el.querySelector(".stop");

  // ==========================
  // ضبط صدا
  // ==========================
  recBtn.onclick = async () => {
    try {
      recBtn.disabled = true;
      stopBtn.disabled = false;

      chunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContext.createMediaStreamSource(stream);

      source.connect(analyser);
      source.connect(masterGain);

      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);

      recorder.onstop = async () => {
        const blob = new Blob(chunks);
        const arrayBuffer = await blob.arrayBuffer();
        timelines[index].buffer = await audioContext.decodeAudioData(arrayBuffer);

        recBtn.disabled = false;
        stopBtn.disabled = true;
        timelines[index].isRecording = false;
      };

      recorder.start();
      timelines[index].isRecording = true;
      drawEQ(analyser, ctx);
    } catch (err) {
      console.error("خطا در گرفتن میکروفون:", err);
      recBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };

  stopBtn.onclick = () => {
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }
  };

  timelineContainer.appendChild(el);
}

// ==========================
// اکولایزر زنده تایم‌لاین
// ==========================
function drawEQ(analyser, ctx) {
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    data.forEach((v, i) => {
      ctx.fillStyle = "#888";
      ctx.fillRect(i * 3, ctx.canvas.height, 2, -v);
    });

    if (isAnyRecording()) {
      requestAnimationFrame(draw);
    }
  }
  draw();
}

// چک کردن اینکه آیا هنوز ضبطی در جریان است
function isAnyRecording() {
  return timelines.some(tl => tl.isRecording);
}

// ==========================
// پخش سراسری
// ==========================
document.getElementById("masterPlay").onclick = () => {
  if (isPlaying) return;

  isPlaying = true;
  projectStartTime = audioContext.currentTime;

  timelines.forEach(tl => {
    if (!tl.buffer) return;

    const src = audioContext.createBufferSource();
    src.buffer = tl.buffer;

    const gain = audioContext.createGain();
    src.connect(gain).connect(masterGain);

    src.start(projectStartTime + tl.startTime);
  });

  animateCursor();
};

// ==========================
// Cursor سراسری
// ==========================
function animateCursor() {
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

  const elapsed = audioContext.currentTime - projectStartTime;
  const pixelsPerSecond = 100;
  const x = elapsed * pixelsPerSecond;

  cursorCtx.strokeStyle = "red";
  cursorCtx.beginPath();
  cursorCtx.moveTo(x, 0);
  cursorCtx.lineTo(x, cursorCanvas.height);
  cursorCtx.stroke();

  animationId = requestAnimationFrame(animateCursor);
}
