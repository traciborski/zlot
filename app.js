import * as faceapi from './vendor/face-api.esm.js';

const MODEL_URL = './vendor/models';
const DB_NAME = 'zlot-photo';
const STORE = 'kv';
const LIVE_THRESHOLD = 0.5;   // próg dla dzisiejszego wyglądu (po potwierdzeniu)
const MAX_LIVE = 10;          // ile dzisiejszych ujęć pamiętamy na osobę

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const stage = document.querySelector('.stage');
const photoCanvas = $('#photo-canvas');
const frame = document.createElement('canvas'); // klatka z kamery (ew. w odcieniach szarości)

const settings = {
  threshold: parseFloat(localStorage.getItem('threshold')) || 0.62,
  inputSize: parseInt(localStorage.getItem('inputSize'), 10) || 416,
};

/**
 * project = {
 *   photo: dataURL, gray: bool,
 *   faces: [{ id, n, name, box, thumb, old: Float32Array, live: Float32Array[], nowThumb, found }],
 *   strangers: Float32Array[]   // osoby oznaczone jako „nie ma na zdjęciu”
 * }
 */
let project = null;
let photoImg = null;          // canvas z wczytanym zdjęciem (do wycinania)
const thumbCache = new Map(); // id -> HTMLImageElement (miniatury do rysowania na podglądzie)

let stream = null;
let facingMode = 'environment';
let modelsReady = false;
let running = false;
let lastFaces = [];
let wakeLock = null;

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const faceLabel = (f) => f.name || `Osoba ${f.n}`;

/* ---------- Zapis (IndexedDB) ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value === undefined) tx.objectStore(STORE).delete(key);
    else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const arr = (d) => Array.from(d);
const f32 = (a) => new Float32Array(a);

function serialize(p) {
  return {
    photo: p.photo,
    gray: p.gray,
    strangers: p.strangers.map(arr),
    faces: p.faces.map((f) => ({ ...f, old: arr(f.old), live: f.live.map(arr) })),
  };
}

function deserialize(s) {
  return {
    photo: s.photo,
    gray: !!s.gray,
    strangers: (s.strangers || []).map(f32),
    faces: s.faces.map((f) => ({ ...f, old: f32(f.old), live: (f.live || []).map(f32) })),
  };
}

async function saveProject() {
  await dbPut('project', project ? serialize(project) : undefined);
}

/* ---------- Obrazy ---------- */

async function imageFromSrc(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

// Wczytuje zdjęcie i skaluje: małe skany powiększa, wielkie zmniejsza.
async function loadPhotoCanvas(src) {
  const img = await imageFromSrc(src);
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  const target = Math.min(Math.max(long, 1600), 2400);
  const s = target / long;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Czarno-białe lub sepia: odcień jest wszędzie prawie taki sam (mała zmienność r-g i b-g).
function isGrayscale(canvas) {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(canvas, 0, 0, s, s);
  const d = cx.getImageData(0, 0, s, s).data;
  const n = s * s;
  let rg = 0, bg = 0, rg2 = 0, bg2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a1 = d[i] - d[i + 1];
    const b1 = d[i + 2] - d[i + 1];
    rg += a1; bg += b1; rg2 += a1 * a1; bg2 += b1 * b1;
  }
  const sd = (sum, sq) => Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
  return sd(rg, rg2) < 5 && sd(bg, bg2) < 5;
}

function toGray(canvas) {
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const img = cx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  cx.putImageData(img, 0, 0);
  return canvas;
}

function cropThumb(source, box, size = 160) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const m = Math.max(box.width, box.height) * 0.3;
  const side = Math.max(box.width, box.height) + 2 * m;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.85);
}

function getThumbImg(face) {
  let img = thumbCache.get(face.id);
  if (!img || img.dataset.src !== face.thumb) {
    img = new Image();
    img.src = face.thumb;
    img.dataset.src = face.thumb;
    thumbCache.set(face.id, img);
  }
  return img;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/* ---------- Analiza starego zdjęcia ---------- */

const overlap = (a, b) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return { iou: inter / (a.width * a.height + b.width * b.height - inter), cover: inter / minArea };
};

