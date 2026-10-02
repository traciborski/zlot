import * as faceapi from './vendor/face-api.esm.js';

const MODEL_URL = './vendor/models';
const DB_NAME = 'zlot-faces';
const STORE = 'people';
const MAX_DESCRIPTORS = 20; // na osobę

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const video = $('#video');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');
const stage = document.querySelector('.stage');

const settings = {
  threshold: parseFloat(localStorage.getItem('threshold')) || 0.5,
  inputSize: parseInt(localStorage.getItem('inputSize'), 10) || 320,
};

let people = [];          // [{id, name, thumb, descriptors: Float32Array[]}]
let stream = null;
let facingMode = 'user';
let modelsReady = false;
let running = false;
let lastFaces = [];       // ostatnie wyniki detekcji (do dotknięcia ramki)
let wakeLock = null;

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

/* ---------- IndexedDB ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}

const toStored = (p) => ({ ...p, descriptors: p.descriptors.map((d) => Array.from(d)) });
const fromStored = (p) => ({ ...p, descriptors: p.descriptors.map((d) => new Float32Array(d)) });

async function loadPeople() {
  const all = await dbTx('readonly', (s) => s.getAll());
  people = all.map(fromStored).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  renderPeople();
}

async function savePerson(p) {
  await dbTx('readwrite', (s) => s.put(toStored(p)));
}

async function deletePerson(id) {
  await dbTx('readwrite', (s) => s.delete(id));
}

/* ---------- Rozpoznawanie ---------- */

function bestMatch(descriptor) {
  let best = null;
  let bestDist = Infinity;
  for (const p of people) {
    for (const d of p.descriptors) {
      const dist = faceapi.euclideanDistance(descriptor, d);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
  }
  if (best && bestDist <= settings.threshold) return { person: best, distance: bestDist };
  return { person: null, distance: bestDist };
}

function detectorOptions(inputSize = settings.inputSize) {
  return new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.5 });
}

async function addDescriptor(name, descriptor, thumb) {
  name = name.trim();
  let p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) {
    p = { id: crypto.randomUUID(), name, thumb, descriptors: [] };
    people.push(p);
    people.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  }
  p.descriptors.push(descriptor);
  if (p.descriptors.length > MAX_DESCRIPTORS) p.descriptors.shift();
  if (!p.thumb) p.thumb = thumb;
  await savePerson(p);
  renderPeople();
  return p;
}

function cropThumb(source, box, size = 160) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const m = Math.max(box.width, box.height) * 0.25;
  const side = Math.max(box.width, box.height) + 2 * m;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  c.getContext('2d').drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.8);
}

/* ---------- Kamera ---------- */

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    setStatus('Brak dostępu do kamery', 'err');
    alert('Nie udało się włączyć kamery: ' + e.message +
      '\n\nUpewnij się, że strona działa przez HTTPS i zezwoliłeś na dostęp do kamery.');
    return;
  }
  video.srcObject = stream;
  await video.play();
  stage.classList.toggle('mirror', facingMode === 'user');
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  $('#cam-placeholder').hidden = true;
  $('#btn-start').textContent = 'Stop';
  $('#btn-flip').disabled = false;
  $('#btn-snap').disabled = false;
  requestWakeLock();
  if (!running) loop();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  lastFaces = [];
  $('#cam-placeholder').hidden = false;
  $('#btn-start').textContent = 'Start';
  $('#btn-flip').disabled = true;
  $('#btn-snap').disabled = true;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* nieobsługiwane */ }
}

/* ---------- Pętla detekcji ---------- */

async function loop() {
  running = true;
  while (stream) {
    const liveVisible = $('#view-live').classList.contains('active') && !document.hidden;
    if (!modelsReady || !liveVisible || video.readyState < 2) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const t0 = performance.now();
    let results = [];
    try {
      results = await faceapi
        .detectAllFaces(video, detectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      console.error(e);
    }
    if (!stream) break;
    lastFaces = results.map((r) => ({
      box: r.detection.box,
      descriptor: r.descriptor,
      ...bestMatch(r.descriptor),
    }));
    draw(lastFaces);
    const ms = performance.now() - t0;
    const fps = 1000 / Math.max(ms, 1);
    setStatus(`${people.length} os. · ${fps < 10 ? fps.toFixed(1) : Math.round(fps)} kl/s`, 'ok');
    await new Promise((r) => requestAnimationFrame(r));
  }
  running = false;
}

// Współrzędne do rysowania (lustro dla przedniej kamery – sam obraz video jest odbity w CSS)
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
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const scale = overlay.width / 640;
  const lw = Math.max(2, 3 * scale);
  const fontSize = Math.max(14, Math.round(22 * scale));
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';

  for (const f of faces) {
    const b = displayBox(f.box);
    const color = f.person ? '#2fbf71' : '#f5a524';
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.width, b.height);

    const label = f.person
      ? `${f.person.name} ${Math.round((1 - f.distance) * 100)}%`
      : 'Nieznany';
    const pad = 6 * scale;
    const tw = ctx.measureText(label).width + pad * 2;
    const th = fontSize + pad * 2;
    const ly = b.y - th >= 0 ? b.y - th : b.y + b.height;
    const lx = Math.max(0, Math.min(b.x - lw / 2, overlay.width - tw));
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, tw, th);
    ctx.fillStyle = '#000';
    ctx.fillText(label, lx + pad, ly + pad);
  }
}

// Zamiana punktu dotknięcia na współrzędne obrazu (uwzględnia object-fit: cover)
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
  if (hit) openAddDialog(hit);
});

