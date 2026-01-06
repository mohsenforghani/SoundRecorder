let mediaRecorder;
let audioChunks = [];
let audioBlob;
let audioUrl;
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let sourceNode;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const player = document.getElementById("player");
const echoEffect = document.getElementById("echoEffect");
const speedEffect = document.getElementById("speedEffect");

// ضبط صدا
startBtn.onclick = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!stream) throw new Error("Stream ساخته نشد");

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
            audioUrl = URL.createObjectURL(audioBlob);
            await playWithEffects(audioBlob);
            downloadBtn.disabled = false;
        };

        mediaRecorder.start();
        startBtn.disabled = true;
        stopBtn.disabled = false;
        console.log("ضبط شروع شد!");
    } catch (err) {
        console.error("خطا هنگام شروع ضبط:", err);
        alert("ضبط صدا امکان‌پذیر نیست. مطمئن شوید که:\n1. صفحه روی localhost یا HTTPS است\n2. اجازه دسترسی میکروفن داده شده است\n3. مرورگر MediaRecorder را پشتیبانی می‌کند");
    }
};

// توقف ضبط
stopBtn.onclick = () => {
    mediaRecorder.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
};

// دانلود
downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = "recording.wav";
    a.click();
};

// پخش با افکت
async function playWithEffects(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    if (sourceNode) sourceNode.disconnect();
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;

    let node = sourceNode;

    // افکت Echo
    if (echoEffect.checked) {
        const delay = audioContext.createDelay();
        delay.delayTime.value = 0.3; // 300ms
        node.connect(delay);
        delay.connect(audioContext.destination);
    }

    // تغییر سرعت
    if (speedEffect.checked) {
        sourceNode.playbackRate.value = 1.5;
    }

    node.connect(audioContext.destination);
    sourceNode.start();

    // برای نمایش در <audio> معمولی
    player.src = audioUrl;
}