function subCanvas(src, x, y, w, h, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

const tinyOpts = (size, thr) => new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: thr });
const ssdOpts = (thr) => new faceapi.SsdMobilenetv1Options({ minConfidence: thr });

// Szuka twarzy kilkoma metodami (całe zdjęcie + kafelki), żeby złapać też małe twarze na zdjęciu grupowym.
async function findFaces(canvas, onProgress) {
  const found = [];
  const add = (dets, ox = 0, oy = 0, s = 1) => {
    for (const d of dets) {
      const b = d.box;
      found.push({ score: d.score, box: { x: ox + b.x / s, y: oy + b.y / s, width: b.width / s, height: b.height / s } });
    }
  };

  onProgress?.('Szukam twarzy…');
  add(await faceapi.detectAllFaces(canvas, tinyOpts(608, 0.4)));
  add(await faceapi.detectAllFaces(canvas, ssdOpts(0.4)));

  // kafelki 3x3 z zakładką
  const n = 3;
  const tw = (canvas.width / n) * 1.5;
  const th = (canvas.height / n) * 1.5;
  let k = 0;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      onProgress?.(`Szukam małych twarzy… ${++k}/${n * n}`);
      const x = Math.max(0, Math.min(canvas.width - tw, (tx * canvas.width) / n - (tw - canvas.width / n) / 2));
      const y = Math.max(0, Math.min(canvas.height - th, (ty * canvas.height) / n - (th - canvas.height / n) / 2));
      const s = Math.min(2, 800 / Math.max(tw, th));
      const tile = subCanvas(canvas, x, y, tw, th, s);
      add(await faceapi.detectAllFaces(tile, tinyOpts(608, 0.5)), x, y, s);
      add(await faceapi.detectAllFaces(tile, ssdOpts(0.5)), x, y, s);
    }
  }

  // łączenie duplikatów (NMS) + liczenie, ile wykryć potwierdza daną twarz
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found) {
    if (f.box.width < 12 || f.box.height < 12) continue;
    const dup = kept.find((k2) => { const o = overlap(k2.box, f.box); return o.iou > 0.3 || o.cover > 0.6; });
    if (dup) dup.votes++;
    else kept.push({ ...f, votes: 1 });
  }
  // odrzuć słabe pojedyncze wykrycia i ramki o rozmiarze zupełnie innym niż reszta twarzy
  let good = kept.filter((f) => f.votes >= 2 || f.score >= 0.75);
  const med = median(good.map((f) => f.box.width));
  if (good.length >= 3) good = good.filter((f) => f.box.width < med * 2.5 && f.box.width > med * 0.3);
  return good.map((f) => f.box);
}

// Liczy wektor twarzy dla podanej ramki (powiększa małe twarze przed analizą).
// To ten sam potok co w face-api: punkty twarzy → wyrównanie → sieć rozpoznawania.
async function describeBox(src, box) {
  const m = 0.4 * Math.max(box.width, box.height);
  const rx = Math.max(0, box.x - m);
  const ry = Math.max(0, box.y - m);
  const rw = Math.min(src.width, box.x + box.width + m) - rx;
  const rh = Math.min(src.height, box.y + box.height + m) - ry;
  const s = Math.max(1, 220 / Math.max(box.width, box.height));
  const c = subCanvas(src, rx, ry, rw, rh, s);
  const rect = new faceapi.Rect((box.x - rx) * s, (box.y - ry) * s, box.width * s, box.height * s);
  const [faceImg] = await faceapi.extractFaces(c, [rect]);
  const landmarks = (await faceapi.detectFaceLandmarks(faceImg)).shiftBy(rect.x, rect.y);
  const aligned = landmarks.align(null, { useDlibAlignment: true });
  const [alignedImg] = await faceapi.extractFaces(c, [aligned]);
  return faceapi.computeFaceDescriptor(alignedImg);
}