$('#btn-snap').addEventListener('click', () => {
  if (!lastFaces.length) {
    alert('Nie widzę żadnej twarzy w kadrze.');
    return;
  }
  const biggest = [...lastFaces].sort((a, b) => b.box.area - a.box.area)[0];
  openAddDialog(biggest);
});

function openAddDialog(face) {
  const descriptor = face.descriptor;
  const thumb = cropThumb(video, face.box);
  const dlg = $('#dlg-add');
  $('#dlg-thumb').src = thumb;
  $('#dlg-name').value = face.person ? face.person.name : '';
  $('#names').innerHTML = people.map((p) => `<option value="${escapeHtml(p.name)}">`).join('');
  dlg.onclose = async () => {
    const name = $('#dlg-name').value.trim();
    if (dlg.returnValue === 'ok' && name) {
      await addDescriptor(name, descriptor, thumb);
      setStatus(`Zapisano: ${name}`, 'ok');
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

$('#dlg-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#dlg-add').close('ok');
  }
});

/* ---------- Dodawanie ze zdjęć ---------- */

async function loadImage(file, maxSide = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('#add-files').addEventListener('change', (e) => {
  const n = e.target.files.length;
  $('#add-files-label').textContent = n ? `Wybrano zdjęć: ${n}` : 'Wybierz zdjęcia (najlepiej 3–5)';
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#add-msg');
  const name = $('#add-name').value.trim();
  const files = [...$('#add-files').files];
  if (!modelsReady) { msg.textContent = 'Modele jeszcze się ładują…'; msg.className = 'msg err'; return; }
  if (!name || !files.length) { msg.textContent = 'Podaj imię i wybierz zdjęcia.'; msg.className = 'msg err'; return; }

  let ok = 0;
  const skipped = [];
  for (const [i, file] of files.entries()) {
    msg.className = 'msg';
    msg.textContent = `Analizuję zdjęcie ${i + 1}/${files.length}…`;
    try {
      const canvas = await loadImage(file);
      const results = await faceapi
        .detectAllFaces(canvas, detectorOptions(608))
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (!results.length) { skipped.push(file.name); continue; }
      // Jeśli na zdjęciu jest kilka osób – bierzemy największą twarz
      const r = results.sort((a, b) => b.detection.box.area - a.detection.box.area)[0];
      await addDescriptor(name, r.descriptor, cropThumb(canvas, r.detection.box));
      ok++;
    } catch (err) {
      console.error(err);
      skipped.push(file.name);
    }
  }
  msg.className = ok ? 'msg ok' : 'msg err';
  msg.textContent = `Dodano ${ok} zdj. dla „${name}”.` +
    (skipped.length ? ` Bez twarzy: ${skipped.join(', ')}` : '');
  if (ok) {
    $('#add-form').reset();
    $('#add-files-label').textContent = 'Wybierz zdjęcia (najlepiej 3–5)';
  }
});

/* ---------- Lista osób ---------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPeople() {
  $('#people-count').textContent = people.length;
  const el = $('#people');
  if (!people.length) {
    el.innerHTML = '<p class="small" style="text-align:center">Brak osób. Dodaj kogoś ze zdjęć powyżej albo dotknij twarzy na podglądzie kamery.</p>';
    return;
  }
  el.innerHTML = people.map((p) => `
    <div class="person" data-id="${p.id}">
      <img src="${p.thumb || ''}" alt="">
      <div class="info">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="small">zdjęć: ${p.descriptors.length}${p.descriptors.length < 3 ? ' · dodaj więcej zdjęć' : ''}</div>
      </div>
      <button data-act="rename">✎</button>
      <button data-act="delete" class="danger">✕</button>
    </div>`).join('');
}

$('#people').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.person').dataset.id;
  const p = people.find((x) => x.id === id);
  if (!p) return;
  if (btn.dataset.act === 'delete' && confirm(`Usunąć „${p.name}”?`)) {
    await deletePerson(id);
    people = people.filter((x) => x.id !== id);
    renderPeople();
  } else if (btn.dataset.act === 'rename') {
    const name = prompt('Nowe imię:', p.name)?.trim();
    if (name) {
      p.name = name;
      await savePerson(p);
      people.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      renderPeople();
    }
  }
});

$('#btn-export').addEventListener('click', () => {
  const data = JSON.stringify({ app: 'zlot-faces', version: 1, people: people.map(toStored) });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `osoby-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'zlot-faces' || !Array.isArray(data.people)) throw new Error('Nieprawidłowy plik');
    let added = 0;
    for (const raw of data.people) {
      const incoming = fromStored(raw);
      const existing = people.find((x) => x.name.toLowerCase() === incoming.name.toLowerCase());
      if (existing) {
        existing.descriptors = [...existing.descriptors, ...incoming.descriptors].slice(-MAX_DESCRIPTORS);
        existing.thumb ||= incoming.thumb;
        await savePerson(existing);
      } else {
        incoming.id = crypto.randomUUID();
        people.push(incoming);
        await savePerson(incoming);
        added++;
      }
    }
    people.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    renderPeople();
    alert(`Zaimportowano. Nowych osób: ${added}.`);
  } catch (err) {
    alert('Błąd importu: ' + err.message);
  }
  e.target.value = '';
});

$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('Usunąć WSZYSTKIE osoby z tego telefonu?')) return;
  await dbTx('readwrite', (s) => s.clear());
  people = [];
  renderPeople();
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

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
  });
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
  loadPeople().catch((e) => console.error(e));
  try {
    const webgl = await faceapi.tf.setBackend('webgl').catch(() => false);
    if (!webgl) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
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
