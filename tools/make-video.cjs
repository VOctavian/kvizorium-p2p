// Records a short WebM clip for the test pack (no ffmpeg needed): run with Electron.
//   npx electron tools/make-video.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = path.join(__dirname, "media", "planets.webm");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("data:text/html,<canvas id=c width=640 height=360></canvas>");
  const b64 = await win.webContents.executeJavaScript(`new Promise((done) => {
    const c = document.getElementById("c"), g = c.getContext("2d");
    const planets = [["#ffb38a", 120, 34, 0.9], ["#43f0c4", 70, 18, 1.6], ["#8a7bff", 170, 24, 0.6]];
    let t = 0;
    const draw = () => {
      t += 1 / 30;
      g.fillStyle = "#0c1030"; g.fillRect(0, 0, 640, 360);
      g.fillStyle = "#ffd27a"; g.beginPath(); g.arc(320, 180, 40, 0, 7); g.fill();
      for (const [col, r, size, sp] of planets) {
        g.strokeStyle = "rgba(255,255,255,.15)"; g.beginPath(); g.ellipse(320, 180, r * 1.4, r * 0.8, 0, 0, 7); g.stroke();
        g.fillStyle = col; g.beginPath(); g.arc(320 + Math.cos(t * sp) * r * 1.4, 180 + Math.sin(t * sp) * r * 0.8, size / 2, 0, 7); g.fill();
      }
      g.fillStyle = "#eef1ff"; g.font = "bold 22px sans-serif"; g.fillText("Сколько планет на видео?", 20, 340);
    };
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 600000 });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    rec.onstop = async () => {
      const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      done(btoa(s));
    };
    const timer = setInterval(draw, 1000 / 30);
    draw(); rec.start(); setTimeout(() => { rec.stop(); clearInterval(timer); }, 4000);
  })`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(1)} КБ`);
  app.quit();
});