const newFace = (n, box, src, old) => ({
  id: crypto.randomUUID(), n, name: '', box, thumb: cropThumb(src, box), old, live: [], nowThumb: '', found: false,
});

async function analyzePhoto(file) {
  const msg = $('#photo-msg');
  msg.className = 'msg';
  try {
    const url = URL.createObjectURL(file);
    const canvas = await loadPhotoCanvas(url);
    URL.revokeObjectURL(url);
    const gray = isGrayscale(canvas);
    if (gray) toGray(canvas);

    const boxes = await findFaces(canvas, (t) => { msg.textContent = t; });
    // numeracja rzędami od góry, w rzędzie od lewej
    const medH = median(boxes.map((b) => b.height)) || 1;
    boxes.sort((a, b) => (Math.abs(a.y - b.y) < medH * 0.6 ? a.x - b.x : a.y - b.y));

    const faces = [];
    for (const [i, box] of boxes.entries()) {
      msg.textContent = `Analizuję twarze… ${i + 1}/${boxes.length}`;
      try {
        faces.push(newFace(faces.length + 1, box, canvas, await describeBox(canvas, box)));
      } catch (e) {
        console.warn('Pominięto twarz', e);
      }
      await nextFrame();
    }

    project = { photo: canvas.toDataURL('image/jpeg', 0.9), gray, faces, strangers: [] };
    photoImg = canvas;
    await saveProject();
    msg.className = 'msg ok';
    msg.textContent = `Znaleziono ${faces.length} twarzy` +
      (gray ? ' (zdjęcie czarno-białe – obraz z kamery też będzie analizowany w odcieniach szarości)' : '') +
      '. Brakuje kogoś? Dotknij jego twarzy na zdjęciu.';
    renderPhoto();
  } catch (e) {
    console.error(e);
    msg.className = 'msg err';
    msg.textContent = 'Nie udało się przeanalizować zdjęcia: ' + e.message;
  }
}

// Ręczne dodanie twarzy, której detektor nie znalazł.
async function addFaceAt(px, py) {
  const msg = $('#photo-msg');
  const size = median(project.faces.map((f) => f.box.width)) || Math.min(photoImg.width, photoImg.height) / 8;
  // najpierw spróbuj znaleźć twarz w okolicy dotknięcia z niższym progiem
  const area = size * 3;
  const ax = Math.max(0, px - area / 2);
  const ay = Math.max(0, py - area / 2);
  const aw = Math.min(photoImg.width - ax, area);
  const ah = Math.min(photoImg.height - ay, area);
  const s = Math.max(1, 400 / Math.max(aw, ah));
  const tile = subCanvas(photoImg, ax, ay, aw, ah, s);
  const dets = [
    ...(await faceapi.detectAllFaces(tile, tinyOpts(416, 0.2))),
    ...(await faceapi.detectAllFaces(tile, ssdOpts(0.2))),
  ];
  let box = null;
  let bestD = Infinity;
  for (const d of dets) {
    const b = { x: ax + d.box.x / s, y: ay + d.box.y / s, width: d.box.width / s, height: d.box.height / s };
    const dist = Math.hypot(b.x + b.width / 2 - px, b.y + b.height / 2 - py);
    if (dist < Math.max(b.width, size) && dist < bestD) { bestD = dist; box = b; }
  }
  if (!box) box = { x: px - size / 2, y: py - size * 0.55, width: size, height: size * 1.1 };
  if (project.faces.some((f) => overlap(f.box, box).cover > 0.5)) {
    msg.className = 'msg err';
    msg.textContent = 'Ta twarz jest już zaznaczona.';
    return;
  }
  try {
    const n = Math.max(0, ...project.faces.map((f) => f.n)) + 1;
    const face = newFace(n, box, photoImg, await describeBox(photoImg, box));
    project.faces.push(face);
    await saveProject();
    renderPhoto();
    openFaceDialog(face);
  } catch (e) {
    console.error(e);
    msg.className = 'msg err';
    msg.textContent = 'Nie udało się dodać twarzy w tym miejscu.';
  }
}

/* ---------- Widok zdjęcia ---------- */

function renderPhoto() {
  const has = !!project;
  $('#photo-wrap').hidden = !has;
  $('#photo-hint').hidden = !has;
  $('#summary').hidden = !has;
  $('#project-tools').hidden = !has;
  $('#photo-btn-label').textContent = has ? 'Wczytaj inne zdjęcie' : 'Wczytaj zdjęcie';
  $('#cam-placeholder-text').innerHTML = has
    ? 'Naciśnij <b>Start</b>, aby włączyć kamerę.'
    : 'Najpierw wczytaj zdjęcie grupowe w zakładce <b>Zdjęcie</b>.';
  if (!has) { $('#faces').innerHTML = ''; return; }

  // zdjęcie z numerami
  photoCanvas.width = photoImg.width;
  photoCanvas.height = photoImg.height;
  const g = photoCanvas.getContext('2d');
  g.drawImage(photoImg, 0, 0);
  const unit = median(project.faces.map((f) => f.box.width)) || 40;
  const lw = Math.max(2, unit / 25);
  const fs = Math.max(12, Math.round(unit * 0.38));
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const f of project.faces) {
    const b = f.box;
    const color = f.found ? '#2fbf71' : '#f5a524';
    g.lineWidth = lw;
    g.strokeStyle = color;
    g.strokeRect(b.x, b.y, b.width, b.height);
    const r = fs * 0.75;
    const cx = b.x + b.width / 2;
    const cy = Math.min(b.y + b.height + r + lw, photoCanvas.height - r);
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.fillText(String(f.n), cx, cy + 1);
  }

  const found = project.faces.filter((f) => f.found).length;
  $('#summary').innerHTML = `Znalezieni: <b>${found}</b> z <b>${project.faces.length}</b>`;

  const sorted = [...project.faces].sort((a, b) => a.n - b.n);
  $('#faces').innerHTML = sorted.map((f) => `
    <button class="face ${f.found ? 'found' : ''}" data-id="${f.id}">
      <span class="num">${f.n}</span>
      <span class="pics"><img src="${f.thumb}" alt="">${f.nowThumb ? `<img src="${f.nowThumb}" alt="">` : ''}</span>
      <span class="name">${escapeHtml(faceLabel(f))}</span>
      <span class="small">${f.found ? '✓ jest' : 'jeszcze nie'}</span>
    </button>`).join('');
}

$('#faces').addEventListener('click', (e) => {
  const el = e.target.closest('.face');
  if (el) openFaceDialog(project.faces.find((f) => f.id === el.dataset.id));
});

photoCanvas.addEventListener('click', (ev) => {
  if (!project || !modelsReady) return;
  const rect = photoCanvas.getBoundingClientRect();
  const s = photoCanvas.width / rect.width;
  const x = (ev.clientX - rect.left) * s;
  const y = (ev.clientY - rect.top) * s;
  const unit = median(project.faces.map((f) => f.box.width)) || 40;
  const hit = project.faces.find((f) => {
    const b = f.box;
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height + unit * 0.9;
  });
  if (hit) openFaceDialog(hit);
  else if (confirm('Dodać brakującą twarz w tym miejscu?')) addFaceAt(x, y);
});

function openFaceDialog(face) {
  if (!face) return;
  const dlg = $('#dlg-face');
  $('#face-then').src = face.thumb;
  $('#face-now').src = face.nowThumb || '';
  $('#face-now-fig').hidden = !face.nowThumb;
  $('#face-name').value = face.name;
  $('#face-name').placeholder = `Osoba ${face.n}`;
  $('#face-unfound').hidden = !face.found;
  const close = () => dlg.close();
  const commit = async () => {
    close();
    await saveProject();
    renderPhoto();
  };
  $('#face-save').onclick = () => {
    face.name = $('#face-name').value.trim();
    commit();
  };
  $('#face-cancel').onclick = close;
  $('#face-unfound').onclick = () => {
    Object.assign(face, { found: false, live: [], nowThumb: '' });
    commit();
  };
  $('#face-delete').onclick = () => {
    if (!confirm(`Usunąć twarz nr ${face.n} ze zdjęcia?`)) return;
    project.faces = project.faces.filter((f) => f !== face);
    commit();
  };
  dlg.showModal();
}

$('#face-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#face-save').click(); }
});

$('#photo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!modelsReady) { alert('Modele jeszcze się ładują, spróbuj za chwilę.'); return; }
  if (project && !confirm('Zastąpić obecne zdjęcie razem z imionami i dopasowaniami?')) return;
  await analyzePhoto(file);
});

/* ---------- Dopasowanie (kamera ↔ zdjęcie) ---------- */

function minDist(d, list) {
  let m = Infinity;
  for (const x of list) m = Math.min(m, faceapi.euclideanDistance(d, x));
  return m;
}

// Wynik ≤ 1 oznacza dopasowanie. Dzisiejszy wygląd (po potwierdzeniu) ma ostrzejszy próg.
function score(d, face) {
  const old = faceapi.euclideanDistance(d, face.old) / settings.threshold;
  const live = face.live.length ? minDist(d, face.live) / LIVE_THRESHOLD : Infinity;
  return { s: Math.min(old, live), confirmed: live <= old && live <= 1 };
}

// Każda osoba ze zdjęcia może być przypisana tylko jednej twarzy w kadrze
// (przydział zachłanny: najpierw najbardziej podobne pary).
function assign(descriptors) {
  const faces = project ? project.faces : [];
  const result = descriptors.map((d) => {
    const stranger = project?.strangers.length ? minDist(d, project.strangers) / LIVE_THRESHOLD : Infinity;
    const cands = faces.map((f) => ({ face: f, ...score(d, f) })).sort((a, b) => a.s - b.s);
    return { match: null, cands, stranger: stranger <= 1 && stranger < (cands[0]?.s ?? Infinity) };
  });
  const pairs = [];
  result.forEach((r, i) => {
    if (r.stranger) return;
    for (const c of r.cands) if (c.s <= 1) pairs.push({ i, ...c });
  });
  pairs.sort((a, b) => a.s - b.s);
  const used = new Set();
  for (const p of pairs) {
    if (result[p.i].match || used.has(p.face.id)) continue;
    result[p.i].match = p;
    used.add(p.face.id);
  }
  return result;
}

/* ---------- Kamera ---------- */

async function startCamera() {
  if (!project) {
    alert('Najpierw wczytaj zdjęcie grupowe w zakładce „Zdjęcie”.');
    return;
  }
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    setStatus('Brak dostępu do kamery', 'err');
    alert('Nie udało się włączyć kamery: ' + e.message +
      '\n\nUpewnij się, że strona działa przez HTTPS i zezwolono na dostęp do kamery.');
    return;
  }
  video.srcObject = stream;
  await video.play();
  stage.classList.toggle('mirror', facingMode === 'user');
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  $('#cam-placeholder').hidden = true;
  $('#btn-start').textContent = 'Stop';
  $('#btn-flip').disabled = false;
  requestWakeLock();
  if (!running) loop();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  lastFaces = [];
  $('#cam-placeholder').hidden = false;
  $('#btn-start').textContent = 'Start';
  $('#btn-flip').disabled = true;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* nieobsługiwane */ }
}

function grabFrame() {
  if (frame.width !== video.videoWidth || frame.height !== video.videoHeight) {
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
  }
  frame.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
  if (project?.gray) toGray(frame);
  return frame;
}

async function loop() {
  running = true;
  while (stream) {
    const visible = $('#view-live').classList.contains('active') && !document.hidden;
    if (!modelsReady || !visible || video.readyState < 2 || !project) {
      await sleep(200);
      continue;
    }
    const t0 = performance.now();
    let results = [];
    try {
      results = await faceapi
        .detectAllFaces(grabFrame(), tinyOpts(settings.inputSize, 0.5))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      console.error(e);
    }
    if (!stream) break;
    const matches = assign(results.map((r) => r.descriptor));
    lastFaces = results.map((r, i) => ({ box: r.detection.box, descriptor: r.descriptor, ...matches[i] }));
    draw(lastFaces);
    const fps = 1000 / Math.max(performance.now() - t0, 1);
    const found = project.faces.filter((f) => f.found).length;
    setStatus(`jest ${found}/${project.faces.length} · ${fps < 10 ? fps.toFixed(1) : Math.round(fps)} kl/s`, 'ok');
    await nextFrame();
  }
  running = false;
}

// Ramki rysujemy odbite dla przedniej kamery (sam obraz video jest odbity w CSS), tekst zostaje czytelny.
function displayBox(box) {
  const mirror = stage.classList.contains('mirror');
  const x = mirror ? video.videoWidth - box.x - box.width : box.x;
  return { x, y: box.y, width: box.width, height: box.height };
}

function draw(faces) {
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  const W = overlay.width;
  octx.clearRect(0, 0, W, overlay.height);
  const scale = W / 640;
  const lw = Math.max(2, 3 * scale);
  const fontSize = Math.max(14, Math.round(20 * scale));
  octx.font = `600 ${fontSize}px system-ui, sans-serif`;
  octx.textBaseline = 'top';

  for (const f of faces) {
    const b = displayBox(f.box);
    let color = '#f5a524';
    let label = 'Nie wiadomo';
    if (f.match) {
      color = f.match.confirmed ? '#2fbf71' : '#3b9eff';
      label = `${f.match.face.n}. ${faceLabel(f.match.face)}${f.match.confirmed ? ' ✓' : '?'}`;
    } else if (f.stranger) {
      color = '#8b95a1';
      label = 'Spoza zdjęcia';
    }
    octx.lineWidth = lw;
    octx.strokeStyle = color;
    octx.strokeRect(b.x, b.y, b.width, b.height);

    const pad = 5 * scale;
    const tw = octx.measureText(label).width + pad * 2;
    const th = fontSize + pad * 2;
    const ly = b.y - th >= 0 ? b.y - th : b.y + b.height;
    const lx = Math.max(0, Math.min(b.x - lw / 2, W - tw));
    octx.fillStyle = color;
    octx.fillRect(lx, ly, tw, th);
    octx.fillStyle = '#000';
    octx.fillText(label, lx + pad, ly + pad);

    // miniatura twarzy ze starego zdjęcia obok ramki
    if (f.match) {
      const img = getThumbImg(f.match.face);
      const ts = Math.max(48 * scale, b.height * 0.55);
      let tx = b.x + b.width + lw;
      if (tx + ts > W) tx = b.x - ts - lw;
      if (img.complete && img.naturalWidth) {
        octx.drawImage(img, tx, b.y, ts, ts);
        octx.strokeRect(tx, b.y, ts, ts);
      }
    }
  }
}

// Punkt dotknięcia → współrzędne obrazu (uwzględnia object-fit: cover)
function eventToVideoPoint(ev) {
  const rect = overlay.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.max(rect.width / vw, rect.height / vh);
  const ox = (rect.width - vw * s) / 2;
  const oy = (rect.height - vh * s) / 2;
  return { x: (ev.clientX - rect.left - ox) / s, y: (ev.clientY - rect.top - oy) / s };
}

overlay.addEventListener('click', (ev) => {
  if (!stream || !lastFaces.length) return;
  const pt = eventToVideoPoint(ev);
  const hit = lastFaces.find((f) => {
    const b = displayBox(f.box);
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  });
  if (hit) openWhoDialog(hit);
});

function openWhoDialog(face) {
  const dlg = $('#dlg-who');
  const descriptor = face.descriptor;
  const nowThumb = cropThumb(video, face.box);
  $('#who-now').src = nowThumb;

  const confirmAs = async (target) => {
    dlg.close();
    if (!target) return;
    // ta sama dzisiejsza twarz nie może pasować do dwóch osób – usuń podobne ujęcia z innych
    for (const f of project.faces) {
      if (f !== target) f.live = f.live.filter((d) => faceapi.euclideanDistance(d, descriptor) > 0.35);
    }
    project.strangers = project.strangers.filter((d) => faceapi.euclideanDistance(d, descriptor) > 0.35);
    target.live.push(descriptor);
    if (target.live.length > MAX_LIVE) target.live.shift();
    target.nowThumb ||= nowThumb;
    target.found = true;
    await saveProject();
    renderPhoto();
    setStatus(`Zapisano: ${faceLabel(target)}`, 'ok');
  };

  const top = face.cands.slice(0, 3);
  $('#who-candidates').innerHTML = top.map((c, i) => `
    <button class="cand" data-i="${i}">
      <img src="${c.face.thumb}" alt="">
      <span class="name">${c.face.n}. ${escapeHtml(faceLabel(c.face))}</span>
      <span class="small">${c.s <= 1 ? 'pasuje' : 'mniej podobny'}${c.face.found ? ' · już jest' : ''}</span>
    </button>`).join('');
  $('#who-candidates').onclick = (e) => {
    const b = e.target.closest('.cand');
    if (b) confirmAs(top[Number(b.dataset.i)].face);
  };

  const sel = $('#who-select');
  sel.innerHTML = '<option value="">Inna osoba ze zdjęcia…</option>' +
    [...project.faces].sort((a, b) => a.n - b.n)
      .map((f) => `<option value="${f.id}">${f.n}. ${escapeHtml(faceLabel(f))}${f.found ? ' ✓' : ''}</option>`).join('');
  sel.onchange = () => confirmAs(project.faces.find((f) => f.id === sel.value));

  $('#who-stranger').onclick = async () => {
    dlg.close();
    project.strangers.push(descriptor);
    if (project.strangers.length > 200) project.strangers.shift();
    await saveProject();
  };
  $('#who-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

/* ---------- Eksport / import ---------- */

$('#btn-export').addEventListener('click', () => {
  const data = JSON.stringify({ app: 'zlot-photo', version: 2, project: serialize(project) });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `zlot-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'zlot-photo' || !data.project) throw new Error('To nie jest plik z tej aplikacji');
    if (project && !confirm('Zastąpić obecne zdjęcie danymi z pliku?')) return;
    project = deserialize(data.project);
    photoImg = await loadPhotoCanvas(project.photo);
    await saveProject();
    renderPhoto();
  } catch (err) {
    alert('Błąd importu: ' + err.message);
  }
});

$('#btn-reset-found').addEventListener('click', async () => {
  if (!confirm('Wyczyścić wszystkie dopasowania (imiona zostaną)?')) return;
  for (const f of project.faces) Object.assign(f, { found: false, live: [], nowThumb: '' });
  project.strangers = [];
  await saveProject();
  renderPhoto();
});

$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('Usunąć zdjęcie, imiona i dopasowania z tego telefonu?')) return;
  stopCamera();
  project = null;
  photoImg = null;
  await saveProject();
  renderPhoto();
});

/* ---------- Ustawienia ---------- */

function bindSetting(id, key, fmt) {
  const input = $('#' + id);
  const out = $('#' + id + '-val');
  input.value = settings[key];
  out.textContent = fmt(settings[key]);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = fmt(settings[key]);
    localStorage.setItem(key, input.value);
  });
}
bindSetting('thr', 'threshold', (v) => v.toFixed(2));
bindSetting('size', 'inputSize', (v) => `${v}px`);

/* ---------- Nawigacja ---------- */

function showView(name) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

$('#btn-start').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
$('#btn-flip').addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  startCamera();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stream) requestWakeLock();
});

/* ---------- Start ---------- */

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
  }
  try {
    const saved = await dbGet('project');
    if (saved) {
      project = deserialize(saved);
      photoImg = await loadPhotoCanvas(project.photo);
    }
  } catch (e) {
    console.error(e);
  }
  renderPhoto();
  showView(project ? 'live' : 'photo');

  try {
    const webgl = await faceapi.tf.setBackend('webgl').catch(() => false);
    if (!webgl) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsReady = true;
    setStatus('Gotowe', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Błąd ładowania modeli', 'err');
  }
}

init();
