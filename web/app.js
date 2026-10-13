/* Vigía · Casco Inteligente · visor. Logica movida tal cual desde index.html; cambios de presentacion marcados con [UI]. */
(() => {
  const $ = id => document.getElementById(id);
  const cfg = window.CASCO_CONFIG || {};
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let audioCtx = null, channel = null, chOrders = null, chGeo = null, escTimer = null;
  const TZ = 'America/Argentina/Buenos_Aires';
  const fmt = iso => new Date(iso).toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' });

  // dd/mm/aaaa HH:mm en hora de Argentina (reportes y CSV)
  const fmtAR = iso => {
    const d = new Date(iso); if (isNaN(d)) return '';
    const p = {};
    new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
  };
  const mb = b => (b / 1048576).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' MB';
  const stampOf = d => {
    const p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day + '_' + p.hour + '-' + p.minute + '-' + p.second;
  };
  // Descarga con gesto del usuario (un solo lugar para los <a download>).
  const saveUrl = (url, name) => { const a = document.createElement('a'); a.href = url; a.download = name; a.hidden = true; document.body.append(a); a.click(); a.remove(); };

  // Columnas explicitas (nunca select('*')): el visor solo recibe lo que usa.
  const EV_COLS = 'id,created_at,device_id,type,press_ms,media_path,lat,lng,battery,payload';
  const ACK_COLS = 'event_id,acked_by_email,acked_at,note';
  const SIG_COLS = 'id,call_id,from_role,kind,payload,created_at';
  const isAuthErr = e => !!e && (e.status === 401 || e.code === 'PGRST301' || e.code === 'PGRST303' || /jwt expired|invalid jwt|jwt.*expir/i.test(String(e.message || '')));

  async function mediaEl(path, type, desc) {
    const { data, error } = await sb.storage.from('casco-media').createSignedUrl(path, 600);
    if (error || !data) return null;
    const el = document.createElement(type === 'video' ? 'video' : 'img');
    el.className = 'media'; el.src = data.signedUrl;
    const d = desc || (type === 'video' ? 'Video del casco' : 'Foto del casco');
    if (type === 'video') { el.controls = true; el.setAttribute('aria-label', d); } else el.alt = d;
    return el;
  }

  const cards = new Map();    // event_id -> <li>
  const pending = new Map();  // event_id -> ev (SOS/caida sin atender)
  const acks = new Map();     // event_id -> ack

  // ---- Video en vivo propio (WHEP contra MediaMTX en LIVE_HOST; ver docs/PROTOCOLO-VIDEO.md) ----
  // Sin LIVE_HOST se oculta el panel de video propio.
  const LIVE_HOST = String(cfg.LIVE_HOST || '').trim();
  const OWN_LIVE = !!LIVE_HOST;
  const DEV_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  const RETRY_WINDOW_MS = 120000;  // ante una alerta el casco tarda en publicar (RTMP, auth, relay de audio)
  const RESTART_EVERY_MS = 20000, RESTART_MAX = 4;   // reenvia 'start' mientras espera (tope: 4 reenvios)
  const lives = new Map();         // device_id -> panel
  const devOf = new Map();         // event_id -> device_id
  const evAt = new Map();          // event_id -> created_at [UI: regla de estacion del historial]
  let token = null;
  let manualLogout = false;
  // Salud de la conexion con las alertas: canal Realtime caido, ultima lectura fallida o sin internet.
  let rtDown = false, syncFail = false, netOff = typeof navigator !== 'undefined' && navigator.onLine === false, connWasDown = false;
  const connDown = () => rtDown || syncFail || netOff;
  sb.auth.onAuthStateChange((e, s) => {
    token = s ? s.access_token : null;
    if ((e === 'TOKEN_REFRESHED' || e === 'SIGNED_IN') && s) clearExpired();   // sesion recuperada: baja el aviso de "vencida"
    if (e === 'TOKEN_REFRESHED' && s) { try { sb.realtime.setAuth(s.access_token); } catch (_) {} }
    else if (e === 'SIGNED_OUT' && !manualLogout) setTimeout(sessionExpired, 0);
  });
  async function getToken() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) token = data.session.access_token;
    return token;
  }
  // ---- Auto-orientacion: ultimo payload.rot de heartbeat por casco (docs/PROTOCOLO-VOZ.md seccion 1) ----
  const AUTO_OFF = Number(cfg.AUTO_ROT_OFFSET) || 0;
  const norm90 = d => ((Math.round(d / 90) * 90) % 360 + 360) % 360;
  const rotOf = new Map();         // device_id -> { at, rot }
  function noteRot(id, at, payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.rot !== 'number' || !isFinite(payload.rot)) return;
    const cur = rotOf.get(id);
    if (cur && new Date(at) < new Date(cur.at)) return;
    rotOf.set(id, { at, rot: norm90(payload.rot) });
    const L = lives.get(id); if (L && L.applyRot) L.applyRot();
  }
  async function loadRot(id) {
    try {
      const { data } = await sb.from('events').select('created_at,payload').eq('device_id', id).eq('type', 'heartbeat')
        .order('created_at', { ascending: false }).limit(10);
      if (data) for (const e of data) noteRot(id, e.created_at, e.payload);
    } catch (_) {}
  }
  const hangupAll = () => lives.forEach(L => L.leave && L.leave());
  window.addEventListener('pagehide', hangupAll);
  window.addEventListener('beforeunload', hangupAll);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  // ---- [UI] Iconos (trazo unico), regla de estacion ----
  const ICONS = {
    sos: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18v.01"/>',
    fall: '<circle cx="14" cy="4.5" r="2"/><path d="M12 8l-4 3 2 4-3 5M12 8l4 2 3-1M10 15l4 1 1 5"/>',
    geofence: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><path d="M12 7v4M12 13.5v.01"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    not_worn: '<path d="M3 16a9 9 0 0 1 18 0v2H3z"/><path d="M4 4l16 16"/>',
    inactive: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  };
  function icon(name, size) {
    const s = mk('span', 'ico'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return s;
  }
  const RULE_WARN_MIN = 2;   // la zona > 2 min se tine del color de severidad
  function ruleEl(done) {
    const box = mk('div', 'rulebox' + (done ? ' done' : '')); box.setAttribute('aria-hidden', 'true');
    const rule = mk('div', 'rule'); rule.append(mk('span', 'rule-zone'), mk('span', 'rule-fill'), mk('span', 'rule-cursor'));
    const sc = mk('div', 'rule-scale'); sc.append(mk('span', 's0', '0'), mk('span', 's2', '2 min'), mk('span', 'sn', ''));
    box.append(rule, sc);
    return box;
  }
  function ruleSet(box, minutes) {
    const m = Math.max(0, minutes), n = Math.max(5, Math.ceil(m) + 1);
    box.style.setProperty('--n', String(n)); box.style.setProperty('--e', m.toFixed(3));
    box.querySelector('.sn').textContent = n + ' min';
    box.querySelector('.rule').classList.toggle('over', m > RULE_WARN_MIN);
  }

  function gathered(pc, ms) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const done = () => { pc.removeEventListener('icegatheringstatechange', on); clearTimeout(t); res(); };
      const on = () => { if (pc.iceGatheringState === 'complete') done(); };
      const t = setTimeout(done, ms);
      pc.addEventListener('icegatheringstatechange', on);
    });
  }

  function ensureLive(id) {
    if (!OWN_LIVE || !DEV_RE.test(id)) return null;
    if (lives.has(id)) return lives.get(id);
    const sec = mk('section', 'card live');
    sec.setAttribute('aria-label', 'Video en vivo del casco ' + id);
    sec.append(dlEl('h2', id, 'Video en vivo · '));
    const row = mk('div', 'row');
    const bStart = mk('button', '', 'Iniciar'); bStart.type = 'button';
    const bStop = mk('button', 'ghost', 'Detener'); bStop.type = 'button'; bStop.disabled = true;
    const state = mk('span', 'state', 'Detenido'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    const stats = mk('span', 'mute');
    const bRetry = mk('button', 'attend hidden', 'Reintentar'); bRetry.type = 'button';
    bRetry.setAttribute('aria-label', 'Reintentar la conexión de video con el casco ' + id);
    const bTalk = mk('button', '', 'Hablar'); bTalk.type = 'button';
    bTalk.setAttribute('aria-label', 'Hablar con el casco ' + id + ' (llamada de voz en vivo)');
    row.append(bStart, bStop, bTalk, state, bRetry, stats);
    if (cfg.VOICE_ENABLED === false) bTalk.classList.add('hidden');   // voz en vivo apagada hasta desplegar TURN/senalizacion
    const video = mk('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
    video.setAttribute('aria-label', 'Video en vivo del casco ' + id);
    // Contenedor que rota la imagen (la camara del casco esta montada a 90/180 grados).
    const wrap = mk('div', 'vwrap hidden'); wrap.append(video);
    const ROT_KEY = 'casco-rot-' + id;
    let rot = 0;
    try { const s = localStorage.getItem(ROT_KEY); rot = s !== null ? Number(s) : Number(cfg.LIVE_ROTATION || 0); } catch (_) { rot = Number(cfg.LIVE_ROTATION || 0); }
    if (![0, 90, 180, 270].includes(rot)) rot = 0;
    // Modo Auto (por defecto): giro = rot del ultimo heartbeat + AUTO_ROT_OFFSET. Manual: `rot` (boton Girar), por casco.
    const MODE_KEY = 'casco-mode-' + id;
    let auto = true;
    try { auto = localStorage.getItem(MODE_KEY) !== 'manual'; } catch (_) {}
    const curRot = () => { const k = rotOf.get(id); return auto && k ? norm90(k.rot + AUTO_OFF) : rot; };
    const applyRot = () => {
      const r = curRot();
      wrap.dataset.rot = String(r); wrap.style.setProperty('--r', r + 'deg');
      bRot.textContent = 'Girar (' + (auto ? 'Auto' : 'Manual') + ' ' + r + '°)';
      bAuto.textContent = auto ? 'Auto (activo)' : 'Auto';
      bAuto.setAttribute('aria-pressed', String(auto));
    };
    const saveRot = () => { try { localStorage.setItem(ROT_KEY, String(rot)); localStorage.setItem(MODE_KEY, auto ? 'auto' : 'manual'); } catch (_) {} };
    const bRot = mk('button', 'ghost', 'Girar'); bRot.type = 'button';
    bRot.setAttribute('aria-label', 'Girar la imagen del casco ' + id + ' 90 grados (pasa a modo manual)');
    bRot.addEventListener('click', () => { rot = (curRot() + 90) % 360; auto = false; applyRot(); saveRot(); });
    const bAuto = mk('button', 'ghost', 'Auto'); bAuto.type = 'button';
    bAuto.setAttribute('aria-label', 'Orientación automática de la imagen del casco ' + id);
    bAuto.addEventListener('click', () => { auto = true; applyRot(); saveRot(); });
    row.append(bRot, bAuto);
    // Recorte opcional para ocultar el texto que el procesador de camara del casco graba en la imagen (TM/ID/BT/TP/SS).
    // Fracciones del cuadro original; funciona con object-view-box (Chrome/Edge). Por casco, se recuerda.
    const CROP = Object.assign({ left: 0, top: 0, right: 0, bottom: 0 }, cfg.OVERLAY_CROP || {});
    const hasCrop = !!(CROP.left || CROP.top || CROP.right || CROP.bottom);
    const CROP_KEY = 'casco-crop2-' + id;
    let cropOn = hasCrop;
    try { const s = localStorage.getItem(CROP_KEY); if (s !== null) cropOn = s === '1'; } catch (_) {}
    const bCrop = mk('button', 'ghost', ''); bCrop.type = 'button';
    const cv = mk('canvas', 'hidden'); cv.setAttribute('aria-hidden', 'true'); wrap.insertBefore(cv, video.nextSibling);
    const ctx = cv.getContext('2d');
    let cropRect = { l: 0, t: 0, r: 0, b: 0 }, drawing = false;
    const useCanvas = () => cropOn && hasCrop;
    const drawLoop = () => {
      if (!useCanvas()) { drawing = false; return; }
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        const sx = Math.round(vw * cropRect.l), sy = Math.round(vh * cropRect.t);
        const sw = Math.max(1, Math.round(vw * (1 - cropRect.l - cropRect.r))), sh = Math.max(1, Math.round(vh * (1 - cropRect.t - cropRect.b)));
        if (cv.width !== sw || cv.height !== sh) { cv.width = sw; cv.height = sh; }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(drawLoop); else requestAnimationFrame(drawLoop);
    };
    const applyCrop = () => {
      const f = v => Math.max(0, Math.min(0.6, Number(v) || 0));
      cropRect = { l: f(CROP.left), t: f(CROP.top), r: f(CROP.right), b: f(CROP.bottom) };
      const on = useCanvas();
      video.classList.toggle('vsrc', on);
      cv.classList.toggle('hidden', !on);
      if (on && !drawing) { drawing = true; drawLoop(); }
      bCrop.textContent = 'Ocultar datos de la imagen: ' + (cropOn ? 'sí' : 'no');
      bCrop.setAttribute('aria-pressed', String(cropOn));
    };
    bCrop.addEventListener('click', () => { cropOn = !cropOn; try { localStorage.setItem(CROP_KEY, cropOn ? '1' : '0'); } catch (_) {} applyCrop(); });
    if (hasCrop) { row.append(bCrop); applyCrop(); }
    // Pantalla completa: se pone el contenedor (no el <video>) para conservar el giro de la imagen.
    const bFull = mk('button', 'ghost', 'Pantalla completa'); bFull.type = 'button';
    bFull.setAttribute('aria-label', 'Ver el video del casco ' + id + ' en pantalla completa');
    const bExit = mk('button', 'fsexit', 'Salir de pantalla completa'); bExit.type = 'button';
    wrap.append(bExit);
    const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
    const enterFs = () => {
      const f = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (f) return f.call(wrap);
      if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();   // iOS Safari
    };
    const exitFs = () => (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    bFull.addEventListener('click', () => { try { fsEl() === wrap ? exitFs() : enterFs(); } catch (_) {} });
    bExit.addEventListener('click', () => { try { exitFs(); } catch (_) {} });
    wrap.addEventListener('dblclick', () => { try { fsEl() === wrap ? exitFs() : enterFs(); } catch (_) {} });
    row.append(bFull);
    // Sonido del casco (audio del video en vivo). El <video> nace silenciado (autoplay); tras el gesto de "Iniciar"
    // se enciende solo si el usuario no lo apagó antes (preferencia por navegador).
    const SOUND_KEY = 'casco-sound';
    let soundOn = true;
    try { soundOn = localStorage.getItem(SOUND_KEY) !== '0'; } catch (_) {}
    const bSound = mk('button', 'ghost', ''); bSound.type = 'button';
    const hasAudio = () => !!(video.srcObject && video.srcObject.getAudioTracks().length);
    const syncSound = () => {
      bSound.textContent = 'Sonido del casco: ' + (soundOn ? 'sí' : 'no');
      bSound.setAttribute('aria-pressed', String(soundOn));
      bSound.setAttribute('aria-label', 'Escuchar el audio del casco ' + id + ': ' + (soundOn ? 'encendido' : 'apagado'));
      bSound.classList.toggle('hidden', !hasAudio());
      video.muted = !(soundOn && hasAudio());
    };
    bSound.addEventListener('click', () => {
      soundOn = !soundOn;
      try { localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch (_) {}
      syncSound();
      if (!video.muted) video.play().catch(() => { video.muted = true; });
    });
    row.append(bSound);
    syncSound();
    applyRot();
    // Fila de voz: se muestra solo durante una llamada (ver bloque "Voz en vivo" mas abajo).
    const vrow = mk('div', 'voice hidden');
    const vstate = mk('span', 'state', ''); vstate.setAttribute('role', 'status'); vstate.setAttribute('aria-live', 'polite');
    const vtime = mk('span', 'mute');
    const vline = mk('span', 'vline'); vline.append(vstate, ' ', vtime);
    const bMute = mk('button', 'ghost', 'Silenciar'); bMute.type = 'button'; bMute.setAttribute('aria-pressed', 'false');
    bMute.setAttribute('aria-label', 'Silenciar mi micrófono en la llamada con el casco ' + id);
    const bHang = mk('button', 'attend', 'Colgar'); bHang.type = 'button';
    bHang.setAttribute('aria-label', 'Colgar la llamada con el casco ' + id);
    const meter = lbl => { const m = mk('meter'); m.min = 0; m.max = 1; m.value = 0; m.setAttribute('aria-label', lbl); return m; };
    const mMic = meter('Nivel de mi micrófono'), mIn = meter('Nivel del audio del casco');
    const lMic = mk('span', 'mute', 'Mi voz'), lIn = mk('span', 'mute', 'Casco');
    const remote = mk('audio'); remote.autoplay = true; remote.hidden = true;
    remote.setAttribute('aria-label', 'Audio del casco ' + id);
    vrow.append(vline, bMute, bHang, lMic, mMic, lIn, mIn, remote);
    // Grabacion a la PC / captura (docs/PROTOCOLO-CENTRO.md seccion 5). La logica va mas abajo, despues de crear L.
    const rrow = mk('div', 'row rec');
    const bRec = mk('button', '', 'Grabar'); bRec.type = 'button'; bRec.disabled = true;
    bRec.setAttribute('aria-label', 'Grabar el video del casco ' + id + ' en mi PC');
    const bShot = mk('button', 'ghost', 'Captura'); bShot.type = 'button'; bShot.disabled = true;
    bShot.setAttribute('aria-label', 'Guardar una captura de la imagen del casco ' + id + ' como PNG');
    const bAgain = mk('button', 'ghost hidden', 'Descargar de nuevo'); bAgain.type = 'button';
    const chk = (txt, on) => { const l = mk('label', 'chk'); const i = mk('input'); i.type = 'checkbox'; i.checked = on; l.append(i, txt); return [l, i]; };
    const [lMicRec, cMic] = chk('Incluir mi micrófono', true), [lCasRec, cCasco] = chk('Incluir audio del casco', true);
    const recState = mk('span', 'state', ''); recState.setAttribute('role', 'status'); recState.setAttribute('aria-live', 'polite');
    const recTime = mk('span', 'mute', '');
    const recNote = mk('p', 'mute', ''); recNote.style.margin = '0';
    rrow.append(bRec, bShot, bAgain, lMicRec, lCasRec, recTime, recState);
    sec.append(row, rrow, recNote, cmdBar(id), vrow, wrap);
    $('lives').append(sec); $('lives').classList.remove('hidden');

    const L = { id, sec, bStart, bStop, gen: 0, pc: null, loc: null, statsTimer: null };
    L.syncSound = syncSound;
    const setState = (t, bad) => { state.textContent = t; state.classList.toggle('bad', !!bad); };
    const base = 'https://' + LIVE_HOST + '/live/' + encodeURIComponent(id) + '/whep';

    function closePc() {
      clearInterval(L.statsTimer); L.statsTimer = null; stats.textContent = '';
      if (L.recLost) L.recLost('Se cortó el video: se guardó lo grabado hasta ese momento.');
      L.ms = null; if (L.recReady) L.recReady(false);
      if (L.pc) { L.pc.onconnectionstatechange = null; L.pc.ontrack = null; try { L.pc.close(); } catch (_) {} L.pc = null; }
    }
    async function deleteSession() {   // WHEP: DELETE sobre el Location devuelto
      const loc = L.loc; L.loc = null; if (!loc) return;
      try { await fetch(loc, { method: 'DELETE', headers: { Authorization: 'Bearer ' + await getToken() }, keepalive: true }); } catch (_) {}
    }
    function fail(msg) { closePc(); setState('Error: ' + msg, true); bStart.disabled = false; bStop.disabled = true; bRetry.classList.remove('hidden'); }

    async function whepOnce(gen) {
      const tok = await getToken();
      if (!tok) throw Object.assign(new Error('sin sesión'), { fatal: true });
      const pc = new RTCPeerConnection({ iceServers: STUN });
      L.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });   // audio del casco si el servidor lo ofrece (el video se muestra silenciado)
      pc.ontrack = e => {   // una sola MediaStream con video (+ audio si llega)
        if (!L.ms) L.ms = new MediaStream();
        L.ms.addTrack(e.track);
        if (video.srcObject !== L.ms) video.srcObject = L.ms;
        if (e.track.kind === 'video') { wrap.classList.remove('hidden'); if (L.recReady) L.recReady(true); }
        if (L.syncSound) { L.syncSound(); if (!video.muted) video.play().catch(() => { video.muted = true; L.syncSound(); }); }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, 2000);
      if (gen !== L.gen) throw Object.assign(new Error('cancelado'), { fatal: true });
      let res;
      try {
        res = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      } catch (e) { throw new Error('sin conexión con el servidor'); }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('sin sesión o sin permiso para ver el video (' + res.status + ')'), { fatal: true });
      if (res.status !== 201 && !res.ok) throw new Error('el servidor respondió ' + res.status);
      const loc = res.headers.get('Location');
      if (loc) L.loc = new URL(loc, base).href;
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      await new Promise((ok, ko) => {
        const t = setTimeout(() => ko(new Error('sin medios (ICE)')), 10000);
        const chk = () => {
          if (pc.connectionState === 'connected') { clearTimeout(t); ok(); }
          else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { clearTimeout(t); ko(new Error('conexión fallida')); }
        };
        pc.onconnectionstatechange = chk; chk();
      });
    }

    function watch(gen) {
      L.pc.onconnectionstatechange = () => {
        const s = L.pc && L.pc.connectionState;
        if ((s === 'failed' || s === 'closed') && gen === L.gen) { setState('Reconectando…'); closePc(); deleteSession().then(() => run(gen)); }
      };
      L.statsTimer = setInterval(async () => {
        if (!L.pc || !L.pc.getStats) return;
        try {
          const rep = await L.pc.getStats(); const out = [];
          rep.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameWidth) out.push(r.frameWidth + '×' + r.frameHeight + (r.framesPerSecond ? ' · ' + Math.round(r.framesPerSecond) + ' fps' : ''));
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) out.push('RTT ' + Math.round(r.currentRoundTripTime * 1000) + ' ms');
          });
          if (gen === L.gen) stats.textContent = out.join(' · ');
        } catch (_) {}
      }, 2000);
    }

    async function run(gen) {
      const t0 = Date.now(), deadline = t0 + RETRY_WINDOW_MS;
      let n = 0, last = '', resent = 0, lastStart = t0;
      const tick = () => { if (gen === L.gen) setState('Esperando al casco… ' + Math.floor((Date.now() - t0) / 1000) + ' s'); };
      const timer = setInterval(tick, 1000);
      try {
        while (gen === L.gen) {
          tick();
          if (resent < RESTART_MAX && Date.now() - lastStart >= RESTART_EVERY_MS) {   // el casco pudo quedar colgado: se le pide arrancar de nuevo
            lastStart = Date.now(); resent++;
            try { sb.from('stream_commands').insert({ device_id: id, action: 'start' }).then(() => {}, () => {}); } catch (_) {}
          }
          try { await whepOnce(gen); if (gen !== L.gen) return; setState('En vivo'); watch(gen); return; }
          catch (e) {
            closePc();
            if (gen !== L.gen) return;
            if (e.fatal) { fail(e.message); return; }
            last = e.message;
          }
          if (Date.now() > deadline) { fail('el casco no respondió en ' + Math.round(RETRY_WINDOW_MS / 1000) + ' s (' + last + '). Revisá que tenga señal y tocá Reintentar'); return; }
          await sleep(Math.min(1000 * ++n, 3000));   // 404 "sin stream": el casco todavia no publico; reintento corto
        }
      } finally { clearInterval(timer); }
    }

    L.isLive = () => !!(L.pc && L.ms && L.pc.connectionState === 'connected');
    L.start = async () => {
      const gen = ++L.gen;
      closePc();   // reinicia el ciclo en un clic: se cierra cualquier intento anterior
      bRetry.classList.add('hidden');
      bStart.disabled = true; bStop.disabled = false;
      setState('Solicitando…');
      const { error } = await sb.from('stream_commands').insert({ device_id: id, action: 'start' });
      if (gen !== L.gen) return;
      if (error) { fail('no se pudo solicitar: ' + error.message); return; }
      run(gen);
    };
    L.stop = async () => {
      L.gen++;
      bStart.disabled = false; bStop.disabled = true;
      closePc(); video.srcObject = null; wrap.classList.add('hidden'); bRetry.classList.add('hidden');
      setState('Deteniendo…');
      await deleteSession();
      const { error } = await sb.from('stream_commands').insert({ device_id: id, action: 'stop' });
      if (error) setState('Error: no se pudo enviar stop: ' + error.message, true); else setState('Detenido');
    };
    bStart.addEventListener('click', L.start);
    bStop.addEventListener('click', L.stop);
    L.applyRot = applyRot;

    // ---- Grabacion a la PC (video + audio) y captura PNG (docs/PROTOCOLO-CENTRO.md seccion 5) ----
    // Lienzo con el giro y el recorte vigentes + marca -> captureStream(15) -> MediaRecorder; el audio se mezcla con Web Audio.
    const WATERMARK = cfg.REC_WATERMARK !== false;
    const REC_MAX_S = 60 * 60, REC_WARN_S = 45 * 60, REC_MAX_BYTES = 1e9;
    const AC = window.AudioContext || window.webkitAudioContext;
    const canRec = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
    const MIMES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let rec = null, lastUrl = null, lastName = '', lastItem = null;
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    let wmSec = 0, wmTxt = '';
    const wmText = () => {
      const s = Math.floor(Date.now() / 1000);
      if (s !== wmSec) { wmSec = s; wmTxt = 'Vigía · Casco ' + id + ' · ' + new Date().toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }); }
      return wmTxt;
    };
    const frameInfo = () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (useCanvas()) {   // mismo recorte que el visor
        sx = Math.round(vw * cropRect.l); sy = Math.round(vh * cropRect.t);
        sw = Math.max(1, Math.round(vw * (1 - cropRect.l - cropRect.r))); sh = Math.max(1, Math.round(vh * (1 - cropRect.t - cropRect.b)));
      }
      const r = curRot(), q = r === 90 || r === 270;
      return { sx, sy, sw, sh, r, cw: q ? sh : sw, ch: q ? sw : sh };
    };
    const paint = (c2, W, H, f) => {
      c2.fillStyle = '#000'; c2.fillRect(0, 0, W, H);
      const k = Math.min(W / f.cw, H / f.ch);   // encaja si el giro cambia durante la grabacion
      c2.save(); c2.translate(W / 2, H / 2); c2.rotate(f.r * Math.PI / 180); c2.scale(k, k);
      c2.drawImage(video, f.sx, f.sy, f.sw, f.sh, -f.sw / 2, -f.sh / 2, f.sw, f.sh);
      c2.restore();
      if (WATERMARK) {
        const fs = Math.max(12, Math.round(H * 0.035)), pad = Math.round(fs * 0.4), t = wmText();
        c2.font = '600 ' + fs + 'px system-ui, "Segoe UI", sans-serif'; c2.textBaseline = 'top';
        const w = c2.measureText(t).width;
        c2.fillStyle = 'rgba(0,0,0,.6)'; c2.fillRect(0, H - fs - pad * 2, w + pad * 2, fs + pad * 2);
        c2.fillStyle = '#fff'; c2.fillText(t, pad, H - fs - pad);
      }
    };
    const save = saveUrl;
    const setRec = (t, bad) => { recState.textContent = t; recState.classList.toggle('bad', !!bad); };
    const audioOn = () => cMic.checked || cCasco.checked;
    const refreshNote = () => {
      const src = cMic.checked && cCasco.checked ? 'de tu micrófono y del casco' : cMic.checked ? 'de tu micrófono' : cCasco.checked ? 'del casco' : '';
      recNote.textContent = 'La grabación se guarda solo en tu PC; la plataforma no conserva copias. ' +
        (src ? 'Esta grabación incluye audio ' + src + '. ' : 'Esta grabación no incluye audio. ') + 'Informá al personal.';
    };
    const liveNow = () => !!(L.ms && L.pc);
    refreshNote();
    cMic.addEventListener('change', refreshNote); cCasco.addEventListener('change', refreshNote);
    if (!canRec) {
      setRec('Este navegador no permite grabar video (falta MediaRecorder). Probá con Chrome, Edge o Firefox actualizados.', true);
    }

    // Mezcla las pistas de audio disponibles: audio del casco (video en vivo y llamada) y mi microfono si hay llamada.
    function syncAudio(r) {
      if (!r.dest) return;
      const want = new Set();
      const live = t => t && t.readyState !== 'ended';
      if (cCasco.checked) {
        [video.srcObject, remote.srcObject].forEach(ms => {
          if (ms && ms.getAudioTracks) ms.getAudioTracks().forEach(t => { if (live(t)) want.add(t); });
        });
      }
      const c = L.call, micT = new Set();
      if (cMic.checked && c && !c.ended && c.stream) c.stream.getAudioTracks().forEach(t => { if (live(t)) { want.add(t); micT.add(t); } });
      // Microfono de la PC propio de la grabacion: solo entra al grabador (nunca a un altavoz: sin eco).
      if (cMic.checked && r.mic) r.mic.getAudioTracks().forEach(t => { if (live(t)) { want.add(t); micT.add(t); } });
      for (const [t, node] of r.srcs) if (!want.has(t)) { try { node.disconnect(); } catch (_) {} r.srcs.delete(t); }
      for (const t of want) {
        if (r.srcs.has(t)) continue;
        try { const n = r.actx.createMediaStreamSource(new MediaStream([t])); n.connect(r.dest); r.srcs.set(t, n); } catch (_) {}
      }
      let mic = false, cas = 0;
      for (const t of r.srcs.keys()) { if (micT.has(t)) mic = true; else cas++; }
      if (mic) r.hadMic = true;
      if (cas > 0) r.hadCas = true;
      const noMic = cMic.checked && !mic && !(c && !c.ended && c.stream) ? ' · sin micrófono: ' + (r.micErr ? 'permiso pendiente' : 'no disponible') : '';
      r.audioLbl = (cas > 0 && mic ? 'audio: casco y micrófono' : cas > 0 ? 'audio: casco' : mic ? 'audio: micrófono' : 'audio: sin fuentes por ahora') + noMic;
    }
    const recStatus = r => (r.auto ? 'REC automático por alerta · ' : '') + 'Grabando · ' + (r.dest ? r.audioLbl || 'audio' : 'solo video (sin audio)') + (r.warned ? ' · aviso: tope a los 60 min' : '');
    const dispose = r => {
      clearInterval(r.tDraw); clearInterval(r.tTick); clearInterval(r.tSync);
      r.srcs.forEach(n => { try { n.disconnect(); } catch (_) {} });
      if (r.actx) { try { r.actx.close(); } catch (_) {} }
      try { r.out.getTracks().forEach(t => t.stop()); } catch (_) {}
      if (r.mic) { try { r.mic.getTracks().forEach(t => t.stop()); } catch (_) {} }
    };
    function finish(r) {
      if (r.done) return;
      r.done = true; dispose(r);
      if (rec === r) rec = null;
      cMic.disabled = false; cCasco.disabled = false;
      bRec.textContent = 'Grabar'; bRec.setAttribute('aria-label', 'Grabar el video del casco ' + id + ' en mi PC');
      bRec.disabled = !(canRec && liveNow());
      recTime.textContent = ''; recTime.className = 'mute';
      const blob = new Blob(r.chunks, { type: r.type });
      if (!blob.size) { setRec('No se grabó nada.', true); return; }
      // La URL anterior solo se libera si su cartel ya se cerro (si sigue en cola, la libera el propio cartel).
      if (lastItem && lastItem.closed && lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (_) {} }
      const url = URL.createObjectURL(blob), name = 'vigia-' + id + '_' + stampOf(new Date(r.t0)) + '.' + r.ext;
      lastUrl = url; lastName = name;
      bAgain.classList.remove('hidden');
      setRec((r.why || 'Grabación detenida.') + ' Video listo: ' + name + ' (' + mb(blob.size) + '). Guardalo desde el cartel.', r.bad);
      // El archivo NO se descarga solo: el cartel de guardado pide el gesto del usuario y muestra cualquier error.
      const item = lastItem = {
        devId: id, who: personOf.get(id) || '', dur: Math.max(0, Math.round((Date.now() - r.t0) / 1000)), size: blob.size, name, url,
        why: r.why || '', bad: !!r.bad, auto: !!r.auto, closed: false,
        discard: () => { if (lastUrl === url) { lastUrl = null; bAgain.classList.add('hidden'); } },
        release: () => { if (lastUrl !== url) { try { URL.revokeObjectURL(url); } catch (_) {} } },
        audio: r.hadMic && r.hadCas ? 'Esta grabación incluye audio de tu micrófono y del casco. Informá al personal.'
          : r.hadMic ? 'Esta grabación incluye audio de tu micrófono. Informá al personal.'
          : r.hadCas ? 'Esta grabación incluye audio del casco' + (r.micWanted ? ' (sin micrófono: ' + (r.micErr ? 'permiso pendiente' : 'no disponible') + ')' : '') + '. Informá al personal.'
          : 'Esta grabación no incluye audio. Informá al personal.',
      };
      enqueueSave(item);
    }
    function stopRec(why, bad) {
      const r = rec; if (!r || r.stopping) return;
      r.stopping = true; r.why = why; r.bad = !!bad;
      bRec.disabled = true;
      clearInterval(r.tDraw); clearInterval(r.tTick); clearInterval(r.tSync);
      try { if (r.mr.state !== 'inactive') r.mr.stop(); else finish(r); } catch (_) { finish(r); }
    }
    let starting = false;
    async function startRec(auto) {
      if (rec || starting || !canRec) return;
      if (!frameInfo()) { if (!auto) setRec('Todavía no hay imagen del casco para grabar.', true); return; }
      // Microfono de la PC (mezclado con el audio del casco). Sin permiso o con error: se graba igual solo con el casco.
      const micWanted = cMic.checked;
      if (micWanted && !auto && !(L.call && !L.call.ended) && (await micPermState()) === 'denied') showMicHelp();
      let mic = null, micErr = '';
      if (micWanted && !(L.call && !L.call.ended && L.call.stream)) {
        starting = true;
        const m = await acquireMic(); starting = false;
        if (m.ms) mic = m.ms; else micErr = m.err || 'error';
      }
      const undo = () => { if (mic) { try { mic.getTracks().forEach(t => t.stop()); } catch (_) {} } };
      if (rec || !canRec) { undo(); return; }
      const f = frameInfo();
      if (!f) { undo(); if (!auto) setRec('Todavía no hay imagen del casco para grabar.', true); return; }
      const k0 = Math.min(1, 1280 / Math.max(f.cw, f.ch));
      const W = even(f.cw * k0), H = even(f.ch * k0);
      const cvr = document.createElement('canvas'); cvr.width = W; cvr.height = H;
      const c2 = cvr.getContext('2d');
      paint(c2, W, H, f);
      const r = { out: null, chunks: [], bytes: 0, t0: Date.now(), srcs: new Map(), warned: false, actx: null, dest: null, audioLbl: '', auto: !!auto, mic, micErr, micWanted, hadMic: false, hadCas: false };
      try { r.out = cvr.captureStream(15); } catch (_) { undo(); setRec('No se pudo preparar la grabación en este navegador.', true); return; }
      if (audioOn() && AC) {
        try {
          r.actx = new AC();
          if (r.actx.state === 'suspended' && r.actx.resume) r.actx.resume();
          r.dest = r.actx.createMediaStreamDestination();
          r.dest.stream.getAudioTracks().forEach(t => r.out.addTrack(t));
        } catch (_) { if (r.actx) { try { r.actx.close(); } catch (__) {} } r.actx = null; r.dest = null; }
      }
      const mime = MIMES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
      try { r.mr = mime ? new MediaRecorder(r.out, { mimeType: mime, videoBitsPerSecond: 2500000 }) : new MediaRecorder(r.out); }
      catch (e) { dispose(r); undo(); setRec('El navegador no pudo iniciar la grabación (' + ((e && e.name) || 'error') + ').', true); return; }
      r.type = String(r.mr.mimeType || mime || 'video/webm').split(';')[0];
      r.ext = /mp4/.test(r.type) ? 'mp4' : 'webm';
      r.mr.ondataavailable = e => { if (e.data && e.data.size) { r.chunks.push(e.data); r.bytes += e.data.size; } };
      r.mr.onstop = () => finish(r);
      r.mr.onerror = () => stopRec('Falló el grabador: se conservó lo grabado.', true);
      rec = r;
      cMic.disabled = true; cCasco.disabled = true;
      bRec.textContent = 'Detener grabación'; bRec.setAttribute('aria-label', 'Detener la grabación del casco ' + id + ' y abrir el cartel para guardarla');
      bAgain.classList.add('hidden');
      syncAudio(r);
      const tick = () => {
        const el = Math.floor((Date.now() - r.t0) / 1000);
        recTime.className = 'recdot'; recTime.textContent = (r.auto ? '● REC automático por alerta ' : '● REC ') + clock(el) + ' · ' + mb(r.bytes);
        if (!r.warned && el >= REC_WARN_S) { r.warned = true; recState.textContent = recStatus(r); }
        if (el >= REC_MAX_S || r.bytes >= REC_MAX_BYTES) stopRec('Se llegó al tope (60 min o 1 GB): se conservó lo grabado.', false);
      };
      tick();
      setRec(recStatus(r));
      r.tDraw = setInterval(() => { const g = frameInfo(); if (g) paint(c2, W, H, g); }, 66);
      r.tTick = setInterval(tick, 500);
      r.tSync = setInterval(() => { syncAudio(r); if (!r.stopping) { const t = recStatus(r); if (recState.textContent !== t) recState.textContent = t; } }, 1000);
      try { r.mr.start(1000); } catch (_) { stopRec('No se pudo iniciar la grabación.', true); }
    }
    bRec.addEventListener('click', () => { if (rec) stopRec('Grabación detenida.', false); else startRec(false); });
    bAgain.addEventListener('click', () => { if (!lastUrl) return; try { save(lastUrl, lastName); } catch (e) { setRec('No se pudo descargar: ' + ((e && e.message) || 'el navegador bloqueó la descarga') + '.', true); } });
    const snapBlob = () => new Promise(res => {
      const f = frameInfo(); if (!f) return res(null);
      const c2 = document.createElement('canvas'); c2.width = f.cw; c2.height = f.ch;
      paint(c2.getContext('2d'), f.cw, f.ch, f);
      c2.toBlob(b => res(b), 'image/png');
    });
    bShot.addEventListener('click', async () => {
      const b = await snapBlob();
      if (!b) { setRec('Todavía no hay imagen del casco para capturar.', true); return; }
      const url = URL.createObjectURL(b), name = 'vigia-' + id + '_' + stampOf(new Date()) + '.png';
      save(url, name); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setRec('Captura guardada en tu PC: ' + name);
    });
    L.hasFrame = () => liveNow() && !!frameInfo();
    L.snap = async () => { const b = await snapBlob(); return b ? { blob: b, name: 'vigia-' + id + '_' + stampOf(new Date()) + '.png' } : null; };
    L.recReady = ok => { bShot.disabled = !ok; if (!rec) bRec.disabled = !(ok && canRec); if (ok) autoRecSync(); };
    L.recLost = why => { if (rec && !rec.stopping) stopRec(why, true); };
    L.isRecording = () => !!rec;
    // Grabacion automatica ante SOS / caida: arranca sola si el video ya reproduce (sin microfono del supervisor).
    L.autoRec = () => { if (rec || starting) return true; if (!canRec || !liveNow() || !frameInfo()) return false; startRec(true); return true; };
    ['loadedmetadata', 'playing'].forEach(t => video.addEventListener(t, autoRecSync));   // el primer cuadro llega despues del track
    L.stopAuto = why => { if (rec && rec.auto && !rec.stopping) stopRec(why, false); };

    // ---- Voz en vivo (WebRTC solo audio; senalizacion por public.rtc_signals, docs/PROTOCOLO-VOZ.md seccion 2) ----
    const vctl = [bMute, bHang, lMic, mMic, lIn, mIn];
    const setCtl = on => vctl.forEach(e => e.classList.toggle('hidden', !on));
    const setV = (t, bad) => { vstate.textContent = t; vstate.classList.toggle('bad', !!bad); };
    const soft = m => Object.assign(new Error(m), { soft: true });
    L.call = null;

    async function sendSignal(callId, kind, payload) {
      try {
        const { error } = await sb.from('rtc_signals').insert({ device_id: id, call_id: callId, kind, payload: payload || {} });
        return error || null;
      } catch (e) { return e; }
    }
    function endCall(c, text, bad, notify) {
      if (!c || c.ended) return;
      c.ended = true;
      if (L.call === c) L.call = null;
      clearTimeout(c.tAns); clearTimeout(c.tMax); clearInterval(c.tTick); clearInterval(c.tPoll); clearInterval(c.tLvl);
      if (c.ch) { try { sb.removeChannel(c.ch); } catch (_) {} }
      if (notify && c.offerSent) sendSignal(c.callId, 'hangup', {});
      if (c.pc) { c.pc.onconnectionstatechange = null; c.pc.oniceconnectionstatechange = null; c.pc.ontrack = null; c.pc.onicecandidate = null; try { c.pc.close(); } catch (_) {} }
      if (c.stream) c.stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      if (c.actx) { try { c.actx.close(); } catch (_) {} }
      remote.srcObject = null;
      mMic.value = 0; mIn.value = 0; vtime.textContent = '';
      setCtl(false);
      setV(text, bad);
      bTalk.disabled = false;
    }
    async function turnServers(tok) {
      const url = cfg.SUPABASE_URL + '/functions/v1/turn-credentials';
      const h = { Authorization: 'Bearer ' + tok, apikey: cfg.SUPABASE_ANON_KEY };
      let r;
      try {
        r = await fetch(url, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
        if (r.status === 405) r = await fetch(url, { headers: h });
      } catch (_) { throw soft('sin conexión con el servidor de voz'); }
      if (!r.ok) throw soft('no se pudieron obtener las credenciales de voz (' + r.status + ')');
      let j; try { j = await r.json(); } catch (_) { j = null; }
      if (!j || !j.urls || !j.username || !j.credential) throw soft('credenciales de voz inválidas');
      return [{ urls: j.urls, username: j.username, credential: j.credential }];
    }
    function level(an, buf) {
      an.getByteTimeDomainData(buf);
      let s = 0; for (const v of buf) { const d = (v - 128) / 128; s += d * d; }
      return Math.min(1, Math.sqrt(s / buf.length) * 4);
    }
    function meterOf(c, stream, meterEl) {
      try {
        c.actx = c.actx || new (window.AudioContext || window.webkitAudioContext)();
        const an = c.actx.createAnalyser(); an.fftSize = 256;
        c.actx.createMediaStreamSource(stream).connect(an);   // sin conectar al destino: no duplica el audio
        c.meters.push([an, new Uint8Array(an.fftSize), meterEl]);
      } catch (_) {}
    }
    function onSignal(c, r) {
      if (c.ended || !r || r.call_id !== c.callId || r.from_role !== 'device' || c.seen.has(r.id)) return;
      c.seen.add(r.id);
      const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
      if (r.kind === 'answer') {
        if (c.gotAnswer || typeof p.sdp !== 'string') return;
        c.gotAnswer = true; clearTimeout(c.tAns);
        c.tAns = setTimeout(() => endCall(c, 'Error: no se pudo establecer el audio', true, true), 20000);
        c.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).then(() => {
          c.remoteSet = true; c.iceIn.splice(0).forEach(addIce(c));
        }).catch(() => endCall(c, 'Error: respuesta inválida del casco', true, true));
      } else if (r.kind === 'ice') {
        if (typeof p.candidate !== 'string') return;
        if (c.remoteSet) addIce(c)(p); else c.iceIn.push(p);
      } else if (r.kind === 'hangup') endCall(c, 'Colgada por el casco', false, false);
      else if (r.kind === 'busy') endCall(c, 'Error: el casco está ocupado en otra llamada', true, false);
    }
    const addIce = c => p => { try { c.pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex }).catch(() => {}); } catch (_) {} };
    function onConn(c) {
      if (c.ended || !c.pc) return;
      const s = c.pc.connectionState || c.pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        c.conn = true;
        if (!c.t0) {
          c.t0 = Date.now(); clearTimeout(c.tAns);
          const tick = () => { vtime.textContent = clock((Date.now() - c.t0) / 1000); };
          setV('En llamada'); tick(); c.tTick = setInterval(tick, 1000);
        } else setV('En llamada');
      } else if (s === 'disconnected') { c.conn = false; setV('Reconectando…'); }
      else if (s === 'failed') endCall(c, 'Error: se perdió la conexión de audio', true, true);
    }
    async function startCall() {
      if (L.call) return;
      const c = L.call = { callId: crypto.randomUUID(), seen: new Set(), sentIce: new Set(), iceIn: [], icePend: [], meters: [], offerSent: false, remoteSet: false, muted: false, ended: false };
      bTalk.disabled = true; vrow.classList.remove('hidden'); setCtl(true); vtime.textContent = '';
      bMute.textContent = 'Silenciar'; bMute.setAttribute('aria-pressed', 'false');
      setV('Conectando…');
      try {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || !window.RTCPeerConnection)
          throw soft('este navegador no permite llamadas de voz (hace falta HTTPS)');
        if ((await micPermState()) === 'denied') { showMicHelp(); throw soft('permiso de micrófono denegado: seguí los pasos del cartel'); }
        try {
          c.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
          const n = e && e.name;
          if (n === 'NotAllowedError' || n === 'SecurityError') showMicHelp();
          throw soft(micMsg(n));
        }
        if (c.ended) { c.stream.getTracks().forEach(t => t.stop()); return; }
        const tok = await getToken();
        if (!tok) throw soft('sin sesión');
        const iceServers = await turnServers(tok);
        if (c.ended) return;
        const pc = c.pc = new RTCPeerConnection({ iceServers });
        c.stream.getAudioTracks().forEach(t => pc.addTrack(t, c.stream));
        pc.ontrack = e => {
          const s = (e.streams && e.streams[0]) || new MediaStream([e.track]);
          remote.srcObject = s;
          try { const pl = remote.play(); if (pl && pl.catch) pl.catch(() => {}); } catch (_) {}
          if (!c.remoteMeter) { c.remoteMeter = true; meterOf(c, s, mIn); }
        };
        pc.onicecandidate = e => {
          if (!e.candidate) return;
          const cand = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
          if (c.sentIce.has(cand.candidate)) return;   // sin duplicados (limite 60 filas/min por llamada)
          c.sentIce.add(cand.candidate);
          if (c.offerSent) sendSignal(c.callId, 'ice', cand); else c.icePend.push(cand);
        };
        pc.onconnectionstatechange = () => onConn(c);
        pc.oniceconnectionstatechange = () => onConn(c);
        meterOf(c, c.stream, mMic);
        c.tLvl = setInterval(() => { for (const [an, buf, el] of c.meters) el.value = c.muted && el === mMic ? 0 : level(an, buf); }, 100);
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc, 1500);
        if (c.ended) return;
        const sdp = pc.localDescription.sdp; c.icePend = [];   // lo ya juntado viaja dentro de la oferta
        c.ch = sb.channel('rtc-' + id + '-' + c.callId)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rtc_signals', filter: 'device_id=eq.' + id }, p => onSignal(c, p.new))
          .subscribe();
        const err = await sendSignal(c.callId, 'offer', { sdp });
        if (c.ended) { sendSignal(c.callId, 'hangup', {}); return; }   // colgaron mientras se enviaba la oferta
        if (err) throw soft('no se pudo enviar la llamada: ' + (err.message || 'error'));
        c.offerSent = true;
        c.icePend.splice(0).forEach(k => sendSignal(c.callId, 'ice', k));
        c.tAns = setTimeout(() => endCall(c, 'Error: el casco no respondió (25 s)', true, true), 25000);
        c.tMax = setTimeout(() => endCall(c, 'Colgada (límite de 30 min)', false, true), 30 * 60 * 1000);
        c.tPoll = setInterval(async () => {   // respaldo del Realtime mientras la llamada esta en curso
          if (c.polling || c.ended) return;
          c.polling = true;
          try {
            const { data } = await sb.from('rtc_signals').select(SIG_COLS).eq('device_id', id).eq('call_id', c.callId)
              .eq('from_role', 'device').order('created_at', { ascending: true });
            (data || []).forEach(r => onSignal(c, r));
          } catch (_) {}
          c.polling = false;
        }, 1500);
      } catch (e) {
        endCall(c, 'Error: ' + (e && e.soft ? e.message : 'no se pudo iniciar la llamada' + (e && e.message ? ' (' + e.message + ')' : '')), true, c.offerSent);
      }
    }
    bTalk.addEventListener('click', startCall);
    bHang.addEventListener('click', () => { const c = L.call; if (c) endCall(c, 'Colgada', false, true); });
    bMute.addEventListener('click', () => {
      const c = L.call; if (!c) return;
      c.muted = !c.muted;
      if (c.stream) c.stream.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
      bMute.textContent = c.muted ? 'Activar micrófono' : 'Silenciar';
      bMute.setAttribute('aria-pressed', String(c.muted));
    });
    // Al salir de la pagina: hangup con fetch keepalive (el insert de supabase-js podria cancelarse).
    L.leave = () => {
      const c = L.call; if (!c || c.ended) return;
      if (c.offerSent && token) {
        try {
          fetch(cfg.SUPABASE_URL + '/rest/v1/rtc_signals', { method: 'POST', keepalive: true,
            headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ device_id: id, call_id: c.callId, kind: 'hangup', payload: {} }) });
        } catch (_) {}
      }
      endCall(c, 'Colgada', false, false);
    };

    lives.set(id, L);
    loadRot(id);
    return L;
  }

  // Geocerca que requiere Atender: restringida/enter, permitida/exit o peligro/enter (docs/PROTOCOLO-GEO.md seccion 2 y 3).
  const geoAlert = ev => {
    const p = ev.payload; if (!p || typeof p !== 'object') return false;
    return (p.kind === 'restringida' && p.action === 'enter') || (p.kind === 'permitida' && p.action === 'exit') || (p.kind === 'peligro' && p.action === 'enter');
  };
  // Requieren Atender: sos, fall, geofence (segun zona), not_worn e inactive (docs/PROTOCOLO-COMANDOS.md seccion 2).
  const needsAttention = ev => ev.type === 'sos' || ev.type === 'fall' || ev.type === 'not_worn' || ev.type === 'inactive' || (ev.type === 'geofence' && geoAlert(ev));
  const TYPE_LBL = { sos: 'SOS', fall: 'CAÍDA', geofence: 'GEOCERCA', not_worn: 'CASCO SIN USAR', inactive: 'SIN MOVIMIENTO',
    equip: 'EQUIPO', fall_cancel: 'CAÍDA CANCELADA', photo: 'FOTO', video: 'VIDEO' };
  const typeLbl = t => TYPE_LBL[t] || String(t || '').toUpperCase();
  const alertLabel = ev => {
    if (ev.type === 'fall') return 'CAÍDA';
    if (ev.type === 'not_worn') return 'CASCO SIN USAR';
    if (ev.type === 'inactive') return 'SIN MOVIMIENTO';
    if (ev.type === 'geofence') {
      const p = ev.payload || {}, z = typeof p.zone_name === 'string' ? p.zone_name.slice(0, 60) : '';
      return (p.kind === 'permitida' ? 'SALIÓ DE ZONA PERMITIDA' : p.kind === 'peligro' ? 'ENTRÓ A ZONA DE PELIGRO' : 'ENTRÓ A ZONA RESTRINGIDA') + (z ? ': ' + z : '');
    }
    return 'SOS';
  };
  // Hombre caido (docs/PROTOCOLO-VOZ.md seccion 6): el SOS automatico trae payload.reason. Solo se compara; nunca se vuelca el texto.
  const isManDown = ev => !!ev.payload && typeof ev.payload === 'object' &&
    (ev.payload.reason === 'hombre_caido' || ev.payload.reason === 'manual_en_caida');

  function refreshBanner() {
    const b = $('sos');
    document.title = (pending.size ? '(' + pending.size + ') ' : '') + 'Vigía · Casco Inteligente';
    renderPending();
    if (!pending.size) { b.style.display = 'none'; syncAlarm(); return; }
    const last = [...pending.values()].sort((a, c) => c.created_at.localeCompare(a.created_at))[0];
    const txt = document.createElement('span');
    txt.textContent = pending.size + ' alerta(s) sin atender — última: ' +
      alertLabel(last) + (isManDown(last) ? ' · HOMBRE CAÍDO' : '') + ' · ' + label(last.device_id) + ' · ' + fmt(last.created_at);
    const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Ver alerta';
    go.addEventListener('click', () => {
      showTab('main');
      const li = pendEls.get(last.id) || cards.get(last.id);
      if (li) { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); const inp = li.querySelector('input'); if (inp) inp.focus({ preventScroll: true }); }
    });
    b.replaceChildren(txt, go);
    if (OWN_LIVE) {
      const cam = document.createElement('button'); cam.type = 'button'; cam.textContent = 'Ver en vivo';
      cam.addEventListener('click', () => openLive(last.device_id, true));
      b.append(cam);
    }
    b.style.display = 'block';
    syncAlarm();
  }

  // ---- Estado y salud de cascos (ultimo heartbeat; docs/PROTOCOLO-CENTRO.md seccion 3) ----
  const OFFLINE_MS = 12 * 60 * 1000;
  const BAT_WARN = 20, BAT_CRIT = 10, TEMP_MAX = 45, FREE_MIN_MB = 1024;
  const devState = new Map();   // device_id -> { at, battery, p: payload fusionado de heartbeats }
  const hAlerts = new Map();    // 'id|tipo' -> { id, key, sev, text, dismissed }  (una por episodio)
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const n1 = v => v.toLocaleString('es-AR', { maximumFractionDigits: 1 });
  const pad2 = n => String(n).padStart(2, '0');
  const clock = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s % 60);
  };
  const ago = ms => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 1 ? 'hace menos de 1 min' : m < 60 ? 'hace ' + m + ' min' : 'hace ' + Math.round(m / 60) + ' h';
  };
  const upText = s => {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m + ' min';
  };
  const batOf = s => { const b = num(s.p && s.p.bat); return b != null ? b : num(s.battery); };
  const knownDevices = () => {
    const set = new Set([...devState.keys(), ...lives.keys(), ...devOf.values(), ...EQ.devices.filter(d => !d.deleted_at).map(d => d.device_id)]);
    return [...set].filter(i => DEV_RE.test(i)).sort();
  };

  function healthOf(id, s, now) {
    const out = [], age = now - new Date(s.at).getTime();
    const tag = label(id) + ': ';
    if (age > OFFLINE_MS) out.push({ key: 'off', sev: 'warn', text: tag + 'sin señal, último heartbeat ' + ago(age) });
    const bat = batOf(s);
    if (bat != null && bat < BAT_CRIT) out.push({ key: 'bat-crit', sev: 'crit', text: tag + 'batería crítica (' + n1(bat) + ' %)' });
    else if (bat != null && bat < BAT_WARN) out.push({ key: 'bat-warn', sev: 'warn', text: tag + 'batería baja (' + n1(bat) + ' %)' });
    const t = num(s.p && s.p.temp_c);
    if (t != null && t > TEMP_MAX) out.push({ key: 'temp', sev: 'warn', text: tag + 'temperatura alta (' + n1(t) + ' °C)' });
    const fr = num(s.p && s.p.free_mb);
    if (fr != null && fr < FREE_MIN_MB) out.push({ key: 'free', sev: 'warn', text: tag + 'almacenamiento casi lleno (' + n1(fr / 1024) + ' GB libres)' });
    if (age <= OFFLINE_MS && posLoaded) {   // casco en linea pero sin fix GPS nuevo
      const lp = lastPos.get(id);
      if (!lp) out.push({ key: 'gps', sev: 'warn', text: tag + 'GPS sin fix: todavía no mandó una posición válida' });
      else if (now - lp.fixT > NOFIX_MS) out.push({ key: 'gps', sev: 'warn', text: tag + 'GPS sin fix: sin ubicación nueva ' + ago(now - lp.fixT) });
    }
    return out;
  }
  let hSig = '', posLoaded = false;
  // Eventos `equip` reales (docs/PROTOCOLO-COMANDOS.md seccion 2): comparten clave con las alertas derivadas del navegador
  // (bat_low -> bat-warn, ...), asi no se duplican y el texto del evento real manda mientras dura el episodio.
  const EQUIP_KEY = { bat_low: 'bat-warn', bat_crit: 'bat-crit', no_signal: 'off', temp: 'temp', storage: 'free' };
  const EQUIP_TTL_MS = 30 * 60 * 1000;
  const evAlerts = new Map();   // 'id|clave' -> { id, key, sev, text, t }
  function equipText(id, kind, level) {
    const lv = typeof level === 'number' && isFinite(level) ? level : (typeof level === 'string' && level ? level.slice(0, 20) : null);
    const tag = label(id) + ': ';
    if (kind === 'bat_crit') return tag + 'batería crítica' + (typeof lv === 'number' ? ' (' + n1(lv) + ' %)' : '');
    if (kind === 'bat_low') return tag + 'batería baja' + (typeof lv === 'number' ? ' (' + n1(lv) + ' %)' : '');
    if (kind === 'no_signal') return tag + 'sin señal';
    if (kind === 'temp') return tag + 'temperatura alta' + (typeof lv === 'number' ? ' (' + n1(lv) + ' °C)' : '');
    return tag + 'almacenamiento casi lleno' + (lv != null ? ' (nivel ' + lv + ')' : '');
  }
  function noteEquip(ev) {
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : null;
    const key = p && EQUIP_KEY[p.kind];
    const t = new Date(ev.created_at).getTime();
    if (!key || !DEV_RE.test(ev.device_id || '') || !isFinite(t) || Date.now() - t > EQUIP_TTL_MS) return;
    const k = ev.device_id + '|' + key, cur = evAlerts.get(k);
    if (cur && cur.t >= t) return;
    evAlerts.set(k, { id: ev.device_id, key, sev: key === 'bat-crit' ? 'crit' : 'warn', text: equipText(ev.device_id, p.kind, p.level), t });
    scheduleRender(R_DEV);
  }
  function evalHealth() {
    const now = Date.now(), seen = new Set();
    for (const [id, s] of devState) {
      for (const a of healthOf(id, s, now)) {
        const k = id + '|' + a.key; seen.add(k);
        const cur = hAlerts.get(k);
        if (!cur) hAlerts.set(k, { id, key: a.key, sev: a.sev, text: a.text, dismissed: false });
        else { cur.sev = a.sev; cur.text = a.text; }
      }
    }
    for (const [k, e] of [...evAlerts]) {
      if (now - e.t > EQUIP_TTL_MS) { evAlerts.delete(k); continue; }
      seen.add(k);
      const cur = hAlerts.get(k);
      if (!cur) hAlerts.set(k, { id: e.id, key: e.key, sev: e.sev, text: e.text, dismissed: false });
      else { cur.sev = e.sev; cur.text = e.text; }
    }
    for (const k of [...hAlerts.keys()]) if (!seen.has(k)) hAlerts.delete(k);   // el episodio termino: la proxima vez avisa de nuevo
    const shown = [...hAlerts.entries()].filter(([, a]) => !a.dismissed)
      .sort((a, b) => (a[1].sev === b[1].sev ? a[0].localeCompare(b[0]) : a[1].sev === 'crit' ? -1 : 1));
    const sig = shown.map(([k, a]) => k + a.text).join('\n');
    if (sig === hSig) return;
    hSig = sig;
    const box = $('healthAlerts');
    box.classList.toggle('hidden', !shown.length);
    box.replaceChildren(...shown.map(([k, a]) => {
      const d = mk('div', 'halert' + (a.sev === 'crit' ? ' crit' : ''));
      d.append(mk('span', 'tag ' + (a.sev === 'crit' ? 'sos' : 'warn'), a.sev === 'crit' ? 'CRÍTICA' : 'AVISO DE EQUIPO'), mk('span', '', a.text));
      const b = mk('button', 'ghost', 'Entendido'); b.type = 'button';
      b.setAttribute('aria-label', 'Ocultar el aviso: ' + a.text);
      b.addEventListener('click', () => { a.dismissed = true; evalHealth(); });
      d.append(b);
      return d;
    }));
  }

  function metric(label, ...content) {
    const d = mk('div'); const dt = mk('dt', '', label), dd = mk('dd');
    dd.append(...content);
    d.append(dt, dd);
    return d;
  }
  function renderDevices() {
    const box = $('devList');
    const fa = document.activeElement;   // las barras de comandos se reutilizan: al moverlas el foco se pierde y se devuelve abajo
    const now = Date.now();
    let on = 0, off = 0;
    for (const s of devState.values()) { if (now - new Date(s.at).getTime() <= OFFLINE_MS) on++; else off++; }
    // Cascos activos registrados que nunca mandaron heartbeat: tambien cuentan como "sin señal".
    const never = EQ.devices.filter(d => !d.deleted_at && (d.status || 'activo') === 'activo' && DEV_RE.test(d.device_id) && !devState.has(d.device_id)).map(d => d.device_id);
    off += never.length;
    $('kpiDevN').textContent = on + ' en línea';
    $('kpiDevOff').textContent = off + ' sin señal';
    $('kpiDevOff').className = off ? 'bad' : 'mute';
    fillDest();
    if (!devState.size && !never.length) { box.className = 'mute'; box.textContent = 'Sin datos de cascos todavía.'; pruneCmdBars(new Set()); return; }
    box.className = '';
    const ghosts = never.map(id => [id, null]);
    const rows = [...devState.entries(), ...ghosts].sort((a, b) => a[0].localeCompare(b[0])).map(([id, s]) => {
      if (!s) {
        const r0 = mk('div', 'dev2 off'), h0 = mk('div', 'dev');
        const d0 = mk('span', 'dot off'); d0.setAttribute('aria-hidden', 'true');
        h0.append(d0, dlEl('strong', id, ''), mk('span', 'state bad', 'Sin señal'), mk('span', 'mute', 'nunca conectó'));
        r0.append(h0, cmdBar(id, true));
        return r0;
      }
      const age = now - new Date(s.at).getTime();
      const live = age <= OFFLINE_MS;
      const row = mk('div', 'dev2' + (live ? '' : ' off'));
      const head = mk('div', 'dev');
      const dot = mk('span', 'dot ' + (live ? 'on' : 'off')); dot.setAttribute('aria-hidden', 'true');
      head.append(dot, dlEl('strong', id, ''), mk('span', live ? '' : 'state bad', live ? 'En línea' : 'Sin señal'), mk('span', 'mute', ago(age)));
      const dl = mk('dl', 'metrics');
      const p = s.p || {};
      const dash = () => mk('span', 'mute', '—');
      // Bateria: barra con color por umbral (rojo < 10, amarillo < 20, verde)
      const bat = batOf(s);
      if (bat != null) {
        const m = mk('meter'); m.min = 0; m.max = 100; m.low = BAT_CRIT; m.high = BAT_WARN - 0.01; m.optimum = 100; m.value = Math.max(0, Math.min(100, bat));
        m.setAttribute('aria-label', 'Batería del casco ' + id);
        m.textContent = bat + ' %';
        const txt = mk('span', bat < BAT_WARN ? 'bad' : '', ' ' + n1(bat) + ' %' + (p.chg === true ? ' · cargando' : '') + (bat < BAT_CRIT ? ' · crítica' : bat < BAT_WARN ? ' · baja' : ''));
        dl.append(metric('Batería', m, txt));
      } else dl.append(metric('Batería', dash()));
      const lvl = num(p.lvl), sig = num(p.sig);
      dl.append(metric('Señal', lvl != null || sig != null
        ? mk('span', '', (lvl != null ? 'nivel ' + lvl + '/4' : '') + (lvl != null && sig != null ? ' · ' : '') + (sig != null ? sig + ' dBm' : ''))
        : dash()));
      const net = typeof p.net === 'string' && p.net ? p.net.slice(0, 12) : '', sim = num(p.sim);
      dl.append(metric('Red / SIM', net || sim != null ? mk('span', '', (net || '—') + (sim != null ? ' · SIM ' + sim : '')) : dash()));
      const temp = num(p.temp_c);
      dl.append(metric('Temperatura', temp != null ? mk('span', temp > TEMP_MAX ? 'bad' : '', n1(temp) + ' °C' + (temp > TEMP_MAX ? ' · alta' : '')) : dash()));
      const fr = num(p.free_mb);
      dl.append(metric('Almacenamiento libre', fr != null ? mk('span', fr < FREE_MIN_MB ? 'bad' : '', fr >= 1024 ? n1(fr / 1024) + ' GB' : Math.round(fr) + ' MB') : dash()));
      dl.append(metric('Versión', typeof p.app === 'string' && p.app ? mk('span', '', p.app.slice(0, 20)) : dash()));
      const up = num(p.up_s);
      dl.append(metric('Encendido hace', up != null ? mk('span', '', upText(up)) : dash()));
      const lp = lastPos.get(id);
      if (lp) {
        const pi = posInfo(lp, now);
        const b = mk('button', 'ghost', 'Ver en el mapa'); b.type = 'button';
        b.setAttribute('aria-label', 'Ver el casco ' + id + ' en el mapa');
        b.addEventListener('click', () => showOnMap(lp.lat, lp.lng, label(id)));
        dl.append(metric('Ubicación', mk('span', pi.fresh ? '' : 'bad', coordTxt(lp.lat, lp.lng) + ' · ' + pi.txt + pi.acc), b));
      } else dl.append(metric('Ubicación', mk('span', 'bad', 'Sin posición GPS válida todavía')));
      row.append(head, dl, cmdBar(id, true));
      return row;
    });
    keepFocus(() => box.replaceChildren(...rows));
    if (fa && fa.dataset && fa.dataset.fk && fa.isConnected && document.activeElement !== fa) fa.focus({ preventScroll: true });
    pruneCmdBars(new Set([...devState.keys(), ...never]));   // sin barras de cascos que ya no estan
  }
  function noteDevice(id, at, battery, payload) {
    const cur = devState.get(id);
    const pl = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!cur) { devState.set(id, { at, battery: battery ?? null, p: pl ? { ...pl } : {} }); return; }
    if (new Date(at) >= new Date(cur.at)) {
      devState.set(id, { at, battery: battery ?? cur.battery ?? null, p: pl ? { ...cur.p, ...pl } : cur.p });
    } else if (pl) {   // un heartbeat mas viejo solo completa los campos que faltan
      cur.p = { ...pl, ...cur.p };
      if (cur.battery == null && battery != null) cur.battery = battery;
    }
  }
  async function loadDevices() {
    const HB = 'device_id,created_at,battery,type,payload';
    const hb = () => sb.from('events').select(HB).eq('type', 'heartbeat');
    try {
      const { data, error } = await hb().order('created_at', { ascending: false }).limit(200);
      if (!error && Array.isArray(data)) for (const e of data) noteDevice(e.device_id, e.created_at, e.battery, e.payload);
      else if (error && isAuthErr(error)) { sessionExpired(); return; }
      // Un casco muy parlanchin llena la ventana global: los que faltan se piden uno por uno (ultimos 5 heartbeats).
      const missing = knownDevices().filter(id => !devState.has(id));
      const rs = await Promise.all(missing.map(id => hb().eq('device_id', id).order('created_at', { ascending: false }).limit(5)));
      for (const r of rs) if (!r.error && Array.isArray(r.data)) for (const e of r.data) noteDevice(e.device_id, e.created_at, e.battery, e.payload);
    } catch (_) {}
    renderDevices(); evalHealth();
  }

  // ---- Centro: KPI y pendientes por antiguedad ----
  let lastEv = null;
  function noteLast(ev) {
    if (ev.type === 'heartbeat' || ev.type === 'location') return;
    if (!lastEv || new Date(ev.created_at) >= new Date(lastEv.created_at)) lastEv = ev;
    $('kpiLast').textContent = typeLbl(lastEv.type) + ' · ' + label(lastEv.device_id);
    $('kpiLastWhen').textContent = fmt(lastEv.created_at);
  }
  const oldestPending = () => {
    let o = null;
    for (const ev of pending.values()) if (!o || new Date(ev.created_at) < new Date(o.created_at)) o = ev;
    return o;
  };
  function renderKpiAge() {
    const o = oldestPending();
    $('kpiPendN').textContent = String(pending.size);
    $('kpiPend').classList.toggle('alert', pending.size > 0);
    $('kpiPendAge').textContent = o ? 'La más antigua: hace ' + clock((Date.now() - new Date(o.created_at).getTime()) / 1000) : connDown() ? 'Sin conexión: no se puede confirmar' : 'Sin alertas pendientes';
    $('pendList').querySelectorAll('.age').forEach(el => {
      el.textContent = 'hace ' + clock((Date.now() - Number(el.dataset.t)) / 1000);
    });
    $('pendList').querySelectorAll('.rulebox').forEach(b => ruleSet(b, (Date.now() - Number(b.dataset.t)) / 60000));
    const nb = $('navPend'); nb.textContent = String(pending.size); nb.classList.toggle('hidden', !pending.size);
  }
  const pendEls = new Map();   // event_id -> <li>
  // Abre el panel de video del casco en "En vivo" y lo inicia (un solo camino para banner, tarjetas y cartel).
  function openLive(devId, smooth) {
    const L = ensureLive(devId); if (!L) return;
    showTab('live');
    L.sec.scrollIntoView(smooth ? { block: 'start', behavior: 'smooth' } : { block: 'start' });
    if (!L.isLive()) L.start();   // reinicia el ciclo aunque ya este esperando; si ya esta en vivo solo se muestra
    L.bStop.focus({ preventScroll: true });
  }
  function liveAction(devId) {
    if (!OWN_LIVE || !DEV_RE.test(devId || '')) return null;
    const see = mk('button', 'ghost', 'Ver en vivo'); see.type = 'button';
    see.setAttribute('aria-label', 'Ver en vivo el casco ' + devId);
    see.addEventListener('click', () => openLive(devId, true));
    return see;
  }
  function buildPending(ev) {   // [UI] tarjeta dominante: icono + texto + contador + regla de estacion
    const li = mk('li', 'card pitem t-' + ev.type);
    const head = mk('div', 'a-head');
    const type = mk('span', 'a-type');
    type.append(icon(ICONS[ev.type] ? ev.type : 'sos', 28), document.createTextNode(alertLabel(ev)));
    head.append(type);
    if (isManDown(ev)) head.append(mk('span', 'tag sos', 'HOMBRE CAÍDO'));
    const t0 = new Date(ev.created_at).getTime();
    const age = mk('strong', 'age a-age'); age.dataset.t = String(t0);
    head.append(age);
    const meta = mk('div', 'a-meta');
    meta.append(dlEl('strong', ev.device_id, ''), mk('span', 'mute', fmt(ev.created_at)));
    const rule = ruleEl(false); rule.dataset.t = String(t0);
    const act = mk('div', 'a-act');
    const note = mk('input', 'a-note'); note.type = 'text'; note.maxLength = 500; note.placeholder = 'Nota (opcional)';
    note.setAttribute('aria-label', 'Nota de atención del casco ' + ev.device_id);
    const btn = mk('button', 'attend a-go', 'Atender'); btn.type = 'button';
    btn.setAttribute('aria-label', 'Atender la alerta del casco ' + ev.device_id);
    btn.addEventListener('click', () => attend(ev, btn, note));
    act.append(note, btn);
    const lv = liveAction(ev.device_id); if (lv) act.append(lv);
    li.append(head, meta, geoInfoEl('p' + ev.id, ev), rule, act);
    return li;
  }
  function renderPending() {
    const ul = $('pendList');
    const list = [...pending.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));   // la mas antigua primero
    const keep = new Set(list.map(e => e.id));
    for (const [id, li] of pendEls) if (!keep.has(id)) { li.remove(); pendEls.delete(id); }
    for (const ev of list) if (!pendEls.has(ev.id)) pendEls.set(ev.id, buildPending(ev));
    ul.querySelectorAll(':scope > li.empty').forEach(n => n.remove());
    const want = list.map(e => pendEls.get(e.id));
    const have = [...ul.children];
    if (want.length !== have.length || want.some((n, i) => n !== have[i])) ul.replaceChildren(...want);
    if (!want.length) {   // [UI] estado vacio
      const down = connDown();   // sin conexion no se puede afirmar "todo en orden"
      const e = mk('li', down ? 'empty bad' : 'empty empty-ok');
      e.append(icon(down ? 'sos' : 'ok', 28), document.createTextNode(down ? 'Sin conexión con alertas: no se puede confirmar que no haya alertas pendientes.' : 'Sin alertas pendientes. Todo en orden.'));
      ul.append(e);
    }
    renderKpiAge();
  }
  let tickN = 0;
  setInterval(() => { if (document.hidden) return; tickN++; renderKpiAge(); if (tickN % 10 === 0) { renderDevices(); evalHealth(); renderBroadcasts(); } }, 1000);   // oculta: sin trabajo (al volver se repinta)

  // Error de "Atender": visible junto a la tarjeta (role=alert) y en un aviso flotante, en español y completo.
  function attendError(btn, msg) {
    const act = btn.parentElement;
    if (act) {
      let p = act.parentElement && act.parentElement.querySelector(':scope > .a-err');
      if (!p) { p = mk('p', 'a-err bad'); p.setAttribute('role', 'alert'); act.after(p); }
      p.textContent = msg;
    }
    toast(msg);
  }
  async function attend(ev, btn, noteEl) {
    btn.disabled = true;
    const lbl = btn.textContent; btn.textContent = 'Atendiendo…';
    const done = () => { btn.disabled = false; btn.textContent = lbl; };
    const row = { event_id: ev.id };
    const t = noteEl ? noteEl.value.trim() : '';
    if (t) row.note = t;
    let error = null;
    try { error = (await sb.from('event_acks').insert(row)).error; } catch (e) { error = { message: String((e && e.message) || e) }; }
    if (error && error.code !== '23505') {
      done();
      if (isAuthErr(error)) { sessionExpired(); attendError(btn, 'Sesión vencida: ingresá de nuevo para atender la alerta.'); return; }
      const m = String(error.message || ''), c = String(error.code || '');
      attendError(btn, c === '42501' || /row-level|permission/i.test(m)
        ? 'No tenés permiso para atender esta alerta.'
        : /fetch|network|timeout|conexi/i.test(m)
          ? 'No se pudo atender la alerta: sin conexión con el servidor. Probá de nuevo; si sigue, avisá por radio.'
          : 'No se pudo atender la alerta. Probá de nuevo; si sigue, avisá por radio.');
      return;
    }
    let data = null;
    try { data = (await sb.from('event_acks').select(ACK_COLS).eq('event_id', ev.id).maybeSingle()).data; } catch (_) {}
    // El acuse ya quedo guardado: si no se pudo releer, se muestra como atendida igual.
    applyAck(data || { event_id: ev.id, acked_by_email: $('who').dataset.email || null, acked_at: new Date().toISOString(), note: t || null });
  }

  // ---- Escalamiento (solo lectura de public.escalation_rules) ----
  async function loadEscalation() {
    const el = $('escState');
    try {
      const { data, error } = await sb.from('escalation_rules').select('after_seconds,enabled').limit(10);
      if (error) { if (isAuthErr(error)) sessionExpired(); el.textContent = 'No se pudo leer el escalamiento (se reintenta solo)'; return; }
      if (!Array.isArray(data) || !data.length) { el.textContent = 'Escalamiento no configurado'; return; }
      const on = data.filter(r => r.enabled === true && num(r.after_seconds) != null).map(r => r.after_seconds);
      el.textContent = on.length ? 'Escalamiento: activo en ' + Math.min(...on) + ' s' : 'Escalamiento: inactivo';
    } catch (_) { el.textContent = 'No se pudo leer el escalamiento (se reintenta solo)'; }
  }

  // ---- Evacuacion y mensajes a cascos (public.broadcasts / broadcast_acks; docs/PROTOCOLO-CENTRO.md seccion 4) ----
  const bcasts = new Map();    // broadcast id -> fila
  const bcAcks = new Map();    // broadcast id -> Map(device_id -> played_at)
  const BC_COLS = 'id,kind,message,device_ids,repeat,created_at,created_by_email';
  const BC_VALID_MS = 2 * 60 * 1000;   // el casco solo ve ordenes de los ultimos 2 min
  const MSG_MIN = 5;
  // Destinos congelados al enviar a "Todos": la lista de la orden no cambia si despues aparecen cascos nuevos.
  let frozenTargets = new Map();
  try { frozenTargets = new Map(JSON.parse(localStorage.getItem('casco-bc-targets') || '[]')); } catch (_) {}
  function freezeTargets(id, ids) {
    frozenTargets.set(id, ids);
    while (frozenTargets.size > 20) frozenTargets.delete(frozenTargets.keys().next().value);
    try { localStorage.setItem('casco-bc-targets', JSON.stringify([...frozenTargets])); } catch (_) {}
  }
  function fillDest() {
    const ids = knownDevices();
    for (const sel of [$('evacDest'), $('msgDest')]) {
      const cur = sel.value;
      const sig = ids.map(i => label(i)).join(',');
      if (sel.dataset.sig === sig) continue;
      sel.dataset.sig = sig;
      sel.replaceChildren(new Option('Todos los cascos', ''), ...ids.map(i => new Option(label(i), i)));
      sel.value = ids.includes(cur) ? cur : '';
    }
  }
  const asIds = v => {
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && DEV_RE.test(x));
    if (typeof v === 'string' && v[0] === '{') return v.slice(1, -1).split(',').map(x => x.replace(/^"|"$/g, '')).filter(x => DEV_RE.test(x));
    return null;
  };
  function noteBc(b) {
    if (!b || typeof b.id !== 'string') return;
    bcasts.set(b.id, { id: b.id, kind: b.kind === 'evacuacion' ? 'evacuacion' : 'mensaje', message: String(b.message || ''),
      device_ids: asIds(b.device_ids), repeat: num(b.repeat) || 1, created_at: b.created_at, by: String(b.created_by_email || '') });
    const keep = [...bcasts.values()].sort((a, c) => new Date(c.created_at) - new Date(a.created_at)).slice(0, 20).map(x => x.id);
    for (const k of [...bcasts.keys()]) if (!keep.includes(k)) { bcasts.delete(k); bcAcks.delete(k); }
  }
  function noteBcAck(a) {
    if (!a || !DEV_RE.test(a.device_id || '') || typeof a.broadcast_id !== 'string') return;
    if (!bcAcks.has(a.broadcast_id)) bcAcks.set(a.broadcast_id, new Map());
    bcAcks.get(a.broadcast_id).set(a.device_id, a.played_at);
  }
  function renderBroadcasts() {
    const ul = $('bcList');
    const list = [...bcasts.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!list.length) { ul.replaceChildren(mk('li', 'empty mute', 'Todavía no hay órdenes.')); return; }
    const now = Date.now();
    keepFocus(() => ul.replaceChildren(...list.map(b => {
      const li = mk('li', 'bcitem');
      const got = bcAcks.get(b.id) || new Map();
      const targets = b.device_ids || frozenTargets.get(b.id) || [...new Set([...knownDevices(), ...got.keys()])].sort();
      const done = targets.filter(t => got.has(t)).length;
      const head = mk('div', 'row');
      head.append(mk('span', 'tag ' + (b.kind === 'evacuacion' ? 'sos' : ''), b.kind === 'evacuacion' ? 'EVACUACIÓN' : 'MENSAJE'),
        mk('span', 'mute', fmt(b.created_at)), mk('span', 'mute', b.by ? 'por ' + b.by : ''));
      li.append(head);
      li.append(mk('div', '', b.message ? '“' + b.message + '”' : (b.kind === 'evacuacion' ? '(texto estándar: dirigirse al punto de reunión)' : '')));
      li.append(mk('div', 'mute', 'Destino: ' + (b.device_ids ? b.device_ids.map(i => 'casco ' + i).join(', ') : 'todos los cascos') + ' · repetir ' + b.repeat + ' ' + (b.repeat === 1 ? 'vez' : 'veces')));
      const expired = now - new Date(b.created_at).getTime() > BC_VALID_MS;
      li.append(mk('strong', done < targets.length && expired ? 'bad' : '', 'Recibido por ' + done + ' de ' + targets.length + ' cascos'));
      if (targets.length) {
        const chips = mk('div', 'chips');
        for (const t of targets) {
          const at = got.get(t);
          chips.append(mk('span', 'tag' + (at ? ' ok' : ''), label(t) + ': ' + (at
            ? 'recibido ' + new Date(at).toLocaleTimeString('es-AR', { timeZone: TZ })
            : expired ? 'no recibido' : 'esperando')));
        }
        li.append(chips);
        const missing = targets.filter(t => !got.has(t));
        if (missing.length && (b.kind === 'mensaje' || isAdmin())) {
          const rb = mk('button', 'ghost', 'Reenviar a los que no confirmaron (' + missing.length + ')'); rb.type = 'button';
          rb.dataset.fk = 'bc|' + b.id;
          rb.addEventListener('click', () => resendBroadcast(b, missing));
          li.append(rb);
        }
      }
      return li;
    })));
  }
  async function loadBcAcks() {
    const ids = [...bcasts.keys()];
    if (!ids.length) { renderBroadcasts(); return; }
    const { data, error } = await sb.from('broadcast_acks').select('broadcast_id,device_id,played_at').in('broadcast_id', ids);
    if (!error && Array.isArray(data)) data.forEach(noteBcAck);
    renderBroadcasts();
  }
  async function loadBroadcasts() {
    const { data, error } = await sb.from('broadcasts').select(BC_COLS).order('created_at', { ascending: false }).limit(20);
    if (error || !Array.isArray(data)) { $('bcList').replaceChildren(mk('li', 'empty mute', 'No se pudo leer el historial de órdenes.')); return; }
    data.forEach(noteBc);
    await loadBcAcks();
  }
  const cleanMsg = t => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  function bcError(error) {
    const m = String(error.message || ''), c = String(error.code || '');
    if (c === '54000' || /rate limit/i.test(m)) return 'Demasiadas órdenes en poco tiempo (máximo 6 por minuto). Esperá unos segundos y probá de nuevo.';
    if (isAuthErr(error)) { sessionExpired(); return 'Sesión vencida: ingresá de nuevo y reenviá la orden.'; }
    if (c === '42501' || /permission|row-level|not authorized|rol no autorizado/i.test(m)) return 'No tenés permiso para enviar órdenes a los cascos.';
    return 'No se pudo enviar la orden: ' + m;
  }
  async function sendBroadcast(kind, message, dest, rep, errEl, btn) {
    errEl.textContent = ''; $('orderOk').textContent = '';
    const m = cleanMsg(message);
    if (kind === 'mensaje' && !m) { errEl.textContent = 'Escribí el mensaje antes de enviar.'; return false; }
    if (kind === 'mensaje' && m.length < MSG_MIN) { errEl.textContent = 'El mensaje debe tener al menos ' + MSG_MIN + ' caracteres.'; return false; }
    if (kind === 'evacuacion' && !isAdmin()) { errEl.textContent = 'Solo un administrador puede enviar una evacuación.'; return false; }
    let frozen = null;
    if (kind === 'mensaje' && !dest) {   // a "Todos": confirmar con la lista de destinos y congelarla
      frozen = knownDevices();
      const chips = mk('div', 'chips'); frozen.forEach(i => chips.append(mk('span', 'tag', label(i))));
      const ok = await askConfirm('¿Enviar el mensaje a todos los cascos?',
        [mk('p', '', '“' + m + '”'), mk('p', 'mute', 'Lo recibirán ' + frozen.length + ' cascos' + (frozen.length ? ':' : '.')), chips], 'Sí, enviar a todos', false);
      if (!ok) return false;
    }
    if (m.length > 200) { errEl.textContent = 'El mensaje supera los 200 caracteres.'; return false; }
    const r = parseInt(rep, 10);
    if (!(r >= 1 && r <= 5)) { errEl.textContent = 'Las repeticiones deben ser de 1 a 5.'; return false; }
    if (dest && !DEV_RE.test(dest)) { errEl.textContent = 'Casco de destino inválido.'; return false; }
    btn.disabled = true;
    let res;
    try {
      // Solo columnas permitidas por RLS: kind, message, device_ids, repeat (autor y fecha los pone el servidor).
      res = await sb.from('broadcasts').insert({ kind, message: m, device_ids: dest ? [dest] : null, repeat: r }).select(BC_COLS).single();
    } catch (e) { res = { error: { message: (e && e.message) || 'sin conexión' } }; }
    btn.disabled = false;
    if (res.error) { errEl.textContent = bcError(res.error); return false; }
    if (res.data) { if (frozen) freezeTargets(res.data.id, frozen); noteBc(res.data); renderBroadcasts(); }
    $('orderOk').textContent = (kind === 'evacuacion' ? 'Evacuación enviada' : 'Mensaje enviado') + ' a ' + (dest ? 'el casco ' + dest : 'todos los cascos') + '.';
    return true;
  }
  // Reenvio a los cascos que no confirmaron: nueva orden solo para esos ids (mismo texto y repeticiones).
  async function resendBroadcast(b, ids) {
    $('orderErr').textContent = ''; $('orderOk').textContent = '';
    const ok = await askConfirm('¿Reenviar a los que no confirmaron?',
      [mk('p', '', (b.kind === 'evacuacion' ? 'Evacuación' : 'Mensaje') + (b.message ? ': “' + b.message + '”' : '')), mk('p', 'mute', 'Cascos: ' + ids.map(label).join(', '))], 'Sí, reenviar', b.kind === 'evacuacion');
    if (!ok) return;
    let res;
    try { res = await sb.from('broadcasts').insert({ kind: b.kind, message: b.message, device_ids: ids, repeat: b.repeat }).select(BC_COLS).single(); }
    catch (e) { res = asRes(e); }
    if (res.error) { $('orderErr').textContent = bcError(res.error); return; }
    if (res.data) { noteBc(res.data); renderBroadcasts(); }
    $('orderOk').textContent = 'Orden reenviada a ' + ids.length + (ids.length === 1 ? ' casco.' : ' cascos.');
  }
  // Evacuacion: dos pasos. 1) abrir el panel; 2) escribir EVACUACION y enviar, o tocar Enviar dos veces dentro de 3 s.
  let armTimer = null, armAt = 0;
  function disarm() {
    clearInterval(armTimer); armTimer = null; armAt = 0;
    $('evacGo').textContent = 'Enviar evacuación';
  }
  function closeEvac() { disarm(); $('evacBox').classList.add('hidden'); $('btnEvac').setAttribute('aria-expanded', 'false'); $('evacType').value = ''; $('evacErr').textContent = ''; }
  $('btnEvac').addEventListener('click', () => {
    const open = $('evacBox').classList.contains('hidden');
    if (!open) { closeEvac(); return; }
    $('msgBox').classList.add('hidden'); $('btnMsg').setAttribute('aria-expanded', 'false');
    $('evacBox').classList.remove('hidden'); $('btnEvac').setAttribute('aria-expanded', 'true');
    $('evacType').focus();
  });
  $('evacCancel').addEventListener('click', () => { closeEvac(); $('btnEvac').focus(); });
  $('evacGo').addEventListener('click', async () => {
    const typed = $('evacType').value.trim().toUpperCase() === 'EVACUACION';
    const now = Date.now();
    if (!typed) {
      if (!armAt || now - armAt > 3000) {   // primer toque: arma la cuenta de 3 s
        armAt = now; let left = 3;
        $('evacGo').textContent = 'Tocá de nuevo para confirmar (' + left + ')';
        $('evacErr').textContent = '';
        armTimer = setInterval(() => {
          left--;
          if (left <= 0) { disarm(); return; }
          $('evacGo').textContent = 'Tocá de nuevo para confirmar (' + left + ')';
        }, 1000);
        return;
      }
      if (now - armAt < 600) return;   // un doble clic accidental no confirma
    }
    const ok = await sendBroadcast('evacuacion', $('evacMsg').value, $('evacDest').value, $('evacRep').value, $('evacErr'), $('evacGo'));
    disarm();
    if (ok) { closeEvac(); $('evacMsg').value = ''; $('btnEvac').focus(); }
  });
  $('btnMsg').addEventListener('click', () => {
    const open = $('msgBox').classList.contains('hidden');
    closeEvac();
    $('msgBox').classList.toggle('hidden', !open); $('btnMsg').setAttribute('aria-expanded', String(open));
    if (open) $('msgText').focus();
  });
  $('msgCancel').addEventListener('click', () => { $('msgBox').classList.add('hidden'); $('btnMsg').setAttribute('aria-expanded', 'false'); $('msgErr').textContent = ''; $('btnMsg').focus(); });
  $('msgText').addEventListener('input', () => { $('msgCount').textContent = $('msgText').value.length + '/200'; });
  $('msgBox').addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await sendBroadcast('mensaje', $('msgText').value, $('msgDest').value, $('msgRep').value, $('msgErr'), $('msgGo'));
    if (ok) { $('msgText').value = ''; $('msgCount').textContent = '0/200'; $('msgBox').classList.add('hidden'); $('btnMsg').setAttribute('aria-expanded', 'false'); $('btnMsg').focus(); }
  });
  // Respaldo del Realtime: mientras haya ordenes recientes sin acuse de todos, relee los acuses cada 15 s.
  setInterval(() => {
    const now = Date.now();
    const need = [...bcasts.values()].some(b => now - new Date(b.created_at).getTime() < 10 * 60 * 1000);
    if (need && $('app') && !$('app').classList.contains('hidden')) loadBcAcks();
  }, 15000);
  window.addEventListener('beforeunload', e => {   // una grabacion en curso se perderia al cerrar
    if (unsavedVideos() || [...lives.values()].some(L => L.isRecording && L.isRecording())) { e.preventDefault(); e.returnValue = ''; }
  });

  function renderAction(ev) {
    const li = cards.get(ev.id); if (!li) return;
    li.querySelector('.action')?.remove();
    const box = document.createElement('div'); box.className = 'row action';
    const see = liveAction(devOf.get(ev.id));
    if (see) box.append(see);
    const ack = acks.get(ev.id);
    if (ack) {
      li.classList.remove('pending');
      const t = document.createElement('span'); t.className = 'tag ok'; t.textContent = 'ATENDIDO';
      const w = document.createElement('span'); w.className = 'mute';
      w.textContent = 'por ' + ack.acked_by_email + ' · ' + fmt(ack.acked_at) + (ack.note ? ' · ' + ack.note : '');
      box.append(t, w);
      const t0 = evAt.get(ev.id);
      if (t0 && ack.acked_at) {   // [UI] la misma regla, ahora con la duracion hasta Atender
        const sec = (new Date(ack.acked_at).getTime() - new Date(t0).getTime()) / 1000;
        if (isFinite(sec) && sec >= 0) {
          const r = ruleEl(true); ruleSet(r, sec / 60);
          box.append(mk('span', 'mute', 'Atendida a los ' + clock(sec)), r);
        }
      }
    } else {
      li.classList.add('pending');
      const note = document.createElement('input');
      note.type = 'text'; note.maxLength = 500; note.placeholder = 'Nota (opcional)';
      note.setAttribute('aria-label', 'Nota de atención'); note.style.flex = '1 1 200px';
      const btn = document.createElement('button'); btn.className = 'attend'; btn.type = 'button';
      btn.textContent = 'Atender';
      btn.addEventListener('click', () => attend(ev, btn, note));
      box.append(note, btn);
    }
    li.append(box);
  }

  // ---- Pestanas: Principal (eventos y alertas pendientes) / Atendidos (SOS y caidas ya atendidos) ----
  function syncEmpty() {
    for (const [id, msg] of [['feed', 'Sin eventos todavía.'], ['feedDone', 'Todavía no hay alertas atendidas.']]) {
      const ul = $(id);
      ul.querySelectorAll(':scope > li.empty').forEach(n => n.remove());
      if (!ul.children.length) { const li = mk('li', 'empty mute', msg); ul.append(li); }
    }
    $('doneCount').textContent = String($('feedDone').querySelectorAll(':scope > li:not(.empty):not(.arc-hidden)').length);   // los archivados no cuentan
  }
  // [UI] Centro y En vivo comparten el panel principal (data-view cambia el foco del layout).
  const TABS = [['main', 'tabMain', 'panelMain'], ['live', 'tabLive', 'panelMain'], ['map', 'tabMap', 'panelMap'], ['eq', 'tabEq', 'panelEq'], ['done', 'tabDone', 'panelDone'], ['rep', 'tabRep', 'panelRep'], ['cmd', 'tabCmd', 'panelCmd']];
  // Aviso en la insignia de Historial: eventos u ordenes nuevas mientras se mira otra pestaña.
  let histNew = 0;
  function bumpHist() {
    if (!$('panelDone').classList.contains('hidden')) return;
    histNew++;
    const b = $('navHistNew'); b.textContent = String(histNew); b.classList.remove('hidden');
    $('histLive').textContent = histNew === 1 ? 'Hay una novedad nueva en Historial' : 'Hay ' + histNew + ' novedades nuevas en Historial';
  }
  function showTab(name) {
    const act = TABS.find(x => x[0] === name) || TABS[0];
    for (const [k, t, pn] of TABS) {
      const on = k === name;
      $(pn).classList.toggle('hidden', pn !== act[2]);
      $(t).setAttribute('aria-selected', String(on));
      $(t).tabIndex = on ? 0 : -1;
    }
    $('panelMain').dataset.view = name === 'live' ? 'live' : 'centro';
    $('panelMain').setAttribute('aria-labelledby', name === 'live' ? 'tabLive' : 'tabMain');
    if (name === 'map') ensureMap();
    if (name === 'eq') renderEq();
    if (name === 'rep') repQ.show();
    if (name === 'cmd') loadCmdPanel();
    const selTab = $(act[1]); if (selTab && selTab.scrollIntoView) selTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // barra deslizable
    if (name === 'done') { histNew = 0; $('navHistNew').classList.add('hidden'); $('histLive').textContent = ''; }
  }
  for (const [k, t] of TABS) $(t).addEventListener('click', () => showTab(k));
  $('mainNav').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const cur = TABS.findIndex(x => $(x[1]).getAttribute('aria-selected') === 'true');
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length;
    e.preventDefault();
    showTab(TABS[i][0]); $(TABS[i][1]).focus();
  });

  function applyAck(ack) {
    acks.set(ack.event_id, ack);
    pending.delete(ack.event_id);
    const li = cards.get(ack.event_id);
    if (li) {
      renderAction({ id: ack.event_id });
      $('feedDone').prepend(li);   // el SOS atendido sale de la pagina principal
      if (arcOk()) arcCard(li, true);
    }
    syncEmpty();
    refreshBanner();
  }

  // Inserta la tarjeta segun created_at (mas nuevo arriba): un evento tardio o de resync no rompe el orden.
  function place(feed, li, t) {
    li.dataset.t = String(t);
    for (const c of feed.children) {
      if (c.classList.contains('empty')) continue;
      if (Number(c.dataset.t) < t) { feed.insertBefore(li, c); return; }
    }
    feed.append(li);
  }
  // Resumen de texto del payload (tarjetas del feed y filas de reportes). Solo se comparan/recortan campos conocidos.
  const EQUIP_LBL = { bat_low: 'batería baja', bat_crit: 'batería crítica', no_signal: 'sin señal', temp: 'temperatura alta', storage: 'almacenamiento casi lleno' };
  function payloadBits(ev) {
    const bits = [], pl = ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? ev.payload : null;
    if (!pl) return bits;
    if (typeof pl.still_s === 'number') bits.push('inmóvil ' + pl.still_s + ' s');
    if (typeof pl.reason === 'string' && pl.reason && !isManDown(ev)) bits.push('motivo: ' + pl.reason.slice(0, 60));
    if (ev.type === 'geofence') {
      const z = typeof pl.zone_name === 'string' ? pl.zone_name.slice(0, 60) : '';
      bits.push('zona: ' + (z || '—') + (typeof pl.kind === 'string' ? ' (' + pl.kind.slice(0, 20) + ')' : '') + ' · ' + (pl.action === 'exit' ? 'salida' : pl.action === 'enter' ? 'entrada' : '—'));
    }
    if (ev.type === 'equip') {
      bits.push((EQUIP_LBL[pl.kind] || String(pl.kind || 'equipo').slice(0, 20)) + (pl.level != null && typeof pl.level !== 'object' ? ' · nivel ' + String(pl.level).slice(0, 20) : ''));
    }
    return bits;
  }
  // Tope de memoria en turnos largos: el feed conserva FEED_MAX tarjetas y Atendidos FEED_DONE_MAX; las pendientes nunca se sueltan.
  const FEED_MAX = 500, FEED_DONE_MAX = 300;
  function trimList(ul, max) {
    if (ul.children.length <= max) return;
    let n = ul.querySelectorAll(':scope > li:not(.empty)').length;
    for (let i = ul.children.length - 1; i >= 0 && n > max; i--) {
      const li = ul.children[i];
      if (li.classList.contains('empty') || li.classList.contains('pending')) continue;
      const id = li.dataset.id;
      li.remove(); n--;
      if (id) { cards.set(id, null); devOf.delete(id); evAt.delete(id); }   // null: sigue "visto" para el dedupe
    }
  }
  // Devuelve true si el evento era nuevo (dedupe por id: Realtime + consulta inicial + resync).
  function render(ev) {
    if (cards.has(ev.id)) return false;
    const li = document.createElement('li');
    li.className = 'card ev t-' + ev.type;
    li.dataset.id = ev.id; li.dataset.att = needsAttention(ev) ? '1' : ''; li.dataset.dev = ev.device_id; if (ev.media_path) li.dataset.media = ev.media_path;
    cards.set(ev.id, li);
    if (ev.type === 'equip') noteEquip(ev);
    if (ev.type === 'photo') notePhoto(ev);
    devOf.set(ev.id, ev.device_id);
    evAt.set(ev.id, ev.created_at);
    noteLast(ev);
    ensureLive(ev.device_id);
    const row = document.createElement('div'); row.className = 'row';
    const tag = document.createElement('span'); tag.className = 'tag ' + ev.type + (ev.type === 'geofence' && needsAttention(ev) ? ' sos' : '');
    tag.textContent = typeLbl(ev.type);
    const dev = dlEl('strong', ev.device_id, '');
    const when = document.createElement('span'); when.className = 'mute'; when.textContent = fmt(ev.created_at);
    row.append(tag);
    if (isManDown(ev)) row.append(mk('span', 'tag sos', 'HOMBRE CAÍDO'));
    row.append(dev, when);
    li.append(row);
    const bits = payloadBits(ev);
    if (ev.press_ms != null) bits.push('pulsación ' + ev.press_ms + ' ms');
    if (ev.battery != null) bits.push('batería ' + ev.battery + '%');
    if (llOk(numOf(ev.lat), numOf(ev.lng))) bits.push(Number(ev.lat).toFixed(5) + ', ' + Number(ev.lng).toFixed(5));
    if (bits.length) { const m = document.createElement('div'); m.className = 'mute'; m.textContent = bits.join(' · '); li.append(m); }
    if (needsAttention(ev)) li.append(geoInfoEl('f' + ev.id, ev));
    const feed = (needsAttention(ev) && acks.has(ev.id)) ? $('feedDone') : $('feed');
    place(feed, li, new Date(ev.created_at).getTime() || 0);
    trimList(feed, feed === $('feed') ? FEED_MAX : FEED_DONE_MAX);
    if (arcOk()) arcCard(li, feed === $('feedDone'));
    syncEmpty();
    if (needsAttention(ev)) {
      if (!acks.has(ev.id)) pending.set(ev.id, ev);
      renderAction(ev);
      refreshBanner();
    }
    if (ev.media_path && !IMG.has(String(ev.id))) {   // en segundo plano: no frena la carga ni el resto de las alertas
      const kind = ev.type === 'video' ? 'Video' : 'Foto';
      mediaEl(ev.media_path, ev.type, kind + ' del casco ' + ev.device_id + ', ' + fmt(ev.created_at)).then(el => {
        if (el && li.isConnected !== false && !IMG.has(String(ev.id))) li.insertBefore(el, li.querySelector('.action'));
      }).catch(() => {});
    }
    return true;
  }

  // ======================================================================
  // Equipos: cascos, personas, grupos, asignaciones (supabase/migrations/007_equipos.sql)
  // REGLA: nunca select('*') sobre devices/people (grants por columna). Se piden columnas por nombre
  // o las vistas devices_full / people_full (esta ultima solo devuelve filas al rol admin).
  // ======================================================================
  let ROLE = 'viewer';
  const EQ = { devices: [], people: [], groups: [], assigns: [], err: {}, limited: false, sub: 'dev', loaded: false };
  const DEV_COLS = 'device_id,name,model,group_id,sector,status,created_at,updated_at,deleted_at';
  const DEV_FULL = 'device_id,imei,name,model,group_id,sector,sim1_iccid,sim2_iccid,sim_line,bt_headset_mac,status,notes,created_at,updated_at,deleted_at';
  const PPL_COLS = 'id,full_name,legajo,job_title,sector,group_id,active,created_at,updated_at,deleted_at';
  const PPL_FULL = 'id,full_name,legajo,dni,job_title,sector,contact_phone,group_id,active,created_at,updated_at,deleted_at';
  const GRP_COLS = 'id,name,site,notes,active,created_at,updated_at,deleted_at';
  const ASG_COLS = 'id,device_id,person_id,starts_at,ends_at,created_at';
  const noPerm = e => !!e && (e.code === '42501' || /permission denied|row-level security|not authorized|rol no autorizado|no autorizado/i.test(String(e.message || '')));
  const NO_PERM_TXT = 'Sin permiso para ver este dato';
  const dbMsg = e => (noPerm(e) ? NO_PERM_TXT : 'No se pudo leer: ' + String((e && e.message) || 'error'));
  const numOf = v => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const personOf = new Map();    // device_id -> nombre de la persona con asignacion vigente
  const label = id => 'Casco ' + id + (personOf.get(id) ? ' · ' + personOf.get(id) : '');
  // Elemento de texto que se vuelve a rotular solo cuando cambia la asignacion.
  const dlEl = (tag, id, prefix, cls) => { const e = mk(tag, cls, (prefix || '') + label(id)); e.dataset.dl = id; e.dataset.dlp = prefix || ''; return e; };
  function refreshLabels() {
    document.querySelectorAll('[data-dl]').forEach(e => { e.textContent = e.dataset.dlp + label(e.dataset.dl); });
    renderDevices(); evalHealth(); renderBroadcasts(); refreshBanner(); renderPending(); renderMapLists();
    if (lastEv) $('kpiLast').textContent = typeLbl(lastEv.type) + ' · ' + label(lastEv.device_id);
  }
  function rebuildPersonOf() {
    const byId = new Map(EQ.people.map(p => [p.id, p]));
    const m = new Map();
    for (const a of EQ.assigns) {
      if (a.ends_at != null) continue;
      const p = byId.get(a.person_id);
      if (p && typeof p.full_name === 'string' && p.full_name) m.set(a.device_id, p.full_name.slice(0, 120));
    }
    const same = m.size === personOf.size && [...m].every(([k, v]) => personOf.get(k) === v);
    if (same) return false;
    personOf.clear(); m.forEach((v, k) => personOf.set(k, v));
    return true;
  }
  async function pull(key, fn) {
    try {
      const r = await fn();
      if (r.error) { EQ.err[key] = r.error; return null; }
      EQ.err[key] = null; return Array.isArray(r.data) ? r.data : [];
    } catch (e) { EQ.err[key] = e; return null; }
  }
  async function loadEquipos() {
    let d = await pull('devices', () => sb.from('devices_full').select(DEV_FULL).is('deleted_at', null).order('name'));
    EQ.limited = false;
    if (d === null) { d = await pull('devices', () => sb.from('devices').select(DEV_COLS).is('deleted_at', null).order('name')); EQ.limited = true; }
    const p = await pull('people', () => ROLE === 'admin'
      ? sb.from('people_full').select(PPL_FULL).is('deleted_at', null).order('full_name')
      : sb.from('people').select(PPL_COLS).is('deleted_at', null).order('full_name'));
    const g = await pull('groups', () => sb.from('groups').select(GRP_COLS).is('deleted_at', null).order('name'));
    const a = await pull('assigns', () => sb.from('assignments').select(ASG_COLS).order('starts_at', { ascending: false }).limit(1000));
    // Un fallo de lectura (null) no borra lo ya cargado: el error queda en EQ.err.
    if (d !== null) EQ.devices = d;
    if (p !== null) EQ.people = p;
    if (g !== null) EQ.groups = g;
    if (a !== null) EQ.assigns = a;
    EQ.loaded = true;
    if (rebuildPersonOf()) refreshLabels(); else { fillDest(); renderMapLists(); }
    if (!$('panelEq').classList.contains('hidden')) renderEq();
  }
  let eqTimer = null;
  const reloadEq = () => { clearTimeout(eqTimer); eqTimer = setTimeout(loadEquipos, 400); };
  const grpName = id => { const g = EQ.groups.find(x => x.id === id); return g ? g.name : ''; };
  const STATUS_LBL = { activo: 'Activo', mantenimiento: 'Mantenimiento', baja: 'Baja' };
  const fld = (text, el) => { const l = mk('label'); l.append(text, el); return l; };
  const inp = (type, val, attrs) => { const i = mk('input'); i.type = type; if (val != null) i.value = val; Object.assign(i, attrs || {}); return i; };
  const sel = (opts, val) => { const s = mk('select'); for (const [v, t] of opts) s.append(new Option(t, v)); if (val != null) s.value = val; return s; };
  const grpOpts = () => [['', '(sin grupo)'], ...EQ.groups.map(g => [g.id, g.name])];
  const dbErr = e => {
    const c = String((e && e.code) || ''), m = String((e && e.message) || 'error');
    if (c === '23505') return 'Ya existe un registro con ese valor único (alias, IMEI, legajo o nombre).';
    if (c === '54000' || /rate limit/i.test(m)) return 'Demasiadas altas en poco tiempo (máximo 30 por minuto). Esperá unos segundos.';
    if (noPerm(e)) return 'Sin permiso para esta operación.';
    if (c === '23503') return 'La referencia (grupo, casco o persona) ya no existe. Actualizá la lista.';
    if (c === '22023') return m.replace(/^assignments: /, '');
    return 'No se pudo guardar: ' + m;
  };
  // Valida {k, el, label, req, re, max, msg, num}; devuelve {v, errors}
  function collect(spec) {
    const v = {}, errors = [];
    for (const s of spec) {
      let raw = s.el.type === 'checkbox' ? s.el.checked : String(s.el.value || '').trim();
      if (s.el.type === 'checkbox') { v[s.k] = raw; continue; }
      if (raw === '') { if (s.req) errors.push(s.label + ': es obligatorio.'); v[s.k] = null; continue; }
      if (s.max && raw.length > s.max) errors.push(s.label + ': máximo ' + s.max + ' caracteres.');
      if (/[\u0000-\u001f\u007f]/.test(raw)) errors.push(s.label + ': tiene caracteres no permitidos.');
      if (s.re && !s.re.test(raw)) errors.push(s.label + ': ' + s.msg);
      v[s.k] = raw;
    }
    return { v, errors };
  }
  function confirmRow(host, text, yes, onYes) {
    const old = host.querySelector(':scope > .confirm'); if (old) old.remove();
    const box = mk('div', 'row confirm'); box.setAttribute('role', 'alert');
    const ok = mk('button', 'attend', yes); ok.type = 'button';
    const no = mk('button', 'ghost', 'Cancelar'); no.type = 'button';
    ok.addEventListener('click', async () => { ok.disabled = true; await onYes(); box.remove(); });
    no.addEventListener('click', () => box.remove());
    box.append(mk('span', '', text), ok, no);
    host.append(box); no.focus();
  }
  function csvDownload(name, header, rows) {
    const cell = v => { let s = v == null ? '' : String(v); if (/^[=+@\t\r]|^-(?!\d+([.,]\d+)?$)/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const txt = '﻿' + [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
    saveUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  // ---- formularios ----
  const eqForm = () => $('eqForm');
  function closeEqForm() { eqForm().replaceChildren(); eqForm().classList.add('hidden'); }
  function showEqForm(title, fields, spec, onSave, extra) {
    const f = mk('form', 'card section'); f.noValidate = true;
    f.append(mk('h3', '', title), ...fields);
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const row = mk('div', 'row');
    const go = mk('button', '', 'Guardar'); go.type = 'submit';
    const no = mk('button', 'ghost', 'Cancelar'); no.type = 'button';
    no.addEventListener('click', closeEqForm);
    row.append(go, no); f.append(row, err);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const r = collect(spec);
      if (r.errors.length) { err.textContent = r.errors.join(' '); return; }
      go.disabled = true;
      const msg = await onSave(r.v);
      go.disabled = false;
      if (msg) { err.textContent = msg; return; }
      closeEqForm(); loadEquipos();
    });
    eqForm().replaceChildren(f); eqForm().classList.remove('hidden');
    const first = f.querySelector('input:not([readonly]),select'); if (first) first.focus();
    return f;
  }
  function deviceForm(d, preset) {
    if (!isAdmin()) return;
    const edit = !!d, full = edit ? d : (preset || {});
    const alias = inp('text', full.device_id || '', { maxLength: 64, readOnly: edit, autocomplete: 'off' });
    if (edit) alias.setAttribute('aria-describedby', 'aliasNote');
    const name = inp('text', full.name || '', { maxLength: 80 });
    const model = inp('text', full.model || 'rd_aqm6816', { maxLength: 40 });
    const grp = sel(grpOpts(), full.group_id || '');
    const sector = inp('text', full.sector || '', { maxLength: 60 });
    const imei = inp('text', full.imei || '', { maxLength: 15, inputMode: 'numeric', autocomplete: 'off' });
    const s1 = inp('text', full.sim1_iccid || '', { maxLength: 22, inputMode: 'numeric' });
    const s2 = inp('text', full.sim2_iccid || '', { maxLength: 22, inputMode: 'numeric' });
    const line = inp('text', full.sim_line || '', { maxLength: 16 });
    const mac = inp('text', full.bt_headset_mac || '', { maxLength: 17 });
    const status = sel(Object.entries(STATUS_LBL), full.status || 'activo');
    const notes = inp('text', full.notes || '', { maxLength: 500 });
    const spec = [
      { k: 'device_id', el: alias, label: 'Alias', req: true, re: DEV_RE, msg: 'solo letras, números, guion y guion bajo (1 a 64).' },
      { k: 'name', el: name, label: 'Nombre', req: true, max: 80 },
      { k: 'model', el: model, label: 'Modelo', req: true, max: 40 },
      { k: 'group_id', el: grp, label: 'Grupo' },
      { k: 'sector', el: sector, label: 'Sector', max: 60 },
      { k: 'imei', el: imei, label: 'IMEI', re: /^[0-9]{14,15}$/, msg: 'debe tener 14 o 15 dígitos.' },
      { k: 'sim1_iccid', el: s1, label: 'SIM 1 (ICCID)', re: /^[0-9]{18,22}$/, msg: 'debe tener entre 18 y 22 dígitos.' },
      { k: 'sim2_iccid', el: s2, label: 'SIM 2 (ICCID)', re: /^[0-9]{18,22}$/, msg: 'debe tener entre 18 y 22 dígitos.' },
      { k: 'sim_line', el: line, label: 'Línea SIM', re: /^\+?[0-9]{6,15}$/, msg: 'solo dígitos, con + opcional (6 a 15).' },
      { k: 'bt_headset_mac', el: mac, label: 'MAC de los auriculares', re: /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, msg: 'formato AA:BB:CC:DD:EE:FF.' },
      { k: 'status', el: status, label: 'Estado' },
      { k: 'notes', el: notes, label: 'Notas', max: 500 },
    ];
    const fields = [fld('Alias (ID del casco)', alias)];
    if (edit) fields.push(Object.assign(mk('p', 'mute', 'El alias no se puede cambiar una vez creado.'), { id: 'aliasNote' }));
    fields.push(fld('Nombre', name), fld('Modelo', model), fld('Grupo', grp), fld('Sector', sector), fld('Estado', status),
      fld('IMEI (14 o 15 dígitos)', imei), fld('SIM 1 (ICCID)', s1), fld('SIM 2 (ICCID)', s2), fld('Línea SIM', line),
      fld('MAC de los auriculares Bluetooth', mac), fld('Notas', notes));
    if (edit && EQ.limited) fields.push(mk('p', 'mute', 'Tu rol no puede leer IMEI, SIM, MAC ni notas: los campos vacíos se dejan sin cambios.'));
    showEqForm(edit ? 'Editar casco ' + full.device_id : 'Alta de casco', fields, spec, async v => {
      if (!edit) {
        const row = {}; for (const k of Object.keys(v)) if (v[k] !== null && v[k] !== '') row[k] = v[k];
        const { error } = await sb.from('devices').insert(row);
        return error ? dbErr(error) : '';
      }
      const diff = {};
      for (const k of Object.keys(v)) {
        if (k === 'device_id') continue;
        const was = full[k] == null ? '' : String(full[k]); const now = v[k] == null ? '' : String(v[k]);
        if (was !== now) {
          if (EQ.limited && now === '' && ['imei', 'sim1_iccid', 'sim2_iccid', 'sim_line', 'bt_headset_mac', 'notes'].includes(k)) continue;
          diff[k] = v[k] === '' ? null : v[k];
        }
      }
      if (!Object.keys(diff).length) return '';
      const { error } = await sb.from('devices').update(diff).eq('device_id', full.device_id);
      return error ? dbErr(error) : '';
    });
  }
  function personForm(p) {
    if (!isAdmin()) return;
    const edit = !!p, cur = p || {};
    const name = inp('text', cur.full_name || '', { maxLength: 120 });
    const legajo = inp('text', cur.legajo || '', { maxLength: 20 });
    const job = inp('text', cur.job_title || '', { maxLength: 80 });
    const sector = inp('text', cur.sector || '', { maxLength: 60 });
    const grp = sel(grpOpts(), cur.group_id || '');
    const spec = [
      { k: 'full_name', el: name, label: 'Nombre y apellido', req: true, max: 120 },
      { k: 'legajo', el: legajo, label: 'Legajo', re: /^[A-Za-z0-9._\/-]{1,20}$/, msg: 'letras, números, punto, guion o barra (1 a 20).' },
      { k: 'job_title', el: job, label: 'Puesto', max: 80 },
      { k: 'sector', el: sector, label: 'Sector', max: 60 },
      { k: 'group_id', el: grp, label: 'Grupo' },
    ];
    const fields = [fld('Nombre y apellido', name), fld('Legajo', legajo), fld('Puesto', job), fld('Sector', sector), fld('Grupo', grp)];
    let dni = null, tel = null;
    if (ROLE === 'admin') {
      dni = inp('text', cur.dni || '', { maxLength: 15, autocomplete: 'off' });
      tel = inp('tel', cur.contact_phone || '', { maxLength: 20 });
      spec.push({ k: 'dni', el: dni, label: 'DNI', re: /^[A-Za-z0-9]{5,15}$/, msg: 'letras y números (5 a 15).' },
        { k: 'contact_phone', el: tel, label: 'Teléfono de contacto', re: /^\+?[0-9 ()-]{6,20}$/, msg: 'solo dígitos, espacios, paréntesis y guion (6 a 20).' });
      fields.push(fld('DNI (solo admin)', dni), fld('Teléfono de contacto (solo admin)', tel));
    } else fields.push(mk('p', 'mute', 'DNI y teléfono de contacto: solo los ve y edita un administrador.'));
    showEqForm(edit ? 'Editar persona' : 'Alta de persona', fields, spec, async v => {
      const clean = {}; for (const k of Object.keys(v)) clean[k] = v[k] === '' ? null : v[k];
      if (!edit) {
        const row = {}; for (const k of Object.keys(clean)) if (clean[k] !== null) row[k] = clean[k];
        const { error } = await sb.from('people').insert(row);
        return error ? dbErr(error) : '';
      }
      const diff = {};
      for (const k of Object.keys(clean)) { const was = cur[k] == null ? '' : String(cur[k]), now = clean[k] == null ? '' : String(clean[k]); if (was !== now) diff[k] = clean[k]; }
      if (!Object.keys(diff).length) return '';
      const { error } = await sb.from('people').update(diff).eq('id', cur.id);
      return error ? dbErr(error) : '';
    });
  }
  function groupForm(g) {
    if (!isAdmin()) return;
    const edit = !!g, cur = g || {};
    const name = inp('text', cur.name || '', { maxLength: 80 });
    const site = inp('text', cur.site || '', { maxLength: 80 });
    const notes = inp('text', cur.notes || '', { maxLength: 500 });
    const act = inp('checkbox'); act.checked = edit ? cur.active !== false : true;
    const spec = [
      { k: 'name', el: name, label: 'Nombre', req: true, max: 80 },
      { k: 'site', el: site, label: 'Sitio', max: 80 },
      { k: 'notes', el: notes, label: 'Notas', max: 500 },
      { k: 'active', el: act, label: 'Activo' },
    ];
    const chk = mk('label', 'chk'); chk.append(act, 'Activo');
    showEqForm(edit ? 'Editar grupo' : 'Alta de grupo', [fld('Nombre', name), fld('Sitio', site), fld('Notas', notes), chk], spec, async v => {
      const clean = { name: v.name, site: v.site === '' ? null : v.site, notes: v.notes === '' ? null : v.notes, active: v.active };
      if (!edit) {
        const row = { name: clean.name, active: clean.active }; if (clean.site) row.site = clean.site; if (clean.notes) row.notes = clean.notes;
        const { error } = await sb.from('groups').insert(row);
        return error ? dbErr(error) : '';
      }
      const { error } = await sb.from('groups').update(clean).eq('id', cur.id);
      return error ? dbErr(error) : '';
    });
  }

  // ---- listas ----
  function errBox(key) {
    const e = EQ.err[key]; if (!e) return null;
    const d = mk('div', 'state bad', dbMsg(e)); d.setAttribute('role', 'status'); return d;
  }
  function actionRow(...btns) { const r = mk('div', 'row'); r.append(...btns); return r; }
  const btn = (text, cls, fn, aria) => { const b = mk('button', cls || 'ghost', text); b.type = 'button'; if (aria) b.setAttribute('aria-label', aria); b.addEventListener('click', fn); return b; };
  function kv(pairs) {
    const dl = mk('dl', 'metrics');
    for (const [k, v] of pairs) { const d = mk('div'); d.append(mk('dt', '', k), mk('dd', '', v == null || v === '' ? '—' : String(v))); dl.append(d); }
    return dl;
  }
  function renderDevTab(body) {
    const top = mk('div', 'row');
    if (!isAdmin()) body.append(roNote('las altas, ediciones y bajas de cascos'));
    if (isAdmin()) top.append(btn('Alta de casco', '', () => deviceForm(null)));
    top.append(
      btn('Exportar CSV', 'ghost', () => {
        const full = !EQ.limited;
        const header = ['alias', 'nombre', 'modelo', 'grupo', 'sector', 'estado', 'persona_asignada', 'ultima_conexion', 'bateria_pct'].concat(full ? ['imei', 'sim1_iccid', 'sim2_iccid', 'linea_sim', 'mac_auriculares', 'notas'] : []);
        const rows = EQ.devices.map(d => {
          const s = devState.get(d.device_id), b = s ? batOf(s) : null;
          return [d.device_id, d.name, d.model, grpName(d.group_id), d.sector, STATUS_LBL[d.status] || d.status, personOf.get(d.device_id) || '',
            s ? fmt(s.at) : '', b != null ? b : ''].concat(full ? [d.imei, d.sim1_iccid, d.sim2_iccid, d.sim_line, d.bt_headset_mac, d.notes] : []);
        });
        csvDownload('cascos_' + today() + '.csv', header, rows);
      }));
    body.append(top);
    const eb = errBox('devices'); if (eb) body.append(eb);
    // Cascos que mandan heartbeats pero no estan en devices: el admin los registra con el alias precargado.
    const unreg = eb || !EQ.loaded ? [] : [...devState.keys()].filter(i => DEV_RE.test(i) && !EQ.devices.some(d => d.device_id === i)).sort();
    if (unreg.length) {
      const sec = mk('section', 'card section unreg'); sec.setAttribute('aria-label', 'Cascos detectados sin registrar');
      sec.append(mk('h3', '', 'Cascos detectados sin registrar'));
      for (const i of unreg) {
        const r = mk('div', 'row');
        r.append(mk('strong', 'mono', i), mk('span', 'mute', 'manda datos pero no está dado de alta'));
        if (isAdmin()) r.append(btn('Registrar', '', () => deviceForm(null, { device_id: i, name: 'Casco ' + i }), 'Registrar el casco ' + i));
        sec.append(r);
      }
      if (!isAdmin()) sec.append(roNote('registrarlos'));
      body.append(sec);
    }
    if (!EQ.devices.length && !eb) body.append(mk('p', 'mute', 'Todavía no hay cascos registrados.'));
    const ul = mk('ul');
    for (const d of EQ.devices) {
      const li = mk('li', 'card eqitem');
      const head = mk('div', 'row');
      head.append(mk('strong', '', d.device_id), mk('span', '', d.name), mk('span', 'tag' + (d.status === 'activo' ? ' ok' : ''), STATUS_LBL[d.status] || String(d.status)));
      const s = devState.get(d.device_id), bat = s ? batOf(s) : null;
      li.append(head, kv([['Grupo', grpName(d.group_id)], ['Sector', d.sector], ['Persona asignada hoy', personOf.get(d.device_id)],
        ['Última conexión', s ? fmt(s.at) + ' (' + ago(Date.now() - new Date(s.at).getTime()) + ')' : ''], ['Batería', bat != null ? n1(bat) + ' %' : '']]));
      const acts = !isAdmin() ? null : actionRow(btn('Editar', 'ghost', () => deviceForm(d), 'Editar el casco ' + d.device_id),
        btn('Dar de baja', 'ghost', () => confirmRow(li, '¿Dar de baja el casco ' + d.device_id + '? Deja de aparecer en las listas.', 'Sí, dar de baja', async () => {
          const { error } = await sb.from('devices').update({ deleted_at: new Date().toISOString() }).eq('device_id', d.device_id);
          if (error) $('status').textContent = dbErr(error); else loadEquipos();
        }), 'Dar de baja el casco ' + d.device_id));
      if (acts) li.append(acts);
      ul.append(li);
    }
    body.append(ul);
  }
  function renderPeopleTab(body) {
    const top = mk('div', 'row');
    if (!isAdmin()) body.append(roNote('las altas, ediciones y bajas de personas'));
    if (isAdmin()) top.append(btn('Alta de persona', '', () => personForm(null)));
    top.append(
      btn('Exportar CSV', 'ghost', () => {
        const adm = ROLE === 'admin';
        const header = ['nombre', 'legajo', 'puesto', 'sector', 'grupo', 'activo', 'casco_asignado'].concat(adm ? ['dni', 'telefono'] : []);
        const cas = new Map(); EQ.assigns.filter(a => a.ends_at == null).forEach(a => cas.set(a.person_id, a.device_id));
        csvDownload('personas_' + today() + '.csv', header, EQ.people.map(p => [p.full_name, p.legajo, p.job_title, p.sector, grpName(p.group_id),
          p.active === false ? 'no' : 'si', cas.get(p.id) || ''].concat(adm ? [p.dni, p.contact_phone] : [])));
      }));
    body.append(top);
    const eb = errBox('people'); if (eb) body.append(eb);
    if (!EQ.people.length && !eb) body.append(mk('p', 'mute', 'Todavía no hay personas registradas.'));
    const cas = new Map(); EQ.assigns.filter(a => a.ends_at == null).forEach(a => cas.set(a.person_id, a.device_id));
    const ul = mk('ul');
    for (const p of EQ.people) {
      const li = mk('li', 'card eqitem');
      const head = mk('div', 'row'); head.append(mk('strong', '', p.full_name), p.active === false ? mk('span', 'tag', 'Inactiva') : mk('span', 'tag ok', 'Activa'));
      const pairs = [['Legajo', p.legajo], ['Puesto', p.job_title], ['Sector', p.sector], ['Grupo', grpName(p.group_id)], ['Casco asignado', cas.get(p.id)]];
      if (ROLE === 'admin') pairs.push(['DNI', p.dni], ['Teléfono', p.contact_phone]);
      li.append(head, kv(pairs));
      if (isAdmin()) li.append(actionRow(btn('Editar', 'ghost', () => personForm(p), 'Editar a ' + p.full_name),
        btn('Dar de baja', 'ghost', () => confirmRow(li, '¿Dar de baja a ' + p.full_name + '?', 'Sí, dar de baja', async () => {
          const { error } = await sb.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', p.id);
          if (error) $('status').textContent = dbErr(error); else loadEquipos();
        }), 'Dar de baja a ' + p.full_name)));
      ul.append(li);
    }
    body.append(ul);
  }
  function renderGroupsTab(body) {
    if (isAdmin()) body.append(actionRow(btn('Alta de grupo', '', () => groupForm(null))));
    else body.append(roNote('las altas, ediciones y bajas de grupos'));
    const eb = errBox('groups'); if (eb) body.append(eb);
    if (!EQ.groups.length && !eb) body.append(mk('p', 'mute', 'Todavía no hay grupos.'));
    const ul = mk('ul');
    for (const g of EQ.groups) {
      const li = mk('li', 'card eqitem');
      const head = mk('div', 'row'); head.append(mk('strong', '', g.name), g.active === false ? mk('span', 'tag', 'Inactivo') : mk('span', 'tag ok', 'Activo'));
      const nd = EQ.devices.filter(d => d.group_id === g.id).length, np = EQ.people.filter(p => p.group_id === g.id).length;
      li.append(head, kv([['Sitio', g.site], ['Cascos', nd], ['Personas', np], ['Notas', g.notes]]));
      if (isAdmin()) li.append(actionRow(btn('Editar', 'ghost', () => groupForm(g), 'Editar el grupo ' + g.name),
        btn('Dar de baja', 'ghost', () => confirmRow(li, '¿Dar de baja el grupo ' + g.name + '?', 'Sí, dar de baja', async () => {
          const { error } = await sb.from('groups').update({ deleted_at: new Date().toISOString() }).eq('id', g.id);
          if (error) $('status').textContent = dbErr(error); else loadEquipos();
        }), 'Dar de baja el grupo ' + g.name)));
      ul.append(li);
    }
    body.append(ul);
  }
  const histFilter = { dev: '', per: '' };
  function renderAssignTab(body) {
    const eb = errBox('assigns'); if (eb) body.append(eb);
    const devs = EQ.devices.filter(d => d.status !== 'baja'), peo = EQ.people.filter(p => p.active !== false);
    const f = mk('form', 'card section'); f.noValidate = true;
    const sd = sel([['', '(elegí un casco)'], ...devs.map(d => [d.device_id, d.device_id + ' · ' + d.name])], '');
    const sp = sel([['', '(elegí una persona)'], ...peo.map(p => [p.id, p.full_name + (p.legajo ? ' (' + p.legajo + ')' : '')])], '');
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const go = mk('button', '', 'Asignar'); go.type = 'submit';
    f.append(mk('h3', '', 'Asignar persona a casco'), fld('Casco', sd), fld('Persona', sp),
      mk('p', 'mute', 'La asignación anterior del casco y la de la persona se cierran solas.'), go, err);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      if (!sd.value || !sp.value) { err.textContent = 'Elegí un casco y una persona.'; return; }
      go.disabled = true;
      const { error } = await sb.from('assignments').insert({ device_id: sd.value, person_id: sp.value });
      go.disabled = false;
      if (error) { err.textContent = dbErr(error); return; }
      loadEquipos();
    });
    if (isAdmin()) body.append(f); else body.append(roNote('las asignaciones de personas a cascos'));
    const pname = id => { const p = EQ.people.find(x => x.id === id); return p ? p.full_name : 'persona ' + String(id).slice(0, 8); };
    body.append(mk('h3', '', 'Asignaciones vigentes'));
    const open = EQ.assigns.filter(a => a.ends_at == null);
    const ul = mk('ul');
    if (!open.length) ul.append(mk('li', 'empty mute', 'No hay asignaciones vigentes.'));
    for (const a of open) {
      const li = mk('li', 'card eqitem');
      const head = mk('div', 'row'); head.append(mk('strong', '', 'Casco ' + a.device_id), mk('span', '', pname(a.person_id)), mk('span', 'mute', 'desde ' + fmt(a.starts_at)));
      li.append(head, !isAdmin() ? mk('span') : actionRow(btn('Cerrar asignación', 'ghost', () => confirmRow(li, '¿Cerrar la asignación de ' + pname(a.person_id) + ' al casco ' + a.device_id + '?', 'Sí, cerrar', async () => {
        const { error } = await sb.from('assignments').update({ ends_at: new Date().toISOString() }).eq('id', a.id);
        if (error) $('status').textContent = dbErr(error); else loadEquipos();
      }), 'Cerrar la asignación del casco ' + a.device_id)));
      ul.append(li);
    }
    body.append(ul);
    body.append(mk('h3', '', 'Historial'));
    const hd = sel([['', 'Todos los cascos'], ...EQ.devices.map(d => [d.device_id, d.device_id + ' · ' + d.name])], histFilter.dev);
    const hp = sel([['', 'Todas las personas'], ...EQ.people.map(p => [p.id, p.full_name])], histFilter.per);
    const hist = mk('ul');
    const draw = () => {
      histFilter.dev = hd.value; histFilter.per = hp.value;
      const rows = EQ.assigns.filter(a => (!hd.value || a.device_id === hd.value) && (!hp.value || a.person_id === hp.value));
      hist.replaceChildren(...(rows.length ? rows.map(a => {
        const li = mk('li', 'bcitem');
        li.append(mk('div', '', 'Casco ' + a.device_id + ' · ' + pname(a.person_id)),
          mk('div', 'mute', fmt(a.starts_at) + ' → ' + (a.ends_at ? fmt(a.ends_at) : 'vigente')));
        return li;
      }) : [mk('li', 'empty mute', 'Sin asignaciones para ese filtro.')]));
    };
    hd.addEventListener('change', draw); hp.addEventListener('change', draw);
    const frow = mk('div', 'grid2'); frow.append(fld('Por casco', hd), fld('Por persona', hp));
    body.append(frow, hist); draw();
  }
  function renderEq() {
    const body = $('eqBody'); body.replaceChildren();
    for (const [k, id] of [['dev', 'eqTabDev'], ['people', 'eqTabPeople'], ['groups', 'eqTabGroups'], ['assign', 'eqTabAssign']]) {
      $(id).setAttribute('aria-selected', String(EQ.sub === k)); $(id).tabIndex = EQ.sub === k ? 0 : -1;
    }
    if (!EQ.loaded) { body.append(mk('p', 'mute', 'Cargando…')); return; }
    if (EQ.sub === 'dev') renderDevTab(body);
    else if (EQ.sub === 'people') renderPeopleTab(body);
    else if (EQ.sub === 'groups') renderGroupsTab(body);
    else renderAssignTab(body);
  }
  for (const [id, k] of [['eqTabDev', 'dev'], ['eqTabPeople', 'people'], ['eqTabGroups', 'groups'], ['eqTabAssign', 'assign']]) {
    $(id).addEventListener('click', () => { EQ.sub = k; closeEqForm(); renderEq(); });
  }
  $('eqTabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const keys = ['dev', 'people', 'groups', 'assign'], ids = ['eqTabDev', 'eqTabPeople', 'eqTabGroups', 'eqTabAssign'];
    const i = (keys.indexOf(EQ.sub) + (e.key === 'ArrowRight' ? 1 : 3)) % 4;
    EQ.sub = keys[i]; closeEqForm(); renderEq(); $(ids[i]).focus();
  });

  // ======================================================================
  // Georreferencia: ubicacion, geocercas, puntos de interes y mapa (docs/PROTOCOLO-GEO.md)
  // ======================================================================
  const TRAIL_MS = 2 * 60 * 60 * 1000, TRAIL_MAX = 200;
  const lastPos = new Map();   // device_id -> { lat, lng, at, battery }
  const trail = new Map();     // device_id -> [{ lat, lng, at }]
  let geofences = [], geoPoints = [], geoErr = { z: null, p: null };
  const KIND_LBL = { permitida: 'Permitida (alerta al salir)', restringida: 'Restringida (alerta al entrar)', informativa: 'Informativa (sin alarma)' };
  const KIND_COL = { permitida: '#2e7d32', restringida: '#c62828', informativa: '#1565c0' };
  const CAT_LBL = { punto_reunion: 'Punto de reunión', extintor: 'Extintor', botiquin: 'Botiquín', acceso: 'Acceso', peligro: 'Peligro', otro: 'Otro' };
  const CAT_COL = { punto_reunion: '#2e7d32', extintor: '#e65100', botiquin: '#00838f', acceso: '#5d4037', peligro: '#c62828', otro: '#546e7a' };
  const CAT_GLYPH = { punto_reunion: 'R', extintor: 'E', botiquin: '+', acceso: 'A', peligro: '!', otro: '•' };
  const ALARM_LBL = { voz: 'Voz', sirena: 'Sirena', voz_y_sirena: 'Voz y sirena' };
  // Posicion valida: numeros finitos en rango y distinta de 0,0 exacto (el casco mandaba 0,0 sin fix).
  const llOk = (a, b) => typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
  const hav = (a, b, c, d) => {
    const R = 6371000, r = x => x * Math.PI / 180, dl = r(c - a), dn = r(d - b);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const fmtDist = m => (m < 1000 ? Math.round(m) + ' m' : n1(m / 1000) + ' km');
  const coordTxt = (la, ln) => la.toFixed(5) + ', ' + ln.toFixed(5);
  const FRESH_MS = 5 * 60 * 1000, NOFIX_MS = 10 * 60 * 1000, JUMP_M = 200000;
  // Ultima posicion valida de cada casco. fixT = momento real del fix (created_at menos payload.age_s si el casco
  // reenvia su ultimo fix conocido: payload.src 'last_known').
  function noteLoc(ev) {
    const la = numOf(ev.lat), ln = numOf(ev.lng);
    if (!ev.device_id || !llOk(la, ln)) return;
    const at = ev.created_at, t = new Date(at).getTime();
    if (!isFinite(t)) return;
    const pl = ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? ev.payload : {};
    const ageS = numOf(pl.age_s), src = typeof pl.src === 'string' ? pl.src.slice(0, 20) : '';
    const reused = src === 'last_known' || (ageS != null && ageS > 30);
    const fixT = t - (ageS != null && ageS > 0 ? ageS * 1000 : 0);
    const accRaw = pl.acc_m != null ? pl.acc_m : pl.acc != null ? pl.acc : pl.accuracy;
    const cur = lastPos.get(ev.device_id);
    if (!cur || fixT >= cur.fixT) lastPos.set(ev.device_id, { lat: la, lng: ln, at, fixT, reused, src, acc: numOf(accRaw), battery: numOf(ev.battery) });
    if (!reused) {   // un fix reenviado no es un punto nuevo del recorrido
      let arr = trail.get(ev.device_id); if (!arr) trail.set(ev.device_id, arr = []);
      let i = arr.length; while (i > 0 && arr[i - 1].t > t) i--;   // insercion ordenada (la carga llega mas-nuevo-primero)
      if (!(i > 0 && arr[i - 1].t === t)) {
        arr.splice(i, 0, { lat: la, lng: ln, at, t });
        const lim = Date.now() - TRAIL_MS;
        while (arr.length && arr[0].t < lim) arr.shift();
        if (arr.length > TRAIL_MAX) arr.splice(0, arr.length - TRAIL_MAX);   // tope de memoria por casco
      }
    }
    scheduleMap();
  }
  async function loadLocations() {
    // Recorrido de 2 h (lo MAS RECIENTE primero y por casco) + ultima posicion conocida SIN limite de tiempo.
    try {
      const since = new Date(Date.now() - TRAIL_MS).toISOString();
      const COLS = 'device_id,created_at,lat,lng,battery,payload';
      const hasPos = q => q.not('lat', 'is', null).not('lng', 'is', null);
      const ids = knownDevices();
      const qs = [];
      if (ids.length) {
        for (const id of ids) {
          qs.push(hasPos(sb.from('events').select(COLS).eq('type', 'location').eq('device_id', id).gte('created_at', since)).order('created_at', { ascending: false }).limit(600));
          // ultimo evento con posicion de cualquier tipo, sin ventana (limit 8: salta los 0,0 / invalidos)
          qs.push(hasPos(sb.from('events').select(COLS).in('type', ['location', 'sos', 'fall', 'photo', 'video', 'geofence', 'not_worn', 'inactive']).eq('device_id', id)).order('created_at', { ascending: false }).limit(8));
        }
      } else {
        qs.push(hasPos(sb.from('events').select(COLS).eq('type', 'location').gte('created_at', since)).order('created_at', { ascending: false }).limit(3000));
      }
      const rs = await Promise.all(qs);
      for (const r of rs) if (!r.error && Array.isArray(r.data)) r.data.forEach(noteLoc);
    } catch (_) {}
    renderMapLists(); renderDevices(); evalHealth();
  }
  // Texto de frescura de la posicion: GPS en vivo (<= 5 min) o ultima conocida.
  function posInfo(p, now) {
    const age = now - p.fixT, fresh = !p.reused && age <= FRESH_MS;
    return {
      fresh, age,
      src: fresh ? 'GPS en vivo' : 'Última posición conocida',
      txt: fresh ? 'GPS en vivo · hace ' + ago(age).replace(/^hace /, '')
        : 'Última posición conocida hace ' + ago(age).replace(/^hace /, '') + ' (sin señal GPS: bajo techo o sin cielo)',
      acc: p.acc != null ? ' · precisión ' + Math.round(p.acc) + ' m' : '',
    };
  }
  const zoneOk = z => z && typeof z.id === 'string' && z.geometry && typeof z.geometry === 'object' &&
    ((z.shape === 'circle' && Array.isArray(z.geometry.center) && llOk(z.geometry.center[0], z.geometry.center[1]) && numOf(z.geometry.radius_m) > 0) ||
     (z.shape === 'polygon' && Array.isArray(z.geometry.points) && z.geometry.points.length >= 3 && z.geometry.points.every(p => Array.isArray(p) && llOk(p[0], p[1]))));
  async function loadGeo() {
    try {
      const z = await sb.from('geofences').select('id,name,kind,shape,geometry,message,alarm,device_ids,active,deleted_at').is('deleted_at', null).order('created_at', { ascending: false });
      geoErr.z = z.error || null;
      if (!z.error && Array.isArray(z.data)) geofences = z.data.filter(zoneOk);
    } catch (e) { geoErr.z = e; }
    try {
      const p = await sb.from('geo_points').select('id,name,category,lat,lng,notes,alert_radius_m,message,alarm,active,deleted_at').is('deleted_at', null).order('created_at', { ascending: false });
      geoErr.p = p.error || null;
      if (!p.error && Array.isArray(p.data)) geoPoints = p.data.filter(x => x && typeof x.id === 'string' && llOk(numOf(x.lat), numOf(x.lng)))
        .map(x => ({ ...x, lat: Number(x.lat), lng: Number(x.lng) }));
    } catch (e) { geoErr.p = e; }
    renderMapLists(); scheduleMap(); refreshGeoInfos();
  }
  let geoTimer = null;
  const reloadGeo = () => { clearTimeout(geoTimer); geoTimer = setTimeout(loadGeo, 400); };

  // Posicion + punto de reunion mas cercano en cada SOS / caida / geocerca
  const geoInfos = new Map();   // clave -> { el, ev }
  function evPos(ev) {
    const la = numOf(ev.lat), ln = numOf(ev.lng);
    if (llOk(la, ln)) return { lat: la, lng: ln, approx: false };
    const p = lastPos.get(ev.device_id);
    return p ? { lat: p.lat, lng: p.lng, approx: true, at: p.at } : null;
  }
  function nearestMeet(lat, lng) {
    let best = null;
    for (const p of geoPoints) {
      if (p.category !== 'punto_reunion' || p.active === false) continue;
      const d = hav(lat, lng, p.lat, p.lng);
      if (!best || d < best.d) best = { p, d };
    }
    return best;
  }
  function fillGeoInfo(el, ev) {
    const pos = evPos(ev);
    const kids = [];
    if (!pos) { el.replaceChildren(mk('span', 'mute', 'Sin posición conocida del casco.')); return; }
    kids.push(mk('span', '', (pos.approx ? 'Última posición conocida: ' : 'Posición: ') + coordTxt(pos.lat, pos.lng)));
    const b = mk('button', 'ghost', 'Ver en mapa'); b.type = 'button';
    b.setAttribute('aria-label', 'Ver en el mapa la posición del casco ' + ev.device_id);
    b.addEventListener('click', () => showOnMap(pos.lat, pos.lng, label(ev.device_id)));
    kids.push(b);
    const m = nearestMeet(pos.lat, pos.lng);
    kids.push(mk('span', '', m ? 'Punto de reunión más cercano: ' + m.p.name + ' a ' + fmtDist(m.d) : 'Sin puntos de reunión cargados.'));
    el.replaceChildren(...kids);
  }
  function geoInfoEl(key, ev) {
    const el = mk('div', 'row geoinfo mute');
    geoInfos.set(key, { el, ev });
    fillGeoInfo(el, ev);
    return el;
  }
  function refreshGeoInfos() {
    for (const [k, g] of geoInfos) { if (!g.el.isConnected) { geoInfos.delete(k); continue; } fillGeoInfo(g.el, g.ev); }
  }

  // ---- lista en texto (alternativa accesible al mapa) ----
  function renderMapLists() {
    const dl = $('mapDevList'), zl = $('mapZoneList'); if (!dl || !zl) return;
    const ids = [...new Set([...devState.keys(), ...lastPos.keys()])].filter(i => DEV_RE.test(i)).sort();
    dl.replaceChildren(...(ids.length ? ids.map(id => {
      const li = mk('li', 'bcitem');
      const s = devState.get(id), p = lastPos.get(id), on = s && Date.now() - new Date(s.at).getTime() <= OFFLINE_MS;
      const head = mk('div', 'row'); head.append(dlEl('strong', id, '', ''), mk('span', on ? '' : 'state bad', on ? 'En línea' : 'Sin señal'));
      const bat = s ? batOf(s) : (p ? p.battery : null);
      const pi = p ? posInfo(p, Date.now()) : null;
      li.append(head, mk('div', 'mute', p ? 'Ubicación: ' + coordTxt(p.lat, p.lng) + ' · ' + pi.txt + pi.acc + ' · ' + fmt(p.fixT) + (bat != null ? ' · batería ' + n1(bat) + ' %' : '')
        : 'Sin posición registrada todavía (el casco aún no mandó un fix GPS válido)'));
      if (p) li.append(actionRow(btn('Centrar en este casco', 'ghost', () => showOnMap(p.lat, p.lng, label(id)), 'Centrar el mapa en el casco ' + id)));
      return li;
    }) : [mk('li', 'empty mute', 'Sin cascos con posición todavía.')]));
    const items = [];
    for (const z of geofences) {
      const li = mk('li', 'bcitem');
      const head = mk('div', 'row');
      head.append(mk('span', 'tag', 'ZONA'), mk('strong', '', z.name), mk('span', 'tag', KIND_LBL[z.kind] || String(z.kind)), z.active === false ? mk('span', 'tag', 'Desactivada') : mk('span', 'tag ok', 'Activa'));
      const g = z.geometry, c = z.shape === 'circle' ? g.center : g.points[0];
      li.append(head, mk('div', 'mute', (z.shape === 'circle' ? 'Círculo · centro ' + coordTxt(g.center[0], g.center[1]) + ' · radio ' + n1(Number(g.radius_m)) + ' m'
        : 'Polígono de ' + g.points.length + ' puntos · primer vértice ' + coordTxt(g.points[0][0], g.points[0][1])) +
        ' · alarma: ' + (ALARM_LBL[z.alarm] || z.alarm) + ' · cascos: ' + (Array.isArray(z.device_ids) ? z.device_ids.join(', ') : 'todos') + (z.message ? ' · “' + z.message + '”' : '')));
      li.append(actionRow(...[btn('Centrar', 'ghost', () => showOnMap(c[0], c[1], z.name), 'Centrar el mapa en la zona ' + z.name)].concat(!isAdmin() ? [] : [
        btn('Editar', 'ghost', () => openZoneForm(z), 'Editar la zona ' + z.name),
        btn(z.active === false ? 'Activar' : 'Desactivar', 'ghost', async () => {
          const { error } = await sb.from('geofences').update({ active: z.active === false }).eq('id', z.id);
          if (error) $('status').textContent = dbErr(error); else loadGeo();
        }, (z.active === false ? 'Activar' : 'Desactivar') + ' la zona ' + z.name),
        btn('Dar de baja', 'ghost', () => confirmRow(li, '¿Dar de baja la zona ' + z.name + '?', 'Sí, dar de baja', async () => {
          const { error } = await sb.from('geofences').update({ deleted_at: new Date().toISOString() }).eq('id', z.id);
          if (error) $('status').textContent = dbErr(error); else loadGeo();
        }), 'Dar de baja la zona ' + z.name)])));
      items.push(li);
    }
    for (const p of geoPoints) {
      const li = mk('li', 'bcitem');
      const head = mk('div', 'row');
      head.append(mk('span', 'tag', 'PUNTO'), mk('strong', '', p.name), mk('span', 'tag', CAT_LBL[p.category] || String(p.category)), p.active === false ? mk('span', 'tag', 'Desactivado') : mk('span', 'tag ok', 'Activo'));
      li.append(head, mk('div', 'mute', coordTxt(p.lat, p.lng) + (p.category === 'peligro' ? ' · radio de alerta ' + p.alert_radius_m + ' m' : '') + (p.notes ? ' · ' + p.notes : '')));
      li.append(actionRow(...[btn('Centrar', 'ghost', () => showOnMap(p.lat, p.lng, p.name), 'Centrar el mapa en ' + p.name)].concat(!isAdmin() ? [] : [
        btn('Editar', 'ghost', () => openPointForm(null, p), 'Editar el punto ' + p.name),
        btn(p.active === false ? 'Activar' : 'Desactivar', 'ghost', async () => {
          const { error } = await sb.from('geo_points').update({ active: p.active === false }).eq('id', p.id);
          if (error) $('status').textContent = dbErr(error); else loadGeo();
        }, (p.active === false ? 'Activar' : 'Desactivar') + ' el punto ' + p.name),
        btn('Dar de baja', 'ghost', () => confirmRow(li, '¿Dar de baja el punto ' + p.name + '?', 'Sí, dar de baja', async () => {
          const { error } = await sb.from('geo_points').update({ deleted_at: new Date().toISOString() }).eq('id', p.id);
          if (error) $('status').textContent = dbErr(error); else loadGeo();
        }), 'Dar de baja el punto ' + p.name)])));
      items.push(li);
    }
    const errs = [];
    if (geoErr.z) errs.push(mk('li', 'state bad', 'Geocercas: ' + dbMsg(geoErr.z)));
    if (geoErr.p) errs.push(mk('li', 'state bad', 'Puntos de interés: ' + dbMsg(geoErr.p)));
    zl.replaceChildren(...errs, ...(items.length ? items : [mk('li', 'empty mute', 'Todavía no hay zonas ni puntos de interés.')]));
  }

  // ---- mapa (Leaflet 1.9.4, version fijada desde cdnjs; se carga la primera vez que se abre la pestana) ----
  const LF_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const LF_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=', LF_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  let map = null, mapState = 'idle', LF = null, tileLayer = null, tileOk = 0, tileBad = 0, mapTimer = null;
  const grp = {};
  const MAPLAYERS = [['cascos', 'Cascos'], ['recorrido', 'Recorrido (2 h)'], ['zonas', 'Geocercas'], ['puntos', 'Puntos de interés']];
  const layerOn = { cascos: true, recorrido: false, zonas: true, puntos: true };
  function setMapWarn(t) { const w = $('mapWarn'); w.textContent = t || ''; w.classList.toggle('hidden', !t); }
  function loadLeaflet() {
    return new Promise((ok, ko) => {
      if (window.L && window.L.map) return ok();
      const css = mk('link'); css.rel = 'stylesheet'; css.href = LF_BASE + 'leaflet.css'; css.integrity = LF_CSS_SRI; css.crossOrigin = 'anonymous';
      document.head.append(css);
      const js = mk('script'); js.src = LF_BASE + 'leaflet.js'; js.integrity = LF_JS_SRI; js.crossOrigin = 'anonymous';
      js.onload = () => (window.L && window.L.map ? ok() : ko(new Error('leaflet'))); js.onerror = () => ko(new Error('leaflet'));
      document.head.append(js);
    });
  }
  async function ensureMap() {
    if (mapState === 'ready') { map.invalidateSize(); if (!mapTouched) fitCascos(); return true; }
    if (mapState === 'failed') return false;
    if (mapState === 'loading') return new Promise(r => { const t = setInterval(() => { if (mapState !== 'loading') { clearInterval(t); r(mapState === 'ready'); } }, 100); });
    mapState = 'loading';
    try { await loadLeaflet(); } catch (_) {
      mapState = 'failed';
      setMapWarn('No se pudo cargar el mapa (sin acceso a la biblioteca de mapas). Usá las listas de abajo: tienen las mismas posiciones y zonas.');
      return false;
    }
    LF = window.L;
    map = LF.map('mapBox', { zoomControl: true, attributionControl: true }).setView([-34.6, -58.4], 12);
    tileLayer = LF.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).addTo(map);
    tileLayer.on('tileload', () => { tileOk++; });
    tileLayer.on('tileerror', () => { tileBad++; if (tileBad >= 3 && tileOk === 0) setMapWarn('No se pudieron cargar las teselas del mapa (sin conexión con OpenStreetMap). Las listas de abajo siguen funcionando.'); });
    for (const [k] of MAPLAYERS) grp[k] = LF.layerGroup().addTo(map);
    grp.draft = LF.layerGroup().addTo(map);
    grp.focus = LF.layerGroup().addTo(map);
    map.on('click', e => onMapClick(e.latlng));
    map.on('mousemove', e => onMapMove(e.latlng));
    map.on('contextmenu', e => openPointForm(e.latlng));   // clic derecho o mantener presionado
    mapState = 'ready';
    let fit = false;
    drawMap();
    map.on('dragstart zoomstart', e => { if (e.originalEvent !== undefined || e.type === 'dragstart') mapTouched = true; });
    if (fitCascos()) fit = true;
    if (!fit && geofences.length) { const z = geofences[0]; const c = z.shape === 'circle' ? z.geometry.center : z.geometry.points[0]; map.setView([c[0], c[1]], 14); }
    map.invalidateSize();
    return true;
  }
  function scheduleMap() { if (mapState !== 'ready') return; clearTimeout(mapTimer); mapTimer = setTimeout(drawMap, 150); }
  const pendDev = () => new Set([...pending.values()].map(e => e.device_id));
  function drawMap() {
    if (mapState !== 'ready') return;
    for (const [k] of MAPLAYERS) grp[k].clearLayers();
    const alertDev = pendDev(), now = Date.now();
    const TR_COL = ['#1565c0', '#6a1b9a', '#00838f', '#ef6c00', '#2e7d32', '#ad1457'];
    let ti = 0;
    for (const [id, p] of lastPos) {
      if (!DEV_RE.test(id)) continue;
      const s = devState.get(id), on = s && now - new Date(s.at).getTime() <= OFFLINE_MS, al = alertDev.has(id);
      const col = al ? '#c62828' : on ? '#2e7d32' : '#616161';
      const bat = s ? batOf(s) : p.battery;
      const pi = posInfo(p, now);
      const stTxt = al ? 'ALERTA sin atender' : on ? 'En línea' : 'Sin señal';
      const pop = mk('div'); pop.append(mk('strong', '', label(id)), mk('div', '', stTxt),
        mk('div', '', 'Hora del fix: ' + fmt(p.fixT)), mk('div', '', 'Fuente: ' + pi.txt),
        mk('div', '', p.acc != null ? 'Precisión: ' + Math.round(p.acc) + ' m' : 'Precisión: —'), mk('div', '', bat != null ? 'Batería: ' + n1(bat) + ' %' : 'Batería: —'));
      // Icono de casco (norte arriba) con el id; atenuado y con borde punteado si el fix es viejo.
      const dash = pi.fresh ? '' : ' stroke-dasharray="3 2"';
      const html = '<span class="hm-w' + (pi.fresh ? '' : ' hm-old') + (al ? ' hm-al' : '') + '"><svg width="36" height="30" viewBox="0 0 36 30" aria-hidden="true">' +
        '<path d="M4 22a14 14 0 0 1 28 0z" fill="' + col + '" stroke="#fff" stroke-width="2"' + dash + '/>' +
        '<rect x="1.5" y="21" width="33" height="5.5" rx="2.5" fill="' + col + '" stroke="#fff" stroke-width="2"' + dash + '/>' +
        '<path d="M18 9v11" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg><b class="hm-id">' + id + '</b></span>';
      const icon = LF.divIcon({ className: 'hm', html, iconSize: [48, 44], iconAnchor: [24, 36], popupAnchor: [0, -34] });
      LF.marker([p.lat, p.lng], { icon, title: label(id) + ' · ' + pi.src, keyboard: true, zIndexOffset: al ? 1000 : 0 }).bindPopup(pop).addTo(grp.cascos);
      // Recorrido: solo entre puntos validos consecutivos; se corta ante saltos > 200 km.
      const tr = trail.get(id);
      if (tr && tr.length > 1) {
        const segs = []; let curSeg = [], prev = null;
        for (const x of tr) {
          if (prev && hav(prev.lat, prev.lng, x.lat, x.lng) > JUMP_M) { segs.push(curSeg); curSeg = []; }
          curSeg.push([x.lat, x.lng]); prev = x;
        }
        segs.push(curSeg);
        const color = TR_COL[ti++ % TR_COL.length];
        for (const sg of segs) if (sg.length > 1) LF.polyline(sg, { color, weight: 3, opacity: 0.8 }).bindTooltip(mk('span', '', 'Recorrido 2 h · casco ' + id)).addTo(grp.recorrido);
      }
    }
    // marcadores de SOS / caida / geocerca sin atender con posicion
    for (const ev of pending.values()) {
      const pos = evPos(ev); if (!pos) continue;
      const pop = mk('div'); pop.append(mk('strong', '', alertLabel(ev)), mk('div', '', label(ev.device_id)), mk('div', '', fmt(ev.created_at)));
      LF.circleMarker([pos.lat, pos.lng], { radius: 14, color: '#c62828', weight: 3, fillColor: '#c62828', fillOpacity: 0.25 }).bindPopup(pop).addTo(grp.cascos);
    }
    for (const z of geofences) {
      const col = KIND_COL[z.kind] || '#546e7a', st = { color: col, weight: 2, fillColor: col, fillOpacity: z.active === false ? 0.04 : 0.15, dashArray: z.active === false ? '6 6' : null };
      const pop = mk('div'); pop.append(mk('strong', '', z.name), mk('div', '', KIND_LBL[z.kind] || z.kind), mk('div', '', 'Alarma: ' + (ALARM_LBL[z.alarm] || z.alarm)),
        mk('div', '', z.active === false ? 'Desactivada' : 'Activa'));
      if (z.message) pop.append(mk('div', '', '“' + z.message + '”'));
      if (isAdmin()) { const eb = mk('button', 'ghost', 'Editar'); eb.type = 'button'; eb.addEventListener('click', () => openZoneForm(z)); pop.append(eb); }
      const layer = z.shape === 'circle' ? LF.circle(z.geometry.center, { ...st, radius: Number(z.geometry.radius_m) }) : LF.polygon(z.geometry.points, st);
      layer.bindPopup(pop).addTo(grp.zonas);
    }
    for (const p of geoPoints) {
      const col = CAT_COL[p.category] || '#546e7a';
      const icon = LF.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: '<span style="display:block;width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-sizing:border-box;background:' + col +
          ';color:#fff;font:700 15px/22px system-ui;text-align:center">' + (CAT_GLYPH[p.category] || '•') + '</span>' });
      const m = LF.marker([p.lat, p.lng], { icon, opacity: p.active === false ? 0.5 : 1, title: p.name, keyboard: true });
      const pop = mk('div'); pop.append(mk('strong', '', p.name), mk('div', '', CAT_LBL[p.category] || p.category));
      if (p.category === 'peligro') pop.append(mk('div', '', 'Radio de alerta: ' + p.alert_radius_m + ' m'));
      if (p.notes) pop.append(mk('div', '', p.notes));
      m.bindPopup(pop).addTo(grp.puntos);
      if (p.category === 'peligro') LF.circle([p.lat, p.lng], { radius: Number(p.alert_radius_m) || 30, color: col, weight: 1, fillColor: col, fillOpacity: 0.12 }).addTo(grp.puntos);
    }
    for (const [k] of MAPLAYERS) { if (layerOn[k]) map.addLayer(grp[k]); else map.removeLayer(grp[k]); }
    if (!mapFitted && lastPos.size) fitCascos();
  }
  // Encuadra el mapa en los cascos con posicion (el que tiene alerta primero; si es uno solo, zoom 16).
  let mapFitted = false, mapTouched = false;
  function fitCascos() {
    if (mapState !== 'ready' || !lastPos.size) return false;
    const al = pendDev();
    let pts = [...lastPos].filter(([id]) => al.has(id)).map(([, p]) => [p.lat, p.lng]);
    if (!pts.length) pts = [...lastPos.values()].map(p => [p.lat, p.lng]);
    if (pts.length === 1) map.setView(pts[0], 16); else map.fitBounds(LF.latLngBounds(pts).pad(0.3), { maxZoom: 16 });
    mapFitted = true;
    return true;
  }
  async function showOnMap(lat, lng, text) {
    showTab('map');
    const ok = await ensureMap();
    if (!ok) return;
    map.setView([lat, lng], 16);
    mapTouched = true;
    grp.focus.clearLayers();
    const pop = mk('div', '', text || '');
    LF.circleMarker([lat, lng], { radius: 16, color: '#1565c0', weight: 3, fillOpacity: 0 }).bindPopup(pop).addTo(grp.focus).openPopup();
  }
  // ---- herramientas de dibujo ----
  const G = { mode: null, pts: [], center: null };
  const modeBtns = { circle: 'gDrawCircle', polygon: 'gDrawPoly', point: 'gAddPoint' };
  function setMode(m) {
    G.mode = m; G.pts = []; G.center = null;
    if (grp.draft) grp.draft.clearLayers();
    for (const [k, id] of Object.entries(modeBtns)) $(id).setAttribute('aria-pressed', String(m === k));
    if (map) {
      map.getContainer().style.cursor = m ? 'crosshair' : '';
      map.getContainer().classList.toggle('drawing', !!m);   // al dibujar, zonas y marcadores no capturan el clic
      if (m) map.closePopup();
      if (m) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();   // clics rapidos al dibujar no hacen zoom
    }
    const hint = $('geoHint');
    hint.textContent = m === 'circle' ? 'Hacé clic en el mapa para marcar el centro y otro clic para fijar el radio. También podés escribir las coordenadas en el formulario.'
      : m === 'polygon' ? 'Hacé clic en el mapa para agregar vértices (mínimo 3) y tocá "Cerrar polígono".'
      : m === 'point' ? 'Hacé clic en el mapa donde va el punto de interés.' : '';
    hint.classList.toggle('hidden', !m);
    $('polyBar').classList.toggle('hidden', m !== 'polygon');
  }
  function drawDraft() {
    if (!grp.draft) return;
    grp.draft.clearLayers();
    const st = { color: '#ef6c00', weight: 3, dashArray: '6 6', fillOpacity: 0.1 };
    if (G.mode === 'polygon' && G.pts.length) {
      G.pts.forEach(p => LF.circleMarker(p, { radius: 5, color: '#ef6c00', fillOpacity: 1 }).addTo(grp.draft));
      if (G.pts.length > 1) LF.polyline(G.pts, st).addTo(grp.draft);
    }
    if (G.mode === 'circle' && G.center) LF.circleMarker(G.center, { radius: 5, color: '#ef6c00', fillOpacity: 1 }).addTo(grp.draft);
  }
  async function startMode(m) {
    const ok = await ensureMap();
    if (!ok) {   // sin mapa: se pueden cargar circulos y puntos escribiendo las coordenadas
      if (m === 'circle') openZoneForm(null, { shape: 'circle' });
      else if (m === 'point') openPointForm(null);
      else $('geoHint').classList.remove('hidden'), $('geoHint').textContent = 'Para dibujar un polígono hace falta el mapa.';
      return;
    }
    closeGeoForm(); setMode(G.mode === m ? null : m);
  }
  function onMapClick(ll) {
    if (!G.mode) return;
    if (G.mode === 'circle') {
      if (!G.center) { G.center = [ll.lat, ll.lng]; drawDraft(); return; }
      const r = Math.min(50000, Math.max(10, Math.round(hav(G.center[0], G.center[1], ll.lat, ll.lng))));
      const c = G.center; setMode(null); openZoneForm(null, { shape: 'circle', center: c, radius: r });
    } else if (G.mode === 'polygon') { G.pts.push([ll.lat, ll.lng]); drawDraft(); $('polyCount').textContent = G.pts.length + ' vértices'; }
    else if (G.mode === 'point') { setMode(null); openPointForm(ll); }
  }
  function onMapMove(ll) {
    if (G.mode !== 'circle' || !G.center || !grp.draft) return;
    drawDraft();
    LF.circle(G.center, { radius: Math.max(10, hav(G.center[0], G.center[1], ll.lat, ll.lng)), color: '#ef6c00', weight: 2, dashArray: '6 6', fillOpacity: 0.1 }).addTo(grp.draft);
  }
  // ---- formularios de zona y punto ----
  function closeGeoForm() { $('geoForm').replaceChildren(); $('geoForm').classList.add('hidden'); }
  function geoFormShell(title, fields, spec, onSave) {
    const f = mk('form', 'card section'); f.noValidate = true;
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const go = mk('button', '', 'Guardar'); go.type = 'submit';
    const no = mk('button', 'ghost', 'Cancelar'); no.type = 'button';
    no.addEventListener('click', () => { closeGeoForm(); setMode(null); });
    f.append(mk('h3', '', title), ...fields, actionRow(go, no), err);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const r = collect(spec);
      if (r.errors.length) { err.textContent = r.errors.join(' '); return; }
      const extra = onSave.validate ? onSave.validate(r.v) : '';
      if (extra) { err.textContent = extra; return; }
      go.disabled = true; const msg = await onSave(r.v); go.disabled = false;
      if (msg) { err.textContent = msg; return; }
      closeGeoForm(); setMode(null); loadGeo();
    });
    $('geoForm').replaceChildren(f); $('geoForm').classList.remove('hidden');
    const first = f.querySelector('input,select'); if (first) first.focus();
    $('geoForm').scrollIntoView({ block: 'nearest' });
  }
  function destOpts() { return [['', 'Todos los cascos'], ...knownDevices().map(i => [i, label(i)])]; }
  function openZoneForm(z, draw) {
    if (!isAdmin()) return;
    showTab('map');
    const edit = !!z, shape = edit ? z.shape : draw.shape;
    const cur = z || {};
    const name = inp('text', cur.name || '', { maxLength: 80 });
    const kind = sel(Object.entries(KIND_LBL), cur.kind || 'restringida');
    const alarm = sel(Object.entries(ALARM_LBL), cur.alarm || 'voz_y_sirena');
    const msg = inp('text', cur.message || '', { maxLength: 140 });
    const cur1 = Array.isArray(cur.device_ids) && cur.device_ids.length === 1 ? cur.device_ids[0] : '';
    const dest = sel(destOpts(), cur1);
    const spec = [
      { k: 'name', el: name, label: 'Nombre', req: true, max: 80 },
      { k: 'kind', el: kind, label: 'Tipo' }, { k: 'alarm', el: alarm, label: 'Alarma' },
      { k: 'message', el: msg, label: 'Mensaje', max: 140 }, { k: 'dest', el: dest, label: 'Casco' },
    ];
    const fields = [fld('Nombre de la zona', name), fld('Tipo', kind), fld('Alarma en el casco', alarm), fld('Mensaje que dice el casco (opcional)', msg), fld('Casco destino', dest)];
    let la = null, ln = null, rad = null, ptsTxt = null;
    if (shape === 'circle') {
      const c = edit ? cur.geometry.center : (draw && draw.center) || ['', ''];
      la = inp('text', c[0] === '' ? '' : String(c[0]), { inputMode: 'decimal' }); ln = inp('text', c[1] === '' ? '' : String(c[1]), { inputMode: 'decimal' });
      rad = inp('text', edit ? String(cur.geometry.radius_m) : (draw && draw.radius ? String(draw.radius) : '100'), { inputMode: 'numeric' });
      fields.push(fld('Latitud del centro', la), fld('Longitud del centro', ln), fld('Radio en metros (10 a 50000)', rad));
    } else if (edit) fields.push(mk('p', 'mute', 'El polígono tiene ' + cur.geometry.points.length + ' vértices. Para cambiar la forma, dibujá una zona nueva y dala de baja.'));
    const actC = inp('checkbox'); actC.checked = edit ? cur.active !== false : true;
    const chk = mk('label', 'chk'); chk.append(actC, 'Zona activa'); fields.push(chk);
    if (shape === 'polygon' && !edit) {
      const n = (draw && draw.points ? draw.points.length : 0);
      fields.unshift(mk('p', 'mute', 'Polígono de ' + n + ' vértices.'));
    }
    const onSave = async v => {
      const row = { name: v.name, kind: v.kind, alarm: v.alarm, message: v.message === '' ? null : v.message, device_ids: v.dest ? [v.dest] : null };
      let geometry;
      if (shape === 'circle') geometry = { center: [Number(String(la.value).replace(',', '.')), Number(String(ln.value).replace(',', '.'))], radius_m: Number(String(rad.value).replace(',', '.')) };
      else if (!edit) geometry = { points: draw.points };
      if (edit) {
        const upd = { name: row.name, kind: row.kind, alarm: row.alarm, message: row.message, device_ids: row.device_ids, active: actC.checked };
        if (shape === 'circle') upd.geometry = geometry;
        const { error } = await sb.from('geofences').update(upd).eq('id', cur.id);
        return error ? dbErr(error) : '';
      }
      const { error } = await sb.from('geofences').insert({ ...row, shape, geometry, active: actC.checked });
      return error ? dbErr(error) : '';
    };
    onSave.validate = () => {
      if (shape === 'circle') {
        const a = Number(String(la.value).replace(',', '.')), b = Number(String(ln.value).replace(',', '.')), r = Number(String(rad.value).replace(',', '.'));
        if (!llOk(a, b) || la.value === '' || ln.value === '') return 'Latitud o longitud inválida (lat -90 a 90, lng -180 a 180).';
        if (!(r >= 10 && r <= 50000)) return 'El radio debe estar entre 10 y 50000 metros.';
      } else if (!edit && (!draw.points || draw.points.length < 3)) return 'El polígono necesita al menos 3 vértices.';
      return '';
    };
    geoFormShell(edit ? 'Editar zona' : (shape === 'circle' ? 'Nueva zona circular' : 'Nueva zona poligonal'), fields, spec, onSave);
  }
  function openPointForm(ll, p) {
    if (!isAdmin()) return;
    showTab('map');
    const edit = !!p, cur = p || {};
    const name = inp('text', cur.name || '', { maxLength: 80 });
    const cat = sel(Object.entries(CAT_LBL), cur.category || 'punto_reunion');
    const la = inp('text', edit ? String(cur.lat) : (ll ? ll.lat.toFixed(6) : '')), ln = inp('text', edit ? String(cur.lng) : (ll ? ll.lng.toFixed(6) : ''));
    const notes = inp('text', cur.notes || '', { maxLength: 500 });
    const rad = inp('text', cur.alert_radius_m != null ? String(cur.alert_radius_m) : '30', { inputMode: 'numeric' });
    const radL = fld('Radio de alerta en metros (5 a 500, solo peligro)', rad);
    const msg = inp('text', cur.message || '', { maxLength: 140 });
    const alarm = sel(Object.entries(ALARM_LBL), cur.alarm || 'voz_y_sirena');
    const sync = () => radL.classList.toggle('hidden', cat.value !== 'peligro');
    cat.addEventListener('change', sync); sync();
    const spec = [{ k: 'name', el: name, label: 'Nombre', req: true, max: 80 }, { k: 'category', el: cat, label: 'Categoría' },
      { k: 'notes', el: notes, label: 'Notas', max: 500 }, { k: 'message', el: msg, label: 'Mensaje', max: 140 }, { k: 'alarm', el: alarm, label: 'Alarma' }];
    const onSave = async v => {
      const row = { name: v.name, category: v.category, lat: Number(String(la.value).replace(',', '.')), lng: Number(String(ln.value).replace(',', '.')),
        notes: v.notes === '' ? null : v.notes, message: v.message === '' ? null : v.message, alarm: v.alarm };
      if (v.category === 'peligro') row.alert_radius_m = Math.round(Number(String(rad.value).replace(',', '.')));
      else row.alert_radius_m = null;
      if (edit) { const { error } = await sb.from('geo_points').update(row).eq('id', cur.id); return error ? dbErr(error) : ''; }
      row.active = true; if (row.alert_radius_m == null) delete row.alert_radius_m;
      const { error } = await sb.from('geo_points').insert(row);
      return error ? dbErr(error) : '';
    };
    onSave.validate = v => {
      const a = Number(String(la.value).replace(',', '.')), b = Number(String(ln.value).replace(',', '.'));
      if (la.value === '' || ln.value === '' || !llOk(a, b)) return 'Latitud o longitud inválida.';
      if (v.category === 'peligro') { const r = Number(String(rad.value).replace(',', '.')); if (!(r >= 5 && r <= 500)) return 'El radio de alerta debe estar entre 5 y 500 metros.'; }
      return '';
    };
    geoFormShell(edit ? 'Editar punto de interés' : 'Nuevo punto de interés', [fld('Nombre', name), fld('Categoría', cat), fld('Latitud', la), fld('Longitud', ln), radL,
      fld('Notas', notes), fld('Mensaje que dice el casco (opcional)', msg), fld('Alarma', alarm)], spec, onSave);
  }
  $('gLocate').addEventListener('click', async () => {
    if (!(await ensureMap())) return;
    if (!fitCascos()) setMapWarn('Todavía no hay una posición GPS válida de ningún casco.');
    else { setMapWarn(''); mapTouched = false; }
  });
  $('gDrawCircle').addEventListener('click', () => startMode('circle'));
  $('gDrawPoly').addEventListener('click', () => startMode('polygon'));
  $('gAddPoint').addEventListener('click', () => startMode('point'));
  $('polyUndo').addEventListener('click', () => { G.pts.pop(); drawDraft(); $('polyCount').textContent = G.pts.length + ' vértices'; });
  $('polyClose').addEventListener('click', () => {
    if (G.pts.length < 3) { $('geoHint').textContent = 'Hacen falta al menos 3 vértices para cerrar el polígono.'; return; }
    const pts = G.pts.slice(); setMode(null); openZoneForm(null, { shape: 'polygon', points: pts });
  });
  $('polyCancel').addEventListener('click', () => setMode(null));
  for (const [k, t] of MAPLAYERS) {
    const l = mk('label', 'chk'); const c = inp('checkbox'); c.checked = layerOn[k];
    c.addEventListener('change', () => { layerOn[k] = c.checked; if (mapState === 'ready') { if (c.checked) map.addLayer(grp[k]); else map.removeLayer(grp[k]); } });
    l.append(c, t); $('mapLayers').append(l);
  }

  // ---- Alarma de SOS: sirena continua + cartel a pantalla completa hasta que se atiende (o se silencia) ----
  // La sirena NO depende de un setInterval (Chrome lo estrangula en pestañas ocultas): las ráfagas se programan
  // por adelantado en el reloj del AudioContext y se re-arman en cada 'ended', en visibilitychange y en el intervalo.
  let sirenT = null, sirenMuted = false, overlayHidden = false, titleFlip = false;
  let sirenOut = null, sirenNext = 0, ovPrev = null, notifAsked = false;
  const notifs = new Set();
  const SIREN_PERIOD = 1.7, SIREN_AHEAD = 45;   // s
  const audioOn = () => !!audioCtx && audioCtx.state === 'running';
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.onstatechange = () => { syncAudioBar(); if (pending.size) syncAlarm(); };
      if (audioCtx.state === 'suspended') {   // el navegador lo bloquea hasta un gesto: se reintenta en cada gesto y en alarmTick
        const r = audioCtx.resume();
        if (r && r.then) r.then(() => { syncAudioBar(); if (pending.size) pumpSiren(); }, () => {});
      }
    } catch (_) {}
    syncAudioBar();
    return audioOn();
  }
  // Aviso fijo mientras el audio siga bloqueado: sin sonido, una alerta pasaria inadvertida.
  function syncAudioBar() {
    const inApp = !$('app').classList.contains('hidden');
    setBar('audBar', inApp && !audioOn() ? 'Sirena silenciada: tocá para activar' : '', 'Activar sirena', () => { ensureAudio(); sirenBurst(); });
  }
  // Pantalla encendida mientras haya sesion (un monitor de sala que se apaga no avisa nada).
  let wakeLock = null, wakeBusy = false;
  async function holdWake() {
    if (!navigator.wakeLock || wakeLock || wakeBusy || document.hidden || $('app').classList.contains('hidden')) return;
    wakeBusy = true;
    try {
      const w = await navigator.wakeLock.request('screen');
      wakeLock = w; w.addEventListener('release', () => { if (wakeLock === w) wakeLock = null; });
    } catch (_) {} finally { wakeBusy = false; }
  }
  function dropWake() { const w = wakeLock; wakeLock = null; if (w) { try { w.release(); } catch (_) {} } }
  // Permiso de notificaciones: solo desde un gesto del usuario (boton "Probar sirena" o primer clic ya dentro del panel).
  function askNotif() {
    if (notifAsked || !('Notification' in window) || Notification.permission !== 'default' || $('app').classList.contains('hidden')) return;
    notifAsked = true;
    try { const r = Notification.requestPermission(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
  }
  ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { ensureAudio(); askNotif(); }, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    renderKpiAge();
    ensureAudio();
    if (pending.size) syncAlarm();
    holdWake();      // el navegador suelta el wake lock al ocultarse la pestaña
    resyncNow();     // la pestaña pudo estar dormida: releer eventos y cascos
  });
  function sirenBurst() {   // una rafaga suelta (boton "Probar sirena")
    if (!audioOn()) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 4; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = i % 2 ? 700 : 1000; g.gain.value = 0.22;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + i * 0.4); o.stop(t0 + i * 0.4 + 0.36);
    }
  }
  function pumpSiren() {
    if (!pending.size || sirenMuted || !audioOn()) return;
    const now = audioCtx.currentTime;
    if (!sirenOut) {
      sirenOut = audioCtx.createGain(); sirenOut.gain.value = 0.22; sirenOut.connect(audioCtx.destination); sirenNext = 0;
    }
    if (sirenNext < now) sirenNext = now + 0.05;
    let last = null;
    while (sirenNext < now + SIREN_AHEAD) {
      for (let i = 0; i < 4; i++) {
        const o = audioCtx.createOscillator();
        o.type = 'square'; o.frequency.value = i % 2 ? 700 : 1000;
        o.connect(sirenOut);
        o.start(sirenNext + i * 0.4); o.stop(sirenNext + i * 0.4 + 0.36);
        last = o;
      }
      sirenNext += SIREN_PERIOD;
    }
    if (last) last.onended = pumpSiren;   // evento de audio: no lo estrangula el throttling de temporizadores
  }
  function stopSiren() {
    if (sirenOut) { try { sirenOut.gain.value = 0; sirenOut.disconnect(); } catch (_) {} sirenOut = null; }
    sirenNext = 0;
  }
  // Aviso del navegador (con la pestaña oculta o la pantalla bloqueada): queda hasta que se toque.
  function notifyAlert(ev) {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification('¡' + alertLabel(ev) + (isManDown(ev) ? ' · HOMBRE CAÍDO' : '') + '! · Vigía', {
        body: label(ev.device_id) + ' · ' + fmt(ev.created_at), tag: 'casco-' + ev.id, requireInteraction: true });
      n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
      n.onclose = () => notifs.delete(n);
      notifs.add(n);
    } catch (_) {}
  }
  const closeNotifs = () => { for (const n of [...notifs]) { try { n.close(); } catch (_) {} } notifs.clear(); };

  const sosOv = mk('div', 'sos-overlay');
  sosOv.id = 'sosOverlay'; sosOv.hidden = true;
  sosOv.setAttribute('role', 'alertdialog'); sosOv.setAttribute('aria-modal', 'true'); sosOv.setAttribute('aria-labelledby', 'sosOvT');
  const ovT = mk('h2', 'sos-ov-t', '¡ALERTA!'); ovT.id = 'sosOvT';
  const ovWho = mk('p', 'sos-ov-who'), ovWhen = mk('p', 'sos-ov-when mono'), ovMore = mk('p', 'sos-ov-more'), ovHint = mk('p', 'sos-ov-hint', 'Tocá la pantalla para activar el sonido de la alarma.');
  const ovAtend = mk('button', 'sos-ov-go', 'Atender'), ovLive = mk('button', 'sos-ov-b', 'Ver en vivo');
  const ovMute = mk('button', 'sos-ov-b', 'Silenciar sirena'), ovClose = mk('button', 'sos-ov-b', 'Ver el panel');
  for (const b of [ovAtend, ovLive, ovMute, ovClose]) b.type = 'button';
  const ovBtns = mk('div', 'sos-ov-btns'); ovBtns.append(ovAtend, ovLive, ovMute, ovClose);
  sosOv.append(ovT, ovWho, ovWhen, ovMore, ovHint, ovBtns);
  document.body.append(sosOv);
  // Mostrar/ocultar el cartel: el panel queda inerte detras, y al cerrar el foco vuelve a donde estaba.
  function setOverlay(show) {
    if (show === !sosOv.hidden) return;
    sosOv.hidden = !show;
    if (show) closeDlg();   // el cartel SOS manda: se cierran dialogos (foto, configuracion, confirmaciones)
    $('app').inert = show;
    if (show) { ovPrev = document.activeElement; ovAtend.focus({ preventScroll: true }); }
    else {
      const p = ovPrev; ovPrev = null;
      if (p && p !== document.body && p.isConnected && typeof p.focus === 'function') p.focus({ preventScroll: true });
    }
    pumpSaveQueue();   // el cartel de guardado espera a que cierre el de SOS (y se oculta si aparece uno nuevo)
  }
  const closeOverlay = () => { overlayHidden = true; setOverlay(false); };
  sosOv.addEventListener('keydown', e => {   // trampa de foco: Tab no sale del cartel
    if (e.key !== 'Tab') return;
    const f = [ovAtend, ovLive, ovMute, ovClose].filter(b => !b.disabled && !b.hidden);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sosOv.hidden) { e.preventDefault(); closeOverlay(); } });
  const lastPending = () => [...pending.values()].sort((a, c) => c.created_at.localeCompare(a.created_at))[0];
  ovAtend.addEventListener('click', () => {
    const last = lastPending(); closeOverlay();
    showTab('main');
    const li = last && (pendEls.get(last.id) || cards.get(last.id));
    if (li) { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); const i = li.querySelector('input'); if (i) i.focus({ preventScroll: true }); }
  });
  ovLive.addEventListener('click', () => {
    const last = lastPending(); closeOverlay();
    if (!last || !OWN_LIVE) return;
    openLive(last.device_id, false);
  });
  ovMute.addEventListener('click', () => { sirenMuted = true; stopSiren(); ovMute.disabled = true; ovAtend.focus({ preventScroll: true }); });
  ovClose.addEventListener('click', closeOverlay);
  function alarmTick() {
    if (!sirenMuted) { ensureAudio(); pumpSiren(); }
    const n = pending.size;
    document.title = (titleFlip = !titleFlip) ? '🚨 ¡ALERTA! ' + n + ' sin atender · Vigía' : '(' + n + ') Vigía · Casco Inteligente';
  }
  function syncAlarm() {
    autoRecSync();
    if (!pending.size) {
      clearInterval(sirenT); sirenT = null; sirenMuted = false; overlayHidden = false;
      document.title = 'Vigía · Casco Inteligente';
      stopSiren(); setOverlay(false); ovMute.disabled = false; closeNotifs(); return;
    }
    const last = lastPending();
    ovT.textContent = '¡' + alertLabel(last) + (isManDown(last) ? ' · HOMBRE CAÍDO' : '') + '!';
    ovWho.textContent = label(last.device_id);
    ovWhen.textContent = fmt(last.created_at);
    ovMore.textContent = pending.size > 1 ? 'Hay ' + pending.size + ' alertas sin atender.' : '';
    ovHint.hidden = audioOn();   // audio bloqueado: el cartel avisa que hay que tocar la pantalla
    setOverlay(!overlayHidden);
    if (!sirenT) { sirenT = setInterval(alarmTick, 1700); alarmTick(); } else pumpSiren();
  }
  function alertSos(ev) {
    sirenMuted = false; ovMute.disabled = false; overlayHidden = false;
    ensureAudio();
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
    if (ev) notifyAlert(ev);
  }

  // ---- Cartel de guardado de video: no se descarta por accidente (sin Escape ni clic afuera) y cede ante el cartel SOS ----
  const saveQ = [];   // grabaciones terminadas esperando que el usuario elija
  let saveCur = null, savePrev = null;
  const saveOv = mk('div', 'save-ov'); saveOv.id = 'saveOverlay'; saveOv.hidden = true;
  saveOv.setAttribute('role', 'alertdialog'); saveOv.setAttribute('aria-modal', 'true');
  saveOv.setAttribute('aria-labelledby', 'saveOvT'); saveOv.setAttribute('aria-describedby', 'saveOvD');
  const svBox = mk('div', 'save-box');
  const svT = mk('h2', 'save-ov-t', 'Video listo'); svT.id = 'saveOvT';
  const svWhat = mk('p', 'save-ov-what'); svWhat.id = 'saveOvD';
  const svFile = mk('p', 'save-ov-file mono'), svWhy = mk('p', 'mute'), svQ = mk('p', 'mute');
  const svNote = mk('p', 'save-ov-note');
  const svErr = mk('p', 'save-ov-err'); svErr.setAttribute('role', 'alert');
  const svSave = mk('button', 'save-go', 'Guardar en mi PC'), svDrop = mk('button', 'ghost', 'Descartar');
  const svBack = mk('button', 'ghost', 'Volver'), svDone = mk('button', 'ghost', 'Cerrar');
  for (const b of [svSave, svDrop, svBack, svDone]) b.type = 'button';
  const svBtns = mk('div', 'save-btns'); svBtns.append(svSave, svDrop, svBack, svDone);
  svBox.append(svT, svWhat, svFile, svWhy, svNote, svErr, svQ, svBtns);
  saveOv.append(svBox);
  document.body.append(saveOv);
  function renderSave() {
    const it = saveCur; if (!it) return;
    svT.textContent = it.saved ? 'Video guardado' : 'Video listo';
    svWhat.textContent = 'Casco ' + it.devId + (it.who ? ' · ' + it.who : '') + ' · duración ' + clock(it.dur) + ' · ' + mb(it.size) +
      (it.auto ? ' · grabación automática por alerta' : '');
    svFile.textContent = 'Archivo: ' + it.name;
    svWhy.textContent = it.why || '';
    svNote.textContent = 'La grabación se guarda solo en tu PC. ' + (it.audio || 'Informá al personal.');
    svErr.textContent = it.err || (it.saved ? 'Descarga iniciada. Si no aparece el archivo, revisá que el navegador no haya bloqueado la descarga.' : '');
    svErr.classList.toggle('bad', !!it.err);
    if (it.confirming) { svT.textContent = '¿Descartar sin guardar?'; svErr.textContent = 'El video se pierde y no se puede recuperar.'; svErr.classList.add('bad'); }
    svQ.textContent = saveQ.length ? 'Hay ' + saveQ.length + ' video(s) más en espera.' : '';
    svSave.textContent = it.saved ? 'Descargar de nuevo' : 'Guardar en mi PC';
    svSave.hidden = !!it.confirming;
    svDrop.hidden = !!it.saved;
    svDrop.textContent = it.confirming ? 'Sí, descartar' : 'Descartar';
    svBack.hidden = !it.confirming;
    svDone.hidden = !!it.confirming || !it.saved;
  }
  function closeSave(discard) {
    const it = saveCur; if (!it) return;
    it.closed = true;
    // Tope de memoria: al descargarla (o descartarla) se suelta la grabacion; ya no queda "Descargar de nuevo".
    if ((discard || it.saved) && it.discard) it.discard();
    if (it.release) it.release();
    saveCur = null;
    pumpSaveQueue();
  }
  function pumpSaveQueue() {
    if (!saveCur && saveQ.length) { saveCur = saveQ.shift(); }
    const show = !!saveCur && sosOv.hidden;   // el cartel SOS manda: el de guardado queda en cola
    if (show) renderSave();
    if (show === !saveOv.hidden) return;
    saveOv.hidden = !show;
    if (show) {
      savePrev = document.activeElement; $('app').inert = true;
      (svSave.hidden ? svDrop : svSave).focus({ preventScroll: true });
    } else if (!saveCur && sosOv.hidden) {
      $('app').inert = false;
      const p = savePrev; savePrev = null;
      if (p && p !== document.body && p.isConnected && typeof p.focus === 'function') p.focus({ preventScroll: true });
    }
  }
  function enqueueSave(item) { saveQ.push(item); pumpSaveQueue(); }
  const unsavedVideos = () => (saveCur && !saveCur.saved) || saveQ.some(i => !i.saved);
  svSave.addEventListener('click', () => {
    const it = saveCur; if (!it) return;
    try {
      if (!it.url) throw new Error('la grabación ya no está disponible');
      saveUrl(it.url, it.name);
      it.saved = true; it.err = '';
    } catch (e) { it.err = 'No se pudo guardar: ' + ((e && e.message) || 'el navegador bloqueó la descarga') + '. Permití las descargas de este sitio y probá de nuevo.'; }
    renderSave();
    svSave.focus({ preventScroll: true });
  });
  svDrop.addEventListener('click', () => {
    const it = saveCur; if (!it) return;
    if (it.saved || it.confirming) closeSave(true);
    else { it.confirming = true; renderSave(); svBack.focus({ preventScroll: true }); }
  });
  svBack.addEventListener('click', () => { if (saveCur) { saveCur.confirming = false; renderSave(); svSave.focus({ preventScroll: true }); } });
  svDone.addEventListener('click', () => closeSave(false));
  saveOv.addEventListener('keydown', e => {   // trampa de foco; Escape NO cierra
    if (e.key !== 'Tab') return;
    const f = [svSave, svDrop, svBack, svDone].filter(b => !b.hidden && !b.disabled);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
  });

  // ---- Microfono de la PC para grabar: permiso del sitio pedido una vez (Chrome lo recuerda) ----
  // El microfono SOLO se mezcla dentro del grabador; nunca va a un altavoz del navegador (sin eco).
  let micPerm = 'unknown';   // 'granted' | 'denied' | 'prompt' | 'unknown'
  const micBtn = $('enableMic');
  function syncMicBtn() {
    if (!micBtn) return;
    micBtn.classList.toggle('hidden', !OWN_LIVE || micPerm === 'granted' || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    micBtn.textContent = micPerm === 'denied' ? 'Micrófono bloqueado: habilitalo en el navegador' : 'Habilitar micrófono para grabar';
  }
  try {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' }).then(st => {
        micPerm = st.state; syncMicBtn();
        st.onchange = () => { micPerm = st.state; syncMicBtn(); };
      }).catch(() => {});
    }
  } catch (_) {}
  async function acquireMic(ms) {   // -> { ms } o { err }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return { err: 'no disponible' };
    let done = false;
    const p = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const kill = m => { try { m.getTracks().forEach(t => t.stop()); } catch (_) {} };
    try {
      const m = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || 4000))]);
      if (done) { kill(m); return { err: 'timeout' }; }
      done = true; micPerm = 'granted'; syncMicBtn();
      return { ms: m };
    } catch (e) {
      done = true;
      p.then(kill, () => {});   // si llega tarde, se suelta
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { micPerm = 'denied'; syncMicBtn(); }
      return { err: (e && e.name) || 'error' };
    }
  }
  async function primeMic() {
    if (micPerm === 'granted' || primeMic.busy) return;
    primeMic.busy = true;
    const r = await acquireMic(60000);
    primeMic.busy = false;
    if (r.ms) r.ms.getTracks().forEach(t => t.stop());
  }
  if (micBtn) micBtn.addEventListener('click', primeMic);
  // Primer gesto dentro del panel: si el permiso todavia no se decidio, se pide una sola vez.
  let micAutoTried = false;
  document.addEventListener('pointerdown', () => {
    if (micAutoTried || !OWN_LIVE || micPerm !== 'prompt' || $('app').classList.contains('hidden')) return;
    micAutoTried = true; primeMic();
  }, { passive: true });
  syncMicBtn();

  // Grabacion automatica ante SOS / caida (cfg.REC_AUTO_ON_ALERT, por defecto true): empieza sola si el video ya reproduce
  // y se corta al atender la alerta; al cortar se abre el cartel de guardado.
  function autoRecSync() {
    if (cfg.REC_AUTO_ON_ALERT === false) return;
    const devs = new Map();
    for (const ev of pending.values()) if (ev.type === 'sos' || ev.type === 'fall') devs.set(ev.device_id, (devs.get(ev.device_id) || '') + ev.id + ';');
    lives.forEach((L, id) => {
      if (devs.has(id)) {
        // una vez por alerta: si el usuario detiene la grabacion a mano, no se reinicia sola hasta otra alerta
        if (L.autoKey !== devs.get(id) && L.autoRec && L.autoRec()) L.autoKey = devs.get(id);
      } else { L.autoKey = null; if (L.stopAuto) L.stopAuto('Alerta atendida: se detuvo la grabación automática.'); }
    });
  }

  // ======================================================================
  // Tanda 4 (docs/PROTOCOLO-COMANDOS.md): comandos a pedido, configuracion remota, reportes y roles.
  // Tablas nuevas: device_commands, device_command_acks, device_config y la vista incident_report. Mientras el servidor no
  // las tenga, la UI dice "disponible cuando se aplique la actualizacion" y no insiste (un pedido por funcion, sin bucles).
  // ======================================================================
  const isAdmin = () => ROLE === 'admin';
  const MISSING_TXT = 'Función disponible cuando se aplique la actualización del servidor.';
  // r = respuesta de supabase-js ({ data, error, status }): la tabla o vista todavia no existe.
  const tableMissing = r => !!r && (r.status === 404 || (!!r.error && (r.error.code === 'PGRST205' || r.error.code === '42P01' ||
    /could not find the (table|relation)|schema cache|does not exist/i.test(String(r.error.message || '')))));
  const asRes = e => ({ error: { message: (e && e.message) || 'sin conexión' } });
  const rowOf = (...els) => { const r = mk('div', 'row'); r.append(...els); return r; };
  // Si un re-render reemplaza el boton con foco, el foco vuelve al equivalente (mismo data-fk).
  function keepFocus(fn) {
    const a = document.activeElement, k = a && a.dataset && a.dataset.fk;
    fn();
    if (k && !a.isConnected) {
      const n = [...document.querySelectorAll('[data-fk]')].find(x => x.dataset.fk === k);
      if (n) n.focus({ preventScroll: true });
    }
  }

  // ---- Dialogo modal nativo (foto ampliada, configuracion, confirmaciones). El cartel SOS lo cierra: la alarma manda. ----
  let dlgEl = null;
  function closeDlg() { if (dlgEl && dlgEl.open) dlgEl.close(); }
  function openDlg(title, nodes) {
    closeDlg();
    const d = mk('dialog', 'dlg'); d.setAttribute('aria-labelledby', 'dlgT');
    const head = mk('div', 'dlg-h'), h = mk('h2', '', title); h.id = 'dlgT';
    const x = mk('button', 'ghost', 'Cerrar'); x.type = 'button'; x.addEventListener('click', () => d.close());
    head.append(h, x);
    d.append(head, ...nodes);
    const prev = document.activeElement, pk = prev && prev.dataset && prev.dataset.fk;
    d.addEventListener('close', () => {
      d.remove(); if (dlgEl === d) dlgEl = null;
      let t = prev && prev.isConnected ? prev : null;
      if (!t && pk) t = [...document.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === pk);
      if (t && typeof t.focus === 'function') t.focus({ preventScroll: true });
    });
    document.body.append(d); dlgEl = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    return d;
  }
  function askConfirm(title, nodes, yes, danger) {
    return new Promise(res => {
      let out = false;
      const ok = mk('button', danger ? 'attend' : '', yes); ok.type = 'button';
      const no = mk('button', 'ghost', 'Cancelar'); no.type = 'button';
      const d = openDlg(title, [...nodes, rowOf(ok, no)]);
      ok.addEventListener('click', () => { out = true; d.close(); });
      no.addEventListener('click', () => d.close());
      d.addEventListener('close', () => res(out));
      no.focus();
    });
  }

  // ---- Fotos: URL firmada con cache corta (tope de memoria) ----
  const PHOTO_KEEP = 12, SIGN_KEEP = 80;
  const photos = new Map();      // device_id -> [{ id, created_at, media_path, cmd }] (la mas nueva primero)
  const signedCache = new Map(), signedBusy = new Map();
  const signedSync = path => { const c = signedCache.get(path); return c && c.exp > Date.now() + 60000 ? c.url : null; };
  function signed(path) {
    const hit = signedSync(path); if (hit) return Promise.resolve(hit);
    if (signedBusy.has(path)) return signedBusy.get(path);
    const p = (async () => {
      try {
        const { data, error } = await sb.storage.from('casco-media').createSignedUrl(path, 600);
        if (error || !data || !data.signedUrl) return null;
        signedCache.set(path, { url: data.signedUrl, exp: Date.now() + 600000 });
        while (signedCache.size > SIGN_KEEP) signedCache.delete(signedCache.keys().next().value);
        return data.signedUrl;
      } catch (_) { return null; } finally { signedBusy.delete(path); }
    })();
    signedBusy.set(path, p);
    return p;
  }
  function notePhoto(ev) {
    if (!ev.media_path || !DEV_RE.test(ev.device_id || '')) return;
    let a = photos.get(ev.device_id); if (!a) photos.set(ev.device_id, a = []);
    if (a.some(x => x.id === ev.id)) return;
    const cmd = ev.payload && typeof ev.payload === 'object' && typeof ev.payload.cmd === 'string' ? ev.payload.cmd : '';
    a.push({ id: ev.id, created_at: ev.created_at, media_path: ev.media_path, cmd });
    a.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    if (a.length > PHOTO_KEEP) a.length = PHOTO_KEEP;
    const it = cmd ? CMD.items.get(cmd) : null;
    if (it) { it.photo = true; announce('Foto recibida del casco ' + ev.device_id + '.'); }
    cmdRefresh(ev.device_id);
  }
  function openPhoto(dev, p) {
    const desc = 'Foto del casco ' + dev + ', ' + fmt(p.created_at);
    const img = mk('img', 'photo-big'); img.alt = desc;
    const err = mk('p', 'err'); err.setAttribute('role', 'alert');
    const dl = mk('button', '', 'Descargar'); dl.type = 'button';
    dl.setAttribute('aria-label', 'Descargar la foto del casco ' + dev + ' del ' + fmt(p.created_at));
    const meta = mk('p', 'mute', label(dev) + ' · ' + fmt(p.created_at) + (p.cmd ? ' · pedida desde el panel' : ''));
    signed(p.media_path).then(u => { if (u) img.src = u; else err.textContent = 'No se pudo cargar la foto.'; });
    dl.addEventListener('click', async () => {
      err.textContent = ''; dl.disabled = true;
      try {
        const u = await signed(p.media_path); if (!u) throw new Error('sin enlace');
        const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
        const url = URL.createObjectURL(await r.blob());
        saveUrl(url, 'vigia-' + dev + '_' + stampOf(new Date(p.created_at)) + '.jpg');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { err.textContent = 'No se pudo descargar: ' + ((e && e.message) || 'error') + '. Probá con clic derecho sobre la foto.'; }
      dl.disabled = false;
    });
    const acts = rowOf(dl);
    if (isAdmin()) acts.append(trashBtn('Eliminar imagen', async () => { closeDlg(); await delFlow([{ id: p.id, path: p.media_path, dev }]); }));
    openDlg('Foto del casco ' + dev, [img, meta, acts, err]);
  }
  const delSel = new Set();   // ids de fotos marcadas para eliminar (admin)
  const delMax = 20;
  const TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  function trashBtn(text, fn, aria) {
    const b = mk('button', 'ghost trash'); b.type = 'button';
    b.setAttribute('aria-label', aria || text); b.title = text;
    b.innerHTML = TRASH; b.append(document.createTextNode(' ' + text));
    b.addEventListener('click', fn);
    return b;
  }
  function imgUi() { for (const dev of photos.keys()) cmdRefresh(dev); }
  function fillThumbs(strip, dev) {
    const arr = (photos.get(dev) || []).filter(p => !IMG.has(p.id));
    const adm = isAdmin();
    const fr = frames.get(dev) || [];
    if (!arr.length && !fr.length) { strip.replaceChildren(mk('span', 'mute', 'Sin fotos todavía. “Sacar foto” toma un cuadro del video si está en vivo; si no, se la pide al casco.')); return; }
    const fkids = fr.map(f => {
      const b = mk('button', 'thumb'); b.type = 'button';
      const desc = 'Cuadro del video del casco ' + dev + ', ' + fmt(f.created_at);
      b.setAttribute('aria-label', 'Ampliar: ' + desc);
      const img = mk('img'); img.alt = desc; img.width = 96; img.height = 72; img.src = f.url;
      b.append(img, mk('span', 'thumb-t', 'Cuadro del video · guardado en tu PC'));
      b.addEventListener('click', () => openFrame(dev, f));
      return b;
    });
    const kids = arr.slice(0, 6).map(p => {
      const w = mk('div', 'thumbwrap');
      const b = mk('button', 'thumb'); b.type = 'button';
      const desc = 'Foto del casco ' + dev + ', ' + fmt(p.created_at) + (p.cmd ? ' (pedida desde el panel)' : '');
      b.setAttribute('aria-label', 'Ampliar: ' + desc);
      b.dataset.fk = dev + '|th|' + p.id;
      const img = mk('img'); img.alt = desc; img.width = 96; img.height = 72;
      const u = signedSync(p.media_path);
      if (u) img.src = u; else signed(p.media_path).then(x => { if (x) img.src = x; else b.classList.add('thumb-bad'); });
      b.append(img, mk('span', 'thumb-t mono', fmtAR(p.created_at).slice(11)));
      b.addEventListener('click', () => openPhoto(dev, p));
      w.append(b);
      if (adm) {
        const r = mk('div', 'row thumb-act');
        const l = mk('label', 'chk'), c = mk('input'); c.type = 'checkbox'; c.checked = delSel.has(p.id);
        c.setAttribute('aria-label', 'Seleccionar para eliminar la foto del ' + fmt(p.created_at));
        c.dataset.fk = dev + '|sel|' + p.id;
        c.addEventListener('change', () => {
          if (c.checked && delSel.size >= delMax) { c.checked = false; announce('Se pueden elegir hasta ' + delMax + ' fotos a la vez.'); return; }
          if (c.checked) delSel.add(p.id); else delSel.delete(p.id);
          cmdRefresh(dev);
        });
        l.append(c);
        const t = trashBtn('', () => delFlow([{ id: p.id, path: p.media_path, dev }]), 'Eliminar imagen');
        t.textContent = ''; t.innerHTML = TRASH; t.classList.add('icon-only');
        r.append(l, t); w.append(r);
      }
      return w;
    });
    strip.replaceChildren(...fkids, ...kids);
    const nSel = arr.filter(p => delSel.has(p.id)).length;
    if (adm && nSel) {
      const b = mk('button', 'attend', 'Eliminar seleccionadas (' + nSel + ')'); b.type = 'button';
      b.dataset.fk = dev + '|delsel';
      b.addEventListener('click', () => delFlow(arr.filter(p => delSel.has(p.id)).slice(0, delMax).map(p => ({ id: p.id, path: p.media_path, dev }))));
      strip.append(b);
    }
  }

  // ---- Eliminar imagenes (admin): storage.remove + event_archive 'Imagen eliminada' ----
  const DEL_PERM_TXT = 'Falta aplicar la actualización de permisos del servidor: todavía no se pueden eliminar imágenes.';
  const delErrText = e => {
    const m = String((e && (e.message || e.error)) || ''), c = String((e && (e.statusCode || e.status || e.code)) || '');
    if (noPerm(e) || c === '403' || c === '401' || /row-level|not authorized|unauthorized|permission|forbidden|policy/i.test(m)) return DEL_PERM_TXT;
    return 'No se pudo borrar el archivo (' + (m || 'error') + ').';
  };
  async function delOne(it, reason) {
    let r;
    try { r = await sb.storage.from('casco-media').remove([it.path]); } catch (e) { r = { error: e }; }
    if (r.error) return { ok: false, msg: delErrText(r.error) };
    if (Array.isArray(r.data) && r.data.length === 0) return { ok: false, msg: 'No se borró: el archivo no existe o ' + DEL_PERM_TXT.charAt(0).toLowerCase() + DEL_PERM_TXT.slice(1) };
    const why = 'Imagen eliminada' + (reason ? ': ' + reason : '');
    const email = $('who').dataset.email || '', at = new Date().toISOString();
    let note = '';
    const ins = async () => sb.from('event_archive').insert([{ event_id: it.id, reason: why }]);
    let a;
    try { a = await ins(); } catch (e) { a = asRes(e); }
    if (a.error && (a.error.code === '23505' || a.status === 409)) {   // ya archivado: se reemplaza el registro para que diga "Imagen eliminada"
      try { await sb.from('event_archive').delete().eq('event_id', it.id); a = await ins(); } catch (e) { a = asRes(e); }
    }
    if (tableMissing(a)) note = ' (no se pudo registrar en el historial: falta la actualización del servidor)';
    else if (a.error) note = ' (el archivo se borró pero no se pudo registrar: ' + String(a.error.message || 'error').slice(0, 80) + ')';
    const rec = { by: email, at, reason: why };
    IMG.set(it.id, rec);
    if (!a.error) ARC.ids.set(it.id, rec);
    const arr = photos.get(it.dev); if (arr) { const i = arr.findIndex(x => x.id === it.id); if (i >= 0) arr.splice(i, 1); }
    signedCache.delete(it.path); delSel.delete(it.id);
    return { ok: true, msg: note };
  }
  async function delFlow(items) {
    if (!isAdmin() || !items.length) return;
    const reason = inp('text', '', { maxLength: 150, autocomplete: 'off' });
    const ok = await askConfirm('¿Eliminar ' + (items.length === 1 ? 'la imagen' : items.length + ' imágenes') + '?',
      [mk('p', '', 'Se borra el archivo definitivamente del servidor. El evento queda en el historial sin la imagen.'),
        fld('Motivo (opcional, hasta 150 caracteres)', reason)], items.length === 1 ? 'Sí, eliminar la imagen' : 'Sí, eliminar ' + items.length + ' imágenes', true);
    if (!ok) return;
    const why = reason.value.trim().replace(/\s+/g, ' ');
    const prog = mk('p', '', 'Eliminando 0 de ' + items.length + '…'); prog.setAttribute('role', 'status');
    const fails = mk('ul', 'delfails');
    const d = openDlg('Eliminando imágenes', [prog, fails]);
    let done = 0, bad = 0;
    for (const it of items) {
      const r = await delOne(it, why);
      if (r.ok) { done++; if (r.msg) fails.append(mk('li', 'mute', 'Foto ' + (done + bad) + r.msg)); }
      else { bad++; fails.append(mk('li', 'bad', 'No se eliminó una imagen del casco ' + it.dev + ': ' + r.msg)); }
      prog.textContent = 'Eliminando ' + (done + bad) + ' de ' + items.length + '…';
      imgUi(); arcUi();
      if (!d.isConnected) break;
    }
    prog.textContent = 'Listo: ' + done + (done === 1 ? ' imagen eliminada' : ' imágenes eliminadas') + (bad ? ' · ' + bad + ' con error' : '') + '.';
    prog.classList.toggle('bad', bad > 0);
    announce(prog.textContent);
    imgUi(); arcUi();
  }

  // ---- Comandos a pedido: device_commands + device_command_acks (Realtime + poll corto de respaldo) ----
  const CMD_WAIT_MS = 40000, CMD_POLL_MS = 2000, CMD_KEEP = 40;
  const CMD = { avail: 'unknown', items: new Map(), last: new Map(), torch: new Map(), ch: null, timer: null, polling: false, seq: 0 };
  const cmdViews = new Set();
  // Barra de comandos de la lista "Cascos": una por casco, reutilizada en cada repintado (antes se recreaba en cada heartbeat).
  const cmdBars = new Map();   // device_id -> vista
  function pruneCmdBars(keep) {
    for (const [id, v] of cmdBars) if (!keep.has(id)) { cmdBars.delete(id); cmdViews.delete(v); }
  }
  const ACTION_LBL = { photo: 'Foto', torch_on: 'Linterna encendida', torch_off: 'Linterna apagada', restart_agent: 'Reinicio del agente', ping: 'Enlace' };
  function announce(t) { const el = $('cmdLive'); if (el) el.textContent = t; }
  function cmdText(it) {
    if (it.action === 'frame') return 'Cuadro del video: ' + (it.state === 'ok' ? 'guardado en tu PC · ' : '') + it.detail + (it.state === 'error' ? '.' : '');
    const a = ACTION_LBL[it.action] || it.action;
    if (it.state === 'na') return MISSING_TXT;
    if (it.state === 'pending') return a + ': pendiente, esperando al casco…';
    if (it.state === 'timeout') return a + ': sin respuesta del casco (puede estar sin señal o apagado).';
    if (it.state === 'error') return a + ': error' + (it.detail ? ' · ' + it.detail : '') + '.' + (it.offerFrame ? ' Podés tomar un cuadro del video en vivo.' : '');
    let t = a + ': listo';
    if (it.action === 'ping' && it.took != null) t += ' · respuesta en ' + n1(it.took / 1000) + ' s';
    if (it.action === 'photo') t += it.photo ? ' · foto recibida' : ' · esperando la imagen…';
    if (it.detail) t += ' · ' + it.detail;
    return t;
  }
  function cmdRefresh(id) {
    for (const v of [...cmdViews]) { if (!v.box.isConnected) { cmdViews.delete(v); continue; } if (!id || v.id === id) v.update(); }
  }
  function cmdBar(id, shared) {
    if (shared && cmdBars.has(id)) { const c = cmdBars.get(id); c.update(); return c.box; }
    const box = mk('div', 'cmdbar'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Comandos a pedido del casco ' + id);
    const mkb = (txt, k, aria) => { const b = mk('button', 'ghost', txt); b.type = 'button'; b.dataset.fk = id + '|' + k; b.setAttribute('aria-label', aria); return b; };
    const bPhoto = mkb('Sacar foto', 'photo', 'Sacar una foto con el casco ' + id);
    const bTorch = mkb('Linterna: encender', 'torch', 'Encender la linterna del casco ' + id);
    const bPing = mkb('Probar enlace', 'ping', 'Probar el enlace con el casco ' + id);
    const bFrame = mkb('Tomar cuadro del video', 'frame', 'Tomar un cuadro del video en vivo del casco ' + id);
    bFrame.classList.add('hidden');
    const row = rowOf(bPhoto, bTorch, bPing, bFrame);
    if (isAdmin()) {   // configuracion y reinicio: solo admin (RLS lo exige tambien en el servidor)
      const bCfg = mkb('Configuración del casco', 'cfg', 'Configuración remota del casco ' + id);
      const bRst = mkb('Reiniciar agente', 'rst', 'Reiniciar el agente del casco ' + id);
      bCfg.addEventListener('click', () => openConfig(id));
      bRst.addEventListener('click', () => askRestart(id));
      row.append(bCfg, bRst);
    }
    const stat = mk('p', 'mute cmdstat');
    const strip = mk('div', 'thumbs');
    box.append(row, stat, strip);
    bPhoto.addEventListener('click', () => takePhoto(id));
    bFrame.addEventListener('click', () => frameFromVideo(id));
    bTorch.addEventListener('click', () => sendCmd(id, CMD.torch.get(id) === true ? 'torch_off' : 'torch_on'));
    bPing.addEventListener('click', () => sendCmd(id, 'ping'));
    const v = { id, box, update() {
      const it = CMD.last.get(id);
      stat.textContent = it ? cmdText(it) : (CMD.avail === 'missing' ? MISSING_TXT : '');
      stat.classList.toggle('bad', !!it && (it.state === 'error' || it.state === 'timeout'));
      bFrame.classList.toggle('hidden', !(it && it.offerFrame));
      const on = CMD.torch.get(id) === true;
      bTorch.textContent = 'Linterna: ' + (on ? 'apagar' : 'encender');
      bTorch.setAttribute('aria-label', (on ? 'Apagar' : 'Encender') + ' la linterna del casco ' + id);
      fillThumbs(strip, id);
    } };
    v.update(); cmdViews.add(v);
    if (shared) cmdBars.set(id, v);
    return box;
  }
  const cmdBusy = (dev, actions) => [...CMD.items.values()].some(x => x.dev === dev && x.state === 'pending' && actions.includes(x.action));
  async function sendCmd(dev, action, params) {
    if (!DEV_RE.test(dev)) return;
    const kind = action === 'torch_on' || action === 'torch_off' ? ['torch_on', 'torch_off'] : [action];
    if (cmdBusy(dev, kind)) return;   // ya hay uno igual esperando al casco
    const key = 'tmp-' + (++CMD.seq);
    const it = { id: null, dev, action, at: Date.now(), srvAt: null, state: 'pending', detail: '', took: null, photo: false };
    CMD.items.set(key, it); CMD.last.set(dev, it); cmdRefresh(dev);
    let res;
    try { res = await sb.from('device_commands').insert({ device_id: dev, action, params: params || {} }).select('id,created_at').single(); }
    catch (e) { res = asRes(e); }
    CMD.items.delete(key);
    if (res.error || !res.data) {
      if (tableMissing(res)) { CMD.avail = 'missing'; it.state = 'na'; }
      else {
        it.state = 'error';
        const e = res.error || {}, m = String(e.message || '');
        if (isAuthErr(e)) { sessionExpired(); it.detail = 'sesión vencida'; }
        else if (noPerm(e)) it.detail = 'tu rol no puede enviar esta orden';
        else if (e.code === '54000' || /rate limit/i.test(m)) it.detail = 'demasiadas órdenes en poco tiempo (máximo 10 por minuto)';
        else it.detail = 'no se pudo enviar (' + m.slice(0, 80) + ')';
      }
      cmdRefresh(dev); announce(cmdText(it));
      return;
    }
    CMD.avail = 'ok';
    it.id = res.data.id; it.srvAt = res.data.created_at;
    CMD.items.set(it.id, it);
    while (CMD.items.size > CMD_KEEP) {   // tope: se sueltan los resueltos mas viejos
      const old = [...CMD.items.values()].find(x => x.state !== 'pending');
      if (!old) break; CMD.items.delete(old.id);
    }
    ensureCmdChannel(); startCmdPoll(); cmdRefresh(dev);
  }
  function applyCmdAck(a) {
    const it = a && CMD.items.get(a.command_id);
    if (!it || (it.state !== 'pending' && it.state !== 'timeout')) return;
    it.state = a.ok === true ? 'ok' : 'error';
    it.detail = String(a.detail || '').slice(0, 200);
    if (it.action === 'photo' && it.state === 'error' && /ocupad/i.test(it.detail)) it.offerFrame = true;   // la camara esta transmitiendo
    if (a.created_at && it.srvAt) { const d = new Date(a.created_at) - new Date(it.srvAt); if (isFinite(d) && d >= 0) it.took = d; }
    if (it.state === 'ok') { if (it.action === 'torch_on') CMD.torch.set(it.dev, true); else if (it.action === 'torch_off') CMD.torch.set(it.dev, false); }
    cmdRefresh(it.dev); announce(label(it.dev) + ' · ' + cmdText(it));
  }
  function ensureCmdChannel() {
    if (CMD.ch) return;
    CMD.ch = sb.channel('cmd-acks').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'device_command_acks' }, p => applyCmdAck(p.new)).subscribe();
  }
  function startCmdPoll() { if (!CMD.timer) CMD.timer = setInterval(pollCmds, CMD_POLL_MS); }
  async function pollCmds() {
    const now = Date.now();
    const pend = [...CMD.items.values()].filter(x => x.state === 'pending');
    for (const it of pend) if (now - it.at > CMD_WAIT_MS) { it.state = 'timeout'; cmdRefresh(it.dev); announce(label(it.dev) + ' · ' + cmdText(it)); }
    const live = pend.filter(x => x.state === 'pending');
    if (!live.length) { clearInterval(CMD.timer); CMD.timer = null; return; }
    if (CMD.polling) return;
    CMD.polling = true;
    try {
      const r = await sb.from('device_command_acks').select('command_id,device_id,ok,detail,created_at').in('command_id', live.map(x => x.id));
      if (!r.error && Array.isArray(r.data)) r.data.forEach(applyCmdAck);
    } catch (_) {}
    CMD.polling = false;
  }

  // ---- Reiniciar agente (admin) ----
  async function askRestart(dev) {
    if (!isAdmin()) return;
    const ok = await askConfirm('¿Reiniciar el agente del casco ' + dev + '?',
      [mk('p', '', 'El agente del casco se cierra y vuelve a abrir. Durante unos segundos el casco no manda datos ni recibe órdenes.')], 'Sí, reiniciar el agente', true);
    if (ok) sendCmd(dev, 'restart_agent');
  }

  // ---- Configuracion remota (admin): device_config (docs/PROTOCOLO-COMANDOS.md seccion 3) ----
  // Rangos de la UI (el casco valida otra vez); vacio = no se manda esa clave y el casco usa su valor local.
  const CFG_FIELDS = [
    { k: 'fall_g_threshold', t: 'dec', min: 1.5, max: 8, l: 'Umbral de caída en g' },
    { k: 'inactivity_s', t: 'int', min: 0, max: 3600, l: 'Aviso por inmovilidad en segundos (0 = apagado)', ok: v => v === 0 || v >= 30, rule: '0 o de 30 a 3600' },
    { k: 'not_worn_s', t: 'int', min: 30, max: 3600, l: 'Casco sin usar tras (segundos)' },
    { k: 'heartbeat_s', t: 'int', min: 10, max: 600, l: 'Latido del casco cada (segundos)' },
    { k: 'location_s', t: 'int', min: 5, max: 600, l: 'Ubicación cada (segundos)' },
    { k: 'location_s_alert', t: 'int', min: 1, max: 120, l: 'Ubicación durante una alerta cada (segundos)' },
    { k: 'broadcast_volume', t: 'int', min: 0, max: 100, l: 'Volumen de órdenes y avisos (%)' },
    { k: 'stream_audio', t: 'bool', l: 'Audio del casco en el video en vivo' },
    { k: 'voice_commands', t: 'bool', l: 'Comandos de voz' },
    { k: 'torch_allowed', t: 'bool', l: 'Permitir la linterna a pedido' },
  ];
  const cfgRule = f => f.rule || ('de ' + String(f.min).replace('.', ',') + ' a ' + String(f.max).replace('.', ','));
  // raw: { clave: texto }. Devuelve { cfg, errors }.
  function parseCfg(raw) {
    const cfg = {}, errors = [];
    for (const f of CFG_FIELDS) {
      const s = String(raw[f.k] == null ? '' : raw[f.k]).trim();
      if (s === '') continue;
      if (f.t === 'bool') { if (s === 'true' || s === 'false') cfg[f.k] = s === 'true'; else errors.push(f.l + ': valor inválido.'); continue; }
      if (!(f.t === 'dec' ? /^\d+([.,]\d+)?$/ : /^\d+$/).test(s)) { errors.push(f.l + ': escribí un número ' + (f.t === 'int' ? 'entero ' : '') + cfgRule(f) + '.'); continue; }
      const v = Number(s.replace(',', '.'));
      if (!(v >= f.min && v <= f.max) || (f.ok && !f.ok(v))) { errors.push(f.l + ': debe estar ' + cfgRule(f) + '.'); continue; }
      cfg[f.k] = v;
    }
    if (cfg.location_s_alert != null && cfg.location_s != null && cfg.location_s_alert > cfg.location_s)
      errors.push('Ubicación durante una alerta no puede ser más lenta que la normal.');
    return { cfg, errors };
  }
  async function openConfig(dev) {
    if (!isAdmin()) return;
    const form = mk('form', 'section cfgform'); form.noValidate = true;
    const ins = {};
    form.append(mk('p', 'mute', 'Dejá vacío lo que no querés cambiar: el casco usa su valor local. Aplica al iniciar el agente y cada 5 minutos.'));
    for (const f of CFG_FIELDS) {
      let el;
      if (f.t === 'bool') { el = mk('select'); el.append(new Option('(sin cambios)', ''), new Option('Sí', 'true'), new Option('No', 'false')); }
      else { el = mk('input'); el.type = 'text'; el.inputMode = f.t === 'dec' ? 'decimal' : 'numeric'; el.autocomplete = 'off'; el.placeholder = cfgRule(f); }
      el.id = 'cfg_' + f.k; ins[f.k] = el;
      form.append(fld(f.l + (f.t === 'bool' ? '' : ' (' + cfgRule(f) + ')'), el));
    }
    const msg = mk('p', 'mute', 'Leyendo la configuración actual…'); msg.setAttribute('role', 'status');
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const go = mk('button', '', 'Guardar configuración'); go.type = 'submit'; go.disabled = true;
    form.append(msg, rowOf(go), err);
    openDlg('Configuración del casco ' + dev, [form]);
    const first = form.querySelector('input,select'); if (first) first.focus();
    let r;
    try { r = await sb.from('device_config').select('config,updated_at').eq('device_id', dev).maybeSingle(); } catch (e) { r = asRes(e); }
    if (!form.isConnected) return;
    if (tableMissing(r)) { msg.textContent = MISSING_TXT; return; }
    if (r.error) { msg.textContent = ''; err.textContent = noPerm(r.error) ? 'Sin permiso para leer la configuración.' : 'No se pudo leer la configuración: ' + r.error.message; return; }
    const cur = r.data && r.data.config && typeof r.data.config === 'object' ? r.data.config : {};
    for (const f of CFG_FIELDS) if (cur[f.k] != null && typeof cur[f.k] !== 'object') ins[f.k].value = String(cur[f.k]).replace('.', f.t === 'dec' ? ',' : '.');
    msg.textContent = r.data ? 'Configuración actual cargada' + (r.data.updated_at ? ' (última actualización: ' + fmt(r.data.updated_at) + ').' : '.') : 'Este casco todavía no tiene configuración remota.';
    go.disabled = false;
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const raw = {}; for (const f of CFG_FIELDS) raw[f.k] = ins[f.k].value;
      const p = parseCfg(raw);
      if (p.errors.length) { err.textContent = p.errors.join(' '); return; }
      go.disabled = true;
      let res;
      try { res = await sb.from('device_config').upsert({ device_id: dev, config: p.cfg }, { onConflict: 'device_id' }); } catch (ex) { res = asRes(ex); }
      go.disabled = false;
      if (tableMissing(res)) { err.textContent = MISSING_TXT; return; }
      if (res.error) {
        if (isAuthErr(res.error)) { sessionExpired(); return; }
        err.textContent = noPerm(res.error) ? 'Sin permiso: solo un administrador puede cambiar la configuración.' : 'No se pudo guardar: ' + res.error.message;
        return;
      }
      msg.textContent = 'Guardado. El casco la aplica al iniciar el agente y cada 5 minutos.';
      announce('Configuración del casco ' + dev + ' guardada.');
    });
  }

  // ---- Reportes e Historial: filtros + tabla paginada por keyset (created_at, id), 50 por pagina ----
  const RPT_COLS = 'event_id,created_at,device_id,type,payload,lat,lng,acked_at,acked_by_email,note,tta_s';
  const ALERT_TYPES = ['sos', 'fall', 'geofence', 'not_worn', 'inactive'];
  const HIST_TYPES = [...ALERT_TYPES, 'equip', 'fall_cancel', 'photo', 'video'];
  const PAGE_N = 50, CSV_PAGE = 250, CSV_MAX_PAGES = 20;
  const QR = { view: 'unknown' };   // vista incident_report: 'unknown' | 'ok' | 'missing'
  const dayStartISO = (ymd, plus) => new Date(new Date(ymd + 'T00:00:00-03:00').getTime() + (plus || 0) * 86400000).toISOString();   // Argentina = UTC-3 fijo
  const ymdAgo = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() - d * 86400000));
  function qFilters(q, f, idCol, cur) {
    if (f.from) q = q.gte('created_at', dayStartISO(f.from));
    if (f.to) q = q.lt('created_at', dayStartISO(f.to, 1));
    if (f.dev) q = q.eq('device_id', f.dev);
    if (cur) q = q.or('created_at.lt.' + cur.at + ',and(created_at.eq.' + cur.at + ',' + idCol + '.lt.' + cur.id + ')');
    return q.order('created_at', { ascending: false }).order(idCol, { ascending: false });
  }
  const normView = r => ({ id: String(r.event_id), at: r.created_at, dev: r.device_id, type: r.type, payload: r.payload, lat: numOf(r.lat), lng: numOf(r.lng), att: true,
    ackAt: r.acked_at || null, ackBy: r.acked_by_email || '', note: r.note || '',
    tta: numOf(r.tta_s) != null ? numOf(r.tta_s) : (r.acked_at ? Math.max(0, (new Date(r.acked_at) - new Date(r.created_at)) / 1000) : null) });
  const normEvent = (e, a) => ({ id: String(e.id), at: e.created_at, dev: e.device_id, type: e.type, payload: e.payload, lat: numOf(e.lat), lng: numOf(e.lng), att: needsAttention(e),
    ackAt: a ? a.acked_at : null, ackBy: a ? a.acked_by_email || '' : '', note: a ? a.note || '' : '', media: e.media_path || '',
    tta: a && a.acked_at ? Math.max(0, (new Date(a.acked_at) - new Date(e.created_at)) / 1000) : null });
  // -> { rows (<= n), more, src }. Vista incident_report si existe; si no, events + event_acks (mismo resultado).
  async function fetchPage(o, f, cur, n) {
    const out = [];
    let c = cur, exhausted = false, viaView = false;
    if (o.view && QR.view !== 'missing') {
      for (let g = 0; g < 8 && out.length <= n && !exhausted; g++) {
        let q = sb.from('incident_report').select(RPT_COLS);
        if (f.type) q = q.eq('type', f.type);
        if (f.st === 'ack') q = q.not('acked_at', 'is', null); else if (f.st === 'pend') q = q.is('acked_at', null);
        let r;
        try { r = await qFilters(q, f, 'event_id', c).limit(n + 1); } catch (e) { r = asRes(e); }
        if (r.error || !Array.isArray(r.data)) {
          if (g === 0 && tableMissing(r)) { QR.view = 'missing'; break; }
          throw r.error || new Error('sin datos');
        }
        QR.view = 'ok'; viaView = true;
        for (const x of r.data) { const row = normView(x); if (arcKeep(row)) out.push(row); }
        if (r.data.length <= n) exhausted = true; else { const l = r.data[r.data.length - 1]; c = { at: l.created_at, id: l.event_id }; }
      }
      if (viaView) return { rows: out.slice(0, n), more: out.length > n, src: 'vista' };
    }
    c = cur; exhausted = false;
    for (let g = 0; g < 8 && out.length <= n && !exhausted; g++) {
      const r = await qFilters(sb.from('events').select(EV_COLS).in('type', f.type ? [f.type] : o.types), f, 'id', c).limit(n + 1);
      if (r.error) throw r.error;
      const data = r.data || [];
      const need = data.filter(needsAttention).map(e => e.id), am = new Map();
      if (need.length) { const ar = await fetchAcks(need); if (ar.error) throw ar.error; ar.rows.forEach(a => am.set(a.event_id, a)); }
      for (const e of data) {
        const att = needsAttention(e);
        if ((o.alertsOnly || f.st) && !att) continue;   // reportes: solo lo que requiere Atender; el estado solo aplica a alertas
        const a = am.get(e.id);
        if ((f.st === 'ack' && !a) || (f.st === 'pend' && a)) continue;
        const row = normEvent(e, a);
        if (arcKeep(row)) out.push(row);
      }
      if (data.length <= n) exhausted = true; else c = { at: data[data.length - 1].created_at, id: data[data.length - 1].id };
    }
    return { rows: out.slice(0, n), more: out.length > n, src: 'eventos' };
  }
  const detailOf = r => {
    const ev = { type: r.type, payload: r.payload };
    const b = payloadBits(ev);
    if (r.type === 'fall' && isManDown(ev)) b.unshift('hombre caído');
    return b.join(' · ');
  };
  const stateOf = r => (!r.att ? 'Informativo' : r.ackAt ? 'Atendida' : 'Pendiente');
  const csvRow = r => [fmtAR(r.at), r.dev, personOf.get(r.dev) || '', typeLbl(r.type), detailOf(r),
    llOk(r.lat, r.lng) ? String(r.lat).replace('.', ',') : '', llOk(r.lat, r.lng) ? String(r.lng).replace('.', ',') : '',
    stateOf(r), r.ackBy, r.ackAt ? fmtAR(r.ackAt) : '', r.note, r.tta != null ? Math.round(r.tta) : '', r.id,
    ARC.ids.has(r.id) ? ARC.ids.get(r.id).by : '', ARC.ids.has(r.id) ? fmtAR(ARC.ids.get(r.id).at) : ''];
  const CSV_HEAD = ['fecha', 'casco', 'persona', 'tipo', 'detalle', 'latitud', 'longitud', 'estado', 'atendio_por', 'fecha_atencion', 'nota', 'segundos_hasta_atender', 'id_evento', 'archivado_por', 'archivado_el'];

  // ---- Archivar (docs: event_archive; solo admin escribe, viewer solo mira) ----
  // Archivar no borra: oculta de listados, contadores, CSV e impresion salvo "Mostrar archivados". Solo atendidos o informativos.
  const ARC = { ids: new Map(), avail: 'unknown', show: false, ch: null };   // event_id -> { by, at, reason }
  const arcQueries = [];
  // Imagenes eliminadas: event_id -> { by, at, reason }. Viene de event_archive (reason 'Imagen eliminada...') o de este navegador.
  const IMG = new Map();
  const IMG_RE = /^Imagen eliminada/;
  const noteImg = (id, rec) => { if (rec && IMG_RE.test(rec.reason || '')) IMG.set(id, rec); else IMG.delete(id); };
  const arcOk = () => ARC.avail === 'ok';
  const arcKeep = r => !arcOk() || ARC.show || !ARC.ids.has(r.id) || IMG.has(r.id);   // 'imagen eliminada' no oculta el evento
  const imgWho = rec => 'Imagen eliminada por ' + (rec.by || 'un administrador') + (rec.at ? ' el ' + fmtAR(rec.at) : '') + (rec.reason && rec.reason.length > 16 ? ' · ' + rec.reason.replace(/^Imagen eliminada:?\s*/, '') : '');
  const arcWho = rec => 'Archivado por ' + (rec.by || 'un administrador') + (rec.at ? ' el ' + fmtAR(rec.at) : '');
  const PEND_TIP = 'Atendé la alerta primero';
  function arcCard(li, done) {
    const id = li.dataset.id, img = IMG.get(id);
    const rec = arcOk() && !img ? ARC.ids.get(id) : null;
    li.classList.toggle('arc-hidden', !!rec && !ARC.show);
    li.classList.toggle('archived', !!rec && ARC.show);
    const old = li.querySelector(':scope > .arc-row'); if (old) old.remove();
    if (img) li.querySelectorAll(':scope > .media').forEach(n => n.remove());
    const row = mk('div', 'row arc-row');
    if (img) row.append(mk('span', 'mute img-gone', imgWho(img)));
    else if (li.dataset.media && isAdmin()) {
      row.append(trashBtn('Eliminar imagen', () => delFlow([{ id, path: li.dataset.media, dev: li.dataset.dev }])));
    }
    if (arcOk() && !img) {
      if (rec) {
        if (ARC.show) { row.append(mk('span', 'mute', arcWho(rec))); if (isAdmin()) row.append(btn('Desarchivar', 'ghost', () => arcRun(() => unarchiveEvent(id)), 'Desarchivar el evento')); }
      } else if (isAdmin()) {
        const pend = !done && li.dataset.att === '1';
        const b = mk('button', 'ghost', 'Archivar'); b.type = 'button';
        b.setAttribute('aria-label', 'Archivar el evento');
        if (pend) { b.setAttribute('aria-disabled', 'true'); b.title = PEND_TIP; }
        else b.addEventListener('click', () => arcRun(() => askArchive([id])));
        row.append(b);
      }
    }
    if (row.children.length) li.append(row);
  }
  function arcCards() {
    for (const ul of [$('feed'), $('feedDone')]) for (const li of ul.children) if (li.dataset && li.dataset.id) arcCard(li, ul.id === 'feedDone');
  }
  function arcUi() {
    document.querySelectorAll('.arc-toggle-l').forEach(l => l.classList.toggle('hidden', !arcOk()));
    document.querySelectorAll('.arc-toggle').forEach(c => { c.checked = ARC.show; });
    arcCards(); imgUi(); syncEmpty();
    if (lastEv && arcOk() && !ARC.show && ARC.ids.has(String(lastEv.id))) { lastEv = null; $('kpiLast').textContent = '—'; $('kpiLastWhen').textContent = ''; }
    arcQueries.forEach(q => q.repaint());
  }
  async function arcRun(fn) {
    const m = await fn();
    if (m) { $('status').textContent = m; announce(m); }
  }
  async function archiveEvents(ids, reason) {
    const rows = ids.map(id => ({ event_id: id, reason: reason || null }));
    let res;
    try { res = await sb.from('event_archive').upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true }); } catch (e) { res = asRes(e); }
    if (tableMissing(res)) { ARC.avail = 'missing'; arcUi(); return MISSING_TXT; }
    if (res.error) {
      if (isAuthErr(res.error)) { sessionExpired(); return 'Sesión vencida.'; }
      return noPerm(res.error) ? 'Sin permiso: solo un administrador puede archivar.' : 'El servidor no permitió archivar: ' + String(res.error.message || 'error').slice(0, 120);
    }
    const email = $('who').dataset.email || '', at = new Date().toISOString();
    ids.forEach(id => ARC.ids.set(id, { by: email, at, reason: reason || '' }));
    arcUi(); announce(ids.length + (ids.length === 1 ? ' evento archivado.' : ' eventos archivados.'));
    return '';
  }
  async function askArchive(ids) {
    if (!isAdmin() || !ids.length) return '';
    const reason = inp('text', '', { maxLength: 200, autocomplete: 'off' });
    const ok = await askConfirm('¿Archivar ' + ids.length + (ids.length === 1 ? ' evento' : ' eventos') + '?',
      [mk('p', '', 'Dejan de verse en Historial y Reportes (con “Mostrar archivados” se ven y se pueden desarchivar). El registro no se borra.'),
        fld('Motivo (opcional, hasta 200 caracteres)', reason)], 'Sí, archivar', false);
    return ok ? archiveEvents(ids, reason.value.trim().replace(/\s+/g, ' ')) : '';
  }
  async function unarchiveEvent(id) {
    if (!isAdmin()) return '';
    let res;
    try { res = await sb.from('event_archive').delete().eq('event_id', id); } catch (e) { res = asRes(e); }
    if (tableMissing(res)) { ARC.avail = 'missing'; arcUi(); return MISSING_TXT; }
    if (res.error) return noPerm(res.error) ? 'Sin permiso: solo un administrador puede desarchivar.' : 'No se pudo desarchivar: ' + String(res.error.message || 'error').slice(0, 120);
    ARC.ids.delete(id); arcUi(); announce('Evento desarchivado.');
    return '';
  }
  async function loadArchive() {
    const m = new Map();
    try {
      for (let from = 0; from < 5000; from += 1000) {
        const r = await sb.from('event_archive').select('event_id,archived_by_email,archived_at,reason').order('archived_at', { ascending: false }).range(from, from + 999);
        if (tableMissing(r)) { ARC.avail = 'missing'; ARC.ids.clear(); arcUi(); return; }
        if (r.error || !Array.isArray(r.data)) { if (isAuthErr(r.error)) sessionExpired(); return; }
        r.data.forEach(a => { const rec = { by: a.archived_by_email || '', at: a.archived_at, reason: a.reason || '' }; m.set(String(a.event_id), rec); noteImg(String(a.event_id), rec); });
        if (r.data.length < 1000) break;
      }
      ARC.ids = m; ARC.avail = 'ok'; ensureArcChannel();
    } catch (_) { return; }
    arcUi();
  }
  function ensureArcChannel() {
    if (ARC.ch) return;
    ARC.ch = sb.channel('archive-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'event_archive' }, p => {
        const a = p.new; if (!a || !a.event_id) return;
        const rec = { by: a.archived_by_email || '', at: a.archived_at, reason: a.reason || '' };
        ARC.ids.set(String(a.event_id), rec); noteImg(String(a.event_id), rec); imgUi(); arcUi();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'event_archive' }, p => {
        const a = p.old; if (!a || !a.event_id) return;
        ARC.ids.delete(String(a.event_id)); IMG.delete(String(a.event_id)); imgUi(); arcUi();
      })
      .subscribe(resubscribed(() => loadArchive()));
  }
  document.addEventListener('change', e => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('arc-toggle')) return;
    ARC.show = !!t.checked;
    arcUi();
    arcQueries.forEach(q => q.restart());
  });

  function buildQuery(host, o) {
    const st = { cursors: [null], page: 0, rows: [], more: false, busy: false, again: false, applied: null, loaded: false, src: '', sel: new Set() };
    const form = mk('form', 'qform'); form.noValidate = true;
    const inFrom = inp('date', ymdAgo(7)), inTo = inp('date', ymdAgo(0));
    const selDev = sel([['', 'Todos los cascos']], ''), selType = sel([['', 'Todos los tipos'], ...o.types.map(t => [t, typeLbl(t)])], '');
    const selSt = sel([['', 'Todas'], ['ack', 'Atendidas'], ['pend', 'Pendientes']], '');
    const g = mk('div', 'grid2 qgrid');
    g.append(fld('Desde', inFrom), fld('Hasta', inTo), fld('Casco', selDev), fld('Tipo', selType), fld('Estado', selSt));
    const bGo = mk('button', '', 'Buscar'); bGo.type = 'submit';
    const bCsv = mk('button', 'ghost', 'Exportar CSV'); bCsv.type = 'button';
    const bPrint = mk('button', 'ghost', 'Imprimir / PDF'); bPrint.type = 'button';
    const tl = mk('label', 'chk arc-toggle-l hidden'), tc = mk('input', 'arc-toggle'); tc.type = 'checkbox'; tc.checked = ARC.show; tl.append(tc, 'Mostrar archivados');
    const bArch = mk('button', 'ghost hidden', 'Archivar seleccionados (0)'); bArch.type = 'button';
    const acts = rowOf(bGo, bCsv, bPrint, tl, bArch);
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    form.append(g, acts, err);
    const stat = mk('p', 'mute'); stat.setAttribute('role', 'status');
    const printH = mk('p', 'print-only');
    const table = mk('table', 'qtable');
    const cap = mk('caption', 'sr-only', o.title); table.append(cap);
    const head = mk('thead'), hr = mk('tr');
    head.append(hr);
    const body = mk('tbody');
    table.append(head, body);
    const wrap = mk('div', 'tablewrap'); wrap.append(table);
    const bPrev = mk('button', 'ghost', 'Anterior'), bNext = mk('button', 'ghost', 'Siguiente');
    bPrev.type = bNext.type = 'button';
    const pageTxt = mk('span', 'mute');
    const pager = mk('div', 'row pager'); pager.append(bPrev, pageTxt, bNext);
    host.replaceChildren(form, printH, stat, wrap, pager);
    const setStat = (t, bad) => { stat.textContent = t; stat.classList.toggle('bad', !!bad); };
    const filters = () => ({ from: inFrom.value, to: inTo.value, dev: selDev.value, type: selType.value, st: selSt.value });
    const describe = f => 'Desde ' + (f.from || '—') + ' hasta ' + (f.to || '—') + ' · casco: ' + (f.dev ? label(f.dev) : 'todos') + ' · tipo: ' + (f.type ? typeLbl(f.type) : 'todos') +
      ' · estado: ' + (f.st === 'ack' ? 'atendidas' : f.st === 'pend' ? 'pendientes' : 'todas') + (ARC.show ? ' · con archivados' : '');
    const fillDevs = () => {
      const ids = knownDevices(), sig = ids.map(label).join('|');
      if (selDev.dataset.sig === sig) return;
      const cur = selDev.value;
      selDev.dataset.sig = sig;
      selDev.replaceChildren(new Option('Todos los cascos', ''), ...ids.map(i => new Option(label(i), i)));
      selDev.value = ids.includes(cur) ? cur : '';
    };
    const archivable = r => !r.att || !!r.ackAt;
    function paint() {
      const adm = isAdmin() && arcOk();
      const cols = ['Fecha', 'Casco', 'Tipo', 'Detalle', 'Ubicación', 'Estado', 'Atendió', 'Nota', 'Hasta atender'];
      const ths = [];
      if (adm) {
        const th = mk('th', 'noprint'); th.scope = 'col';
        const all = mk('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Seleccionar todas las filas que se pueden archivar');
        const cand = st.rows.filter(r => archivable(r) && !ARC.ids.has(r.id));
        all.checked = cand.length > 0 && cand.every(r => st.sel.has(r.id)); all.disabled = !cand.length;
        all.addEventListener('change', () => { cand.forEach(r => (all.checked ? st.sel.add(r.id) : st.sel.delete(r.id))); paint(); });
        th.append(all); ths.push(th);
      }
      for (const h of cols) { const th = mk('th', '', h); th.scope = 'col'; ths.push(th); }
      if (adm) { const th = mk('th', 'noprint', 'Archivo'); th.scope = 'col'; ths.push(th); }
      hr.replaceChildren(...ths);
      const rows = st.rows.map(r => {
        const rec = arcOk() && !IMG.has(r.id) ? ARC.ids.get(r.id) : null;
        const tr = mk('tr', (r.att && !r.ackAt ? 'pend' : '') + (rec ? ' archived' : ''));
        const c = (t, cls) => { const td = mk('td', cls || '', t); tr.append(td); return td; };
        if (adm) {
          const td = mk('td', 'noprint'), cb = mk('input'); cb.type = 'checkbox';
          cb.setAttribute('aria-label', 'Seleccionar para archivar la fila del ' + fmtAR(r.at) + ' del casco ' + r.dev);
          cb.disabled = !!rec || !archivable(r); cb.checked = st.sel.has(r.id);
          cb.addEventListener('change', () => { if (cb.checked) st.sel.add(r.id); else st.sel.delete(r.id); updSel(); });
          td.append(cb); tr.append(td);
        }
        c(fmtAR(r.at), 'mono'); c(label(r.dev)); c(typeLbl(r.type)); c(detailOf(r) || '—');
        c(llOk(r.lat, r.lng) ? coordTxt(r.lat, r.lng) : '—', 'mono');
        const sc = c(stateOf(r), r.att && !r.ackAt ? 'bad' : '');
        if (rec && !IMG.has(r.id)) sc.append(mk('div', 'mute arc-note', arcWho(rec)));
        if (IMG.has(r.id)) sc.append(mk('div', 'mute arc-note', imgWho(IMG.get(r.id))));
        c(r.ackBy ? r.ackBy + (r.ackAt ? ' · ' + fmtAR(r.ackAt) : '') : '—'); c(r.note || '—');
        c(r.tta != null ? clock(r.tta) : '—', 'mono');
        if (adm) {
          const td = mk('td', 'noprint');
          if (r.media && !IMG.has(r.id)) td.append(trashBtn('Eliminar imagen', () => delFlow([{ id: r.id, path: r.media, dev: r.dev }])));
          if (IMG.has(r.id)) { /* ya sin imagen: nada mas que hacer */ }
          else if (rec) td.append(btn('Desarchivar', 'ghost', async () => { const m = await unarchiveEvent(r.id); if (m) setStat(m, true); }, 'Desarchivar la fila del ' + fmtAR(r.at) + ' del casco ' + r.dev));
          else {
            const b = mk('button', 'ghost', 'Archivar'); b.type = 'button';
            b.setAttribute('aria-label', 'Archivar la fila del ' + fmtAR(r.at) + ' del casco ' + r.dev);
            if (!archivable(r)) { b.setAttribute('aria-disabled', 'true'); b.title = PEND_TIP; }
            else b.addEventListener('click', async () => { const m = await askArchive([r.id]); if (m) setStat(m, true); });
            td.append(b);
          }
          tr.append(td);
        }
        return tr;
      });
      body.replaceChildren(...(rows.length ? rows : [(() => {
        const tr = mk('tr'), td = mk('td', 'empty mute', st.applied ? 'Sin resultados para estos filtros.' : 'Elegí los filtros y tocá Buscar.');
        td.colSpan = cols.length + (adm ? 2 : 0); tr.append(td); return tr;
      })()]));
      const a = st.page * PAGE_N;
      pageTxt.textContent = st.rows.length ? 'Página ' + (st.page + 1) + ' · filas ' + (a + 1) + ' a ' + (a + st.rows.length) : 'Página ' + (st.page + 1);
      bPrev.disabled = st.busy || st.page === 0; bNext.disabled = st.busy || !st.more;
      bCsv.disabled = bPrint.disabled = st.busy || !st.rows.length;
      bArch.classList.toggle('hidden', !adm);
      updSel();
    }
    function updSel() {
      const ids = [...st.sel].filter(id => st.rows.some(r => r.id === id));
      bArch.textContent = 'Archivar seleccionados (' + ids.length + ')';
      bArch.disabled = st.busy || !ids.length;
    }
    async function load(page) {
      if (!st.applied) return;
      if (st.busy) { st.again = true; return; }
      st.busy = true; setStat('Cargando…'); paint();
      try {
        const r = await fetchPage(o, st.applied, st.cursors[page], PAGE_N);
        st.page = page; st.rows = r.rows; st.more = r.more; st.src = r.src; st.loaded = true;
        st.sel = new Set([...st.sel].filter(id => r.rows.some(x => x.id === id)));
        if (r.more) { const l = r.rows[r.rows.length - 1]; st.cursors[page + 1] = { at: l.at, id: l.id }; }
        setStat((r.rows.length ? '' : 'Sin resultados. ') + (o.view && r.src === 'eventos' ? 'La vista de reportes del servidor todavía no está disponible: se calcula desde los eventos.' : ''));
      } catch (e) {
        if (isAuthErr(e)) { sessionExpired(); setStat('Sesión vencida.', true); }
        else {
          setStat('No se pudo cargar: ' + (noPerm(e) ? 'sin permiso para ver estos datos' : String((e && e.message) || 'error')) + '.', true);
          const rb = mk('button', 'ghost', 'Reintentar'); rb.type = 'button'; rb.addEventListener('click', () => load(page));
          stat.append(' ', rb);
        }
      }
      st.busy = false; paint();
      if (st.again) { st.again = false; load(st.page); }
    }
    form.addEventListener('submit', e => {
      e.preventDefault(); err.textContent = '';
      const f = filters();
      if (f.from && f.to && f.from > f.to) { err.textContent = 'La fecha Desde es posterior a Hasta.'; return; }
      st.applied = f; st.cursors = [null]; st.page = 0; st.sel.clear();
      load(0);
    });
    bPrev.addEventListener('click', () => load(st.page - 1));
    bNext.addEventListener('click', () => load(st.page + 1));
    bArch.addEventListener('click', async () => {
      const ids = [...st.sel].filter(id => st.rows.some(r => r.id === id)).slice(0, PAGE_N);
      const m = await askArchive(ids);
      if (m) setStat(m, true); else st.sel.clear();
    });
    bPrint.addEventListener('click', () => {
      printH.textContent = o.title + ' · ' + describe(st.applied || filters()) + ' · generado ' + fmtAR(new Date().toISOString()) + ' (hora de Argentina) · página ' + (st.page + 1);
      window.print();
    });
    bCsv.addEventListener('click', async () => {
      if (st.busy || !st.applied) return;
      st.busy = true; paint();
      const all = [];
      let cur = null, trunc = false;
      try {
        for (let i = 0; i < CSV_MAX_PAGES; i++) {
          setStat('Exportando… ' + all.length + ' filas');
          const r = await fetchPage(o, st.applied, cur, CSV_PAGE);
          all.push(...r.rows);
          if (!r.more) break;
          if (i === CSV_MAX_PAGES - 1) trunc = true;
          const l = r.rows[r.rows.length - 1]; cur = { at: l.at, id: l.id };
        }
        csvDownload(o.csv + '_' + today() + '.csv', CSV_HEAD, all.map(csvRow));
        setStat('CSV exportado: ' + all.length + ' filas' + (ARC.show ? ' (con archivados)' : '') + (trunc ? ' (tope de ' + CSV_PAGE * CSV_MAX_PAGES + ': acotá las fechas para ver el resto)' : '') + '.');
      } catch (e) { setStat('No se pudo exportar: ' + String((e && e.message) || 'error') + '.', true); }
      st.busy = false; paint();
    });
    paint();
    const q = {
      show() { fillDevs(); if (!st.applied) { st.applied = filters(); load(0); } else paint(); },
      reset() { st.applied = null; st.rows = []; st.more = false; st.cursors = [null]; st.page = 0; st.sel.clear(); setStat(''); paint(); },
      repaint() { if (st.applied && st.loaded) load(st.page); else paint(); },   // cambio un archivo: se vuelve a leer la pagina actual
      restart() { if (st.applied && st.loaded) { st.cursors = [null]; st.sel.clear(); load(0); } else paint(); },
    };
    arcQueries.push(q);
    return q;
  }
  const repQ = buildQuery($('repHost'), { title: 'Reporte de incidentes', csv: 'reporte_incidentes', types: ALERT_TYPES, view: true, alertsOnly: true });
  const histQ = buildQuery($('histQuery'), { title: 'Historial de eventos', csv: 'historial_eventos', types: HIST_TYPES, view: false, alertsOnly: false });
  $('histSearch').addEventListener('toggle', () => { if ($('histSearch').open) histQ.show(); });

  // ---- Pestaña Comandos: fuente unica comandos.html (se carga una vez, ids con prefijo para no chocar) ----
  let cmdState = 'idle';
  async function loadCmdPanel() {
    if (cmdState === 'loading' || cmdState === 'ready') return;
    cmdState = 'loading';
    const host = $('cmdHost');
    try {
      const r = await fetch('comandos.html', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const src = doc.querySelector('main.cmd-page');
      if (!src) throw new Error('sin contenido');
      const box = document.importNode(src, true);
      box.querySelectorAll('script, .cmd-top .back').forEach(n => n.remove());
      box.querySelectorAll('[id]').forEach(n => { n.id = 'cmdp-' + n.id; });
      box.querySelectorAll('[aria-labelledby]').forEach(n => n.setAttribute('aria-labelledby', n.getAttribute('aria-labelledby').split(/\s+/).map(x => 'cmdp-' + x).join(' ')));
      box.querySelectorAll('label[for]').forEach(n => n.setAttribute('for', 'cmdp-' + n.getAttribute('for')));
      const h1 = box.querySelector('h1');
      if (h1) { const h2 = mk('h2', '', h1.textContent); h1.replaceWith(h2); }
      const div = mk('div', box.className); div.append(...box.childNodes);   // sin un segundo <main>
      host.className = ''; host.replaceChildren(div);
      const norm = t => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const rows = [...div.querySelectorAll('.cmd-table tbody tr')];
      rows.forEach(rw => { rw._t = norm((rw.getAttribute('data-k') || '') + ' ' + rw.textContent); });
      const q = div.querySelector('#cmdp-q'), pr = div.querySelector('#cmdp-print');
      if (q) q.addEventListener('input', () => { const v = norm(q.value.trim()); rows.forEach(rw => { rw.hidden = !!v && rw._t.indexOf(v) < 0; }); });
      if (pr) pr.addEventListener('click', () => window.print());
      cmdState = 'ready';
    } catch (e) {
      cmdState = 'idle';
      const rb = mk('button', 'ghost', 'Reintentar'); rb.type = 'button'; rb.addEventListener('click', loadCmdPanel);
      const a2 = mk('a', 'btn', 'Abrir la guía en otra página'); a2.href = 'comandos.html';
      host.className = ''; host.replaceChildren(mk('p', 'err', 'No se pudo cargar la guía de comandos (' + ((e && e.message) || 'error') + ').'), rowOf(rb, a2));
    }
  }
  $('cmdLink').addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button || $('app').classList.contains('hidden')) return;
    e.preventDefault(); showTab('cmd');
  });

  // ---- Foto desde el video en vivo: el casco no puede sacar foto mientras transmite, asi que se toma el cuadro en el visor ----
  const frames = new Map();   // device_id -> [{ id, created_at, url, name }] (solo en este navegador; tope 4 por casco)
  const FRAME_KEEP = 4;
  const setFrameNote = (dev, state, detail) => { CMD.last.set(dev, { id: null, dev, action: 'frame', at: Date.now(), state, detail, took: null }); cmdRefresh(dev); announce(label(dev) + ' · ' + cmdText(CMD.last.get(dev))); };
  function openFrame(dev, f) {
    const img = mk('img', 'photo-big'); img.src = f.url; img.alt = 'Cuadro del video del casco ' + dev + ', ' + fmt(f.created_at);
    const again = mk('button', '', 'Descargar de nuevo'); again.type = 'button';
    again.addEventListener('click', () => saveUrl(f.url, f.name));
    openDlg('Cuadro del video · casco ' + dev, [img, mk('p', 'mute', 'Archivo: ' + f.name + '. Se guarda solo en tu PC; la plataforma no conserva copias.'), rowOf(again)]);
  }
  function showFrame(dev, r) {
    const f = { id: 'f' + Date.now(), created_at: new Date().toISOString(), url: URL.createObjectURL(r.blob), name: r.name };
    let a = frames.get(dev); if (!a) frames.set(dev, a = []);
    a.unshift(f);
    while (a.length > FRAME_KEEP) { try { URL.revokeObjectURL(a.pop().url); } catch (_) {} }
    try { saveUrl(f.url, f.name); } catch (_) {}
    setFrameNote(dev, 'ok', f.name);
    const img = mk('img', 'photo-big'); img.src = f.url; img.alt = 'Cuadro del video del casco ' + dev + ', ' + fmt(f.created_at);
    const d = openDlg('Cuadro del video guardado', [img,
      mk('p', '', 'Se guardó en tu PC como ' + f.name + '.'),
      mk('p', 'mute', 'Es un cuadro del video en vivo (con el giro y el recorte del visor). La plataforma no conserva copias: informá al personal.')]);
    return d;
  }
  async function takePhoto(dev) {
    const L = lives.get(dev);
    if (L && L.hasFrame()) { const r = await L.snap(); if (r) { showFrame(dev, r); return; } }
    return sendCmd(dev, 'photo');
  }
  async function frameFromVideo(dev) {
    const L = ensureLive(dev);
    if (!L) { setFrameNote(dev, 'error', 'el video en vivo no está disponible'); return; }
    if (!L.hasFrame()) {
      setFrameNote(dev, 'pending', 'iniciando el video del casco…');
      if (!L.isLive()) L.start();
      const t0 = Date.now();
      while (Date.now() - t0 < 30000 && !L.hasFrame()) await sleep(500);
    }
    const r = L.hasFrame() ? await L.snap() : null;
    if (!r) { setFrameNote(dev, 'error', 'no llegó imagen del video en 30 s (revisá la señal del casco)'); return; }
    showFrame(dev, r);
  }

  // ---- Microfono: permiso, ayuda paso a paso y prueba con medidor ----
  const MIC_PATH = 'chrome://settings/content/microphone';
  const micMsg = n => n === 'NotAllowedError' || n === 'SecurityError' ? 'permiso de micrófono denegado: habilitalo en el navegador'
    : n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' ? 'no se encontró un micrófono conectado'
    : n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError' ? 'otra aplicación está usando el micrófono: cerrala y probá de nuevo'
    : 'no se pudo usar el micrófono (' + (n || 'error') + ')';
  async function micPermState() {
    try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: 'microphone' })).state; } catch (_) {}
    return 'unknown';
  }
  function showMicHelp() {
    const steps = mk('ol', 'micsteps');
    for (const t of ['Tocá el candado a la izquierda de la dirección de la página.', 'Elegí “Configuración del sitio”.', 'En “Micrófono” poné “Permitir”.', 'Recargá la página (F5).']) steps.append(mk('li', '', t));
    const code = mk('code', 'mono', MIC_PATH);
    const copy = mk('button', 'ghost', 'Copiar'); copy.type = 'button';
    copy.setAttribute('aria-label', 'Copiar la ruta ' + MIC_PATH);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(MIC_PATH); announce('Ruta copiada.'); copy.textContent = 'Copiado'; }
      catch (_) { const r = document.createRange(); r.selectNodeContents(code); const sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(r); announce('Seleccionada: copiala con Ctrl+C.'); copy.textContent = 'Seleccionada: Ctrl+C'; }
    });
    openDlg('El micrófono está bloqueado', [
      mk('p', '', 'El navegador no deja usar el micrófono en este sitio. Para habilitarlo:'), steps,
      mk('p', 'mute', 'También podés abrir esta dirección en una pestaña nueva (copiala, el navegador no deja abrirla desde acá):'), rowOf(code, copy),
      mk('p', 'mute', 'En Windows, revisá además Configuración > Privacidad > Micrófono: tiene que estar permitido para el navegador.')]);
  }
  async function testMic() {
    if ((await micPermState()) === 'denied') { showMicHelp(); return; }
    const msg = mk('p', 'mute', 'Pidiendo acceso al micrófono…'); msg.setAttribute('role', 'status');
    const m = mk('meter'); m.min = 0; m.max = 1; m.value = 0; m.hidden = true; m.setAttribute('aria-label', 'Nivel del micrófono');
    const d = openDlg('Probar micrófono', [msg, m, mk('p', 'mute', 'Hablá: la barra tiene que moverse. No se graba ni se envía nada.')]);
    let stream = null, ac = null, tm = null;
    d.addEventListener('close', () => { clearInterval(tm); if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); if (ac) { try { ac.close(); } catch (_) {} } });
    const r = await acquireMic(15000);
    if (!d.open) { if (r.ms) r.ms.getTracks().forEach(t => t.stop()); return; }
    if (!r.ms) {
      if (r.err === 'NotAllowedError' || r.err === 'SecurityError') { d.close(); showMicHelp(); return; }
      msg.textContent = 'No se pudo usar el micrófono: ' + micMsg(r.err) + '.'; msg.classList.add('bad');
      return;
    }
    stream = r.ms;
    const tr = stream.getAudioTracks()[0];
    msg.textContent = 'Micrófono listo' + (tr && tr.label ? ': ' + tr.label : '') + '.';
    m.hidden = false;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const an = ac.createAnalyser(); an.fftSize = 256;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      tm = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        m.value = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      }, 100);
    } catch (_) { msg.textContent += ' (sin medidor en este navegador)'; }
  }
  $('testMic').addEventListener('click', testMic);

  // ---- Roles en la UI (el servidor tambien lo exige por RLS): admin hace todo; supervisor (viewer) mira, atiende y manda mensajes ----
  function applyRole() {
    const adm = isAdmin();
    $('who').textContent = (($('who').dataset.email || '') + ' · ' + (adm ? 'admin' : 'supervisor')).replace(/^ · /, '');
    $('btnEvac').disabled = !adm;
    $('evacRoleNote').classList.toggle('hidden', adm);
    if (!adm) closeEvac();
    for (const id of ['gDrawCircle', 'gDrawPoly', 'gAddPoint']) $(id).disabled = !adm;
    $('mapRoleNote').classList.toggle('hidden', adm);
    if (!adm && typeof setMode === 'function') setMode(null);
  }
  const roNote = what => mk('p', 'mute rolenote', 'Tu rol (supervisor) es de solo lectura: ' + what + ' las hace un administrador.');
  function resetT4() {
    closeDlg();
    CMD.items.clear(); CMD.last.clear(); CMD.torch.clear(); CMD.avail = 'unknown';
    clearInterval(CMD.timer); CMD.timer = null; CMD.polling = false;
    if (CMD.ch) { try { sb.removeChannel(CMD.ch); } catch (_) {} CMD.ch = null; }
    photos.clear(); evAlerts.clear(); signedCache.clear(); cmdViews.clear(); cmdBars.clear(); IMG.clear(); delSel.clear();
    for (const a of frames.values()) a.forEach(f => { try { URL.revokeObjectURL(f.url); } catch (_) {} });
    frames.clear();
    QR.view = 'unknown'; repQ.reset(); histQ.reset();
    ARC.ids.clear(); ARC.avail = 'unknown'; ARC.show = false;
    if (ARC.ch) { try { sb.removeChannel(ARC.ch); } catch (_) {} ARC.ch = null; }
  }

  // ---- Sesion vencida: aviso fijo + volver al login (el feed queda a la vista, sin perderlo en silencio) ----
  let expired = false;
  function sessionExpired() {
    if (expired || manualLogout) return;
    expired = true;
    $('status').textContent = 'Sesión vencida';
    setBar('connBar', '');   // el aviso de sesion vencida manda
    const bar = mk('div', 'sess-bar'); bar.id = 'sessBar'; bar.setAttribute('role', 'alert');
    const go = mk('button', '', 'Volver al login'); go.type = 'button';
    bar.append(mk('span', '', 'Sesión vencida, ingresá de nuevo. Los datos que ves pueden estar desactualizados.'), go);
    go.addEventListener('click', () => {
      bar.remove(); overlayHidden = true; setOverlay(false);
      teardownSession();   // sirena, intervalos, paneles en vivo y rol de la sesion anterior
      $('app').classList.add('hidden'); $('login').classList.remove('hidden');
      $('loginErr').textContent = 'Sesión vencida, ingresá de nuevo';
      $('password').value = ''; $('password').focus();
    });
    sysBars().prepend(bar);
  }
  const clearExpired = () => { expired = false; const b = $('sessBar'); if (b) b.remove(); updateConnBar(); };

  // ---- Avisos fijos arriba (conexion, audio) y aviso flotante de errores de accion ----
  function sysBars() {
    let c = $('sysBars');
    if (!c) { c = mk('div'); c.id = 'sysBars'; document.body.prepend(c); }
    return c;
  }
  // text vacio = quitar el aviso. role=alert se anuncia al crearse; los cambios de texto no se repiten.
  function setBar(id, text, btnLabel, onClick) {
    let b = $(id);
    if (!text) { if (b) b.remove(); return; }
    if (!b) {
      b = mk('div', 'sess-bar'); b.id = id; b.setAttribute('role', 'alert');
      b.append(mk('span'));
      if (btnLabel) { const x = mk('button', '', btnLabel); x.type = 'button'; x.addEventListener('click', onClick); b.append(x); }
      sysBars().append(b);
    }
    const sp = b.firstChild; if (sp.textContent !== text) sp.textContent = text;
  }
  let toastT = null;
  function toast(msg) {
    let t = $('vigToast');
    if (!t) { t = mk('div', 'vig-toast'); t.id = 'vigToast'; t.setAttribute('role', 'alert'); document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 15000);
  }
  function updateConnBar() {
    const inApp = !$('app').classList.contains('hidden');
    const down = inApp && connDown();
    setBar('connBar', down && !expired ? 'Sin conexión con alertas: puede haber alertas sin mostrar' : '', 'Reintentar', () => resyncNow());
    if (down !== connWasDown) { connWasDown = down; if (inApp) renderPending(); }   // "Todo en orden" no puede quedar en pantalla sin canal
  }
  // Resultado de cada lectura de eventos: marca la salud de la conexion y avisa de lo recuperado.
  function noteSync(r) {
    syncFail = !!(r.error || r.truncated);
    if (!r.error && !netOff && !rtDown && channel && channel.state === 'joined' && $('status').textContent !== 'En vivo') $('status').textContent = 'En vivo';
    updateConnBar();
    if (r.error && isAuthErr(r.error)) sessionExpired();
    if (r.recovered) toast(r.recovered === 1 ? 'Se recuperó 1 alerta pendiente que no había llegado en vivo.' : 'Se recuperaron ' + r.recovered + ' alertas pendientes que no habían llegado en vivo.');
  }
  // Red de seguridad: Realtime es "como mucho una vez", asi que se relee cada ~30 s, al volver visible y al volver la red.
  const RESYNC_MS = 30000;
  let resyncT = null;
  function resyncNow() {
    if ($('app').classList.contains('hidden') || expired) return;
    if (channel && (channel.state === 'closed' || channel.state === 'errored')) { rtDown = true; updateConnBar(); }
    syncEvents();   // noteSync() procesa el resultado (error, recuperados, sirena via alertSos)
    loadDevices();
  }
  // Salir de la sesion (vencida o nueva): sirena, intervalos, paneles en vivo y rol no pueden sobrevivir en el login.
  function teardownSession() {
    clearInterval(resyncT); resyncT = null; clearInterval(escTimer); escTimer = null;
    pending.clear(); syncAlarm();   // sin pendientes: apaga sirena, cartel, titulo e intervalo
    dropWake();
    rtDown = syncFail = false; connWasDown = false;
    setBar('connBar', ''); setBar('audBar', '');
    for (const L of [...lives.values()]) {
      try { if (L.stop) Promise.resolve(L.stop()).catch(() => {}); } catch (_) {}
      if (L.sec) L.sec.remove();
    }
    lives.clear();
    const lv = $('lives'); if (lv) { lv.replaceChildren(); lv.classList.add('hidden'); }
    ROLE = 'viewer';
    for (const c of [channel, chOrders, chGeo]) if (c) { try { sb.removeChannel(c); } catch (_) {} }
    channel = chOrders = chGeo = null;
  }

  // ---- Sincronizacion de eventos: carga inicial y resync tras reconexion (dedupe por id) ----
  const PEND_DAYS = 7;
  let startGen = 0, evLoaded = false, syncing = null, syncAgain = false;
  async function fetchAcks(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 80) {
      const r = await sb.from('event_acks').select(ACK_COLS).in('event_id', ids.slice(i, i + 80));
      if (r.error) return { error: r.error, rows: out };
      out.push(...(r.data || []));
    }
    return { error: null, rows: out };
  }
  // Alertas de los ultimos 7 dias, paginadas (antes: limit 500 fijo que dejaba afuera los SOS mas viejos sin avisar).
  const OLD_PAGE = 500, OLD_PAGES = 6;
  async function fetchOlds(since) {
    const rows = [];
    for (let p = 0; p < OLD_PAGES; p++) {
      const r = await sb.from('events').select(EV_COLS).in('type', ['sos', 'fall', 'geofence', 'not_worn', 'inactive']).gte('created_at', since)
        .order('created_at', { ascending: false }).range(p * OLD_PAGE, (p + 1) * OLD_PAGE - 1);
      if (r.error) return { error: r.error, rows };
      const d = Array.isArray(r.data) ? r.data : [];
      rows.push(...d);
      if (d.length < OLD_PAGE) return { error: null, rows };
    }
    return { error: null, rows, truncated: true };
  }
  async function doSyncEvents() {
    const since = new Date(Date.now() - PEND_DAYS * 86400000).toISOString();
    const [recent, olds] = await Promise.all([
      sb.from('events').select(EV_COLS).neq('type', 'heartbeat').neq('type', 'location').order('created_at', { ascending: false }).limit(50),
      fetchOlds(since),
    ]);
    if (recent.error) return { error: recent.error };
    const byId = new Map(recent.data.map(e => [e.id, e]));
    const extra = olds.rows.filter(needsAttention);
    const cand = new Map();
    for (const e of [...recent.data, ...extra]) if (needsAttention(e)) cand.set(e.id, e);
    const ar = cand.size ? await fetchAcks([...cand.keys()]) : { error: null, rows: [] };
    for (const a of ar.rows) {
      if (acks.has(a.event_id)) continue;
      if (cards.has(a.event_id)) applyAck(a); else acks.set(a.event_id, a);
    }
    // Pendientes viejos (hasta 7 dias) que quedaron fuera de los ultimos 50: solo si el ack se pudo consultar entero.
    if (!ar.error) for (const e of extra) if (!acks.has(e.id)) byId.set(e.id, e);
    const list = [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let recovered = 0;
    for (const ev of list) {
      noteDevice(ev.device_id, ev.created_at, ev.battery);
      if (ev.lat != null && ev.lng != null) noteLoc(ev);
      if (evLoaded && !cards.has(ev.id) && needsAttention(ev) && !acks.has(ev.id)) { recovered++; alertSos(ev); }   // llego mientras el canal estaba caido: suena la sirena
      render(ev);
    }
    evLoaded = true;
    syncEmpty(); renderPending();
    // Si falto la lectura de viejos o de acuses, lo cargado se muestra igual pero se devuelve el error (aviso fijo + reintento).
    const err = olds.error || ar.error || null;
    return { error: err, partial: !!err, recovered, truncated: !!olds.truncated };
  }
  // Una sola consulta a la vez; si piden otra mientras corre, se repite al terminar.
  function syncEvents() {
    if (syncing) { syncAgain = true; return syncing; }
    syncing = (async () => {
      try { const r = await doSyncEvents(); noteSync(r); return r; }
      catch (e) { const r = { error: e }; noteSync(r); return r; }
      finally { syncing = null; if (syncAgain) { syncAgain = false; syncEvents(); } }
    })();
    return syncing;
  }

  // Re-render agrupado: heartbeats y ubicaciones llegan a ritmo alto; se junta todo en una sola pasada cada 250 ms.
  const R_DEV = 1, R_MAP = 2;
  let rqFlags = 0, rqT = null;
  function scheduleRender(f) {
    rqFlags |= f;
    if (rqT) return;
    rqT = setTimeout(() => {
      rqT = null; const q = rqFlags; rqFlags = 0;
      if (q & R_DEV) { renderDevices(); evalHealth(); }
      if (q & R_MAP) renderMapLists();
    }, 250);
  }
  const resubscribed = reload => { let lost = false; return st => {
    if (st === 'SUBSCRIBED') { if (lost) reload(); lost = false; }
    else if (st === 'CLOSED' || st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') lost = true;
  }; };

  async function start(session) {
    const gen = ++startGen;
    teardownSession();   // sesion anterior (o reintento): sin sirena, paneles en vivo ni rol heredados
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    $('connWrap').classList.remove('hidden');
    $('pendBox').setAttribute('aria-busy', 'true');
    $('who').textContent = session.user.email;
    $('feed').replaceChildren(); $('feedDone').replaceChildren(); $('pendList').replaceChildren();
    {
      let r = session.user && session.user.app_metadata && session.user.app_metadata.role;
      if (!r) { try { const c = JSON.parse(atob(String(session.access_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); r = c.app_metadata && c.app_metadata.role; } catch (_) {} }
      ROLE = r === 'admin' ? 'admin' : 'viewer';
    }
    $('who').dataset.email = session.user.email;
    resetT4(); applyRole();
    // Estado limpio (Reintentar / nuevo ingreso): sin tarjetas fantasma de la sesion anterior.
    cards.clear(); pending.clear(); acks.clear(); pendEls.clear(); devOf.clear(); evAt.clear();
    devState.clear(); hAlerts.clear(); hSig = ''; posLoaded = false; lastPos.clear(); trail.clear(); geoInfos.clear(); lastEv = null;
    evLoaded = false;
    netOff = navigator.onLine === false;
    ensureAudio();   // sin gesto previo queda bloqueado: syncAudioBar muestra "Sirena silenciada" hasta el primer toque
    holdWake();

    // 1) Canal Realtime PRIMERO: lo que entre durante la carga inicial no se pierde (se deduplica por id).
    if (channel) sb.removeChannel(channel);
    let lostCh = false;
    channel = sb.channel('events-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, p => {
        const ev = p.new;
        noteDevice(ev.device_id, ev.created_at, ev.battery, ev.type === 'heartbeat' ? ev.payload : null);
        if (ev.type === 'heartbeat') { noteRot(ev.device_id, ev.created_at, ev.payload); scheduleRender(R_DEV); return; }
        if (ev.type === 'location') { noteLoc(ev); scheduleRender(R_DEV | R_MAP); return; }
        scheduleRender(R_DEV);
        if (ev.lat != null && ev.lng != null) noteLoc(ev);
        if (needsAttention(ev) && !cards.has(ev.id) && !acks.has(ev.id)) alertSos(ev);
        if (!cards.has(ev.id) && !(arcOk() && ARC.ids.has(String(ev.id)))) bumpHist();
        render(ev);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'event_acks' }, p => applyAck(p.new))
      .subscribe(s => {
        $('status').textContent = s === 'SUBSCRIBED' ? 'En vivo' : s === 'CLOSED' ? 'Sin conexión' : (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') ? 'Sin señal: reintentando' : s;
        if (s === 'SUBSCRIBED') {
          // Tras una caida (o recien suscripto): releer eventos y acuses desde Supabase; lo repetido se descarta por id.
          const was = lostCh; lostCh = false;
          if (evLoaded || was) {
            // el aviso de "sin conexion" baja recien cuando termina la relectura (si falla, sigue por syncFail)
            syncEvents().then(() => { if (channel && channel.state === 'joined') { rtDown = false; updateConnBar(); } });
            if (was) { loadDevices(); loadLocations(); loadBroadcasts(); }
          } else { rtDown = false; updateConnBar(); }
        } else {
          if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') lostCh = true;
          rtDown = true; updateConnBar();
        }
      });
    // Canales aparte: si una tabla nueva todavia no esta publicada en Realtime, no se cae el feed principal.
    for (const c of [chOrders, chGeo]) if (c) sb.removeChannel(c);
    chOrders = sb.channel('orders-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'broadcasts' }, p => { noteBc(p.new); renderBroadcasts(); bumpHist(); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'broadcast_acks' }, p => { noteBcAck(p.new); renderBroadcasts(); })
      .subscribe(resubscribed(() => loadBroadcasts()));
    chGeo = sb.channel('geo-equipos')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'geofences' }, reloadGeo)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'geo_points' }, reloadGeo)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, reloadEq)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, reloadEq)
      .subscribe(resubscribed(() => { reloadGeo(); reloadEq(); }));

    // 2) Carga inicial (los medios se piden en segundo plano dentro de render).
    const r = await syncEvents();
    if (gen !== startGen) return;
    if (r.error && !r.partial) {   // [UI] estado de error con reintento (si fue parcial, lo cargado se ve y el aviso fijo + resync siguen)
      if (isAuthErr(r.error)) { $('pendBox').removeAttribute('aria-busy'); sessionExpired(); return; }
      $('status').textContent = 'Sin conexión con alertas';
      if (!resyncT) resyncT = setInterval(resyncNow, RESYNC_MS);
      const eb = mk('li', 'err-state'), rb = mk('button', '', 'Reintentar'); rb.type = 'button';
      rb.addEventListener('click', () => start(session));
      eb.append(mk('strong', '', 'No se pudieron cargar las alertas'), mk('span', '', 'Puede haber alertas sin mostrar. Revisá la conexión y tocá Reintentar.'), rb);
      $('pendList').replaceChildren(eb); $('pendBox').removeAttribute('aria-busy');
      return;
    }
    if (!resyncT) resyncT = setInterval(resyncNow, RESYNC_MS);
    loadEscalation(); loadBroadcasts(); loadGeo(); loadArchive();
    (async () => {   // cascos y posiciones por casco: primero se conocen los registrados
      await Promise.allSettled([loadEquipos()]);
      await loadDevices();
      await loadLocations();
      posLoaded = true; evalHealth();
    })();
    if (!escTimer) escTimer = setInterval(loadEscalation, 5 * 60 * 1000);
    syncEmpty();
    renderPending();
    $('pendBox').removeAttribute('aria-busy');
  }

  $('login').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginErr').textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    if (error) { $('loginErr').textContent = 'No se pudo ingresar: ' + error.message; return; }
    manualLogout = false; clearExpired();
    start(data.session);
  });
  $('logout').addEventListener('click', async () => { manualLogout = true; await sb.auth.signOut(); location.reload(); });
  $('enableSound').addEventListener('click', () => {
    ensureAudio(); askNotif(); sirenBurst();
  });

  // ---- [UI] Tema claro/oscuro persistente, reloj Argentina, estado de conexion ----
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
  function syncThemeBtn() {
    const d = isDark();
    $('themeBtn').setAttribute('aria-label', d ? 'Cambiar a tema claro (alto contraste, pleno sol)' : 'Cambiar a tema oscuro (sala de control)');
    $('themeBtn').title = $('themeBtn').getAttribute('aria-label');
  }
  $('themeBtn').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('casco-theme', next); } catch (_) {}
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.removeAttribute('media'); m.content = next === 'dark' ? '#0e1a20' : '#edf1ef'; });
    syncThemeBtn();
  });
  syncThemeBtn();
  const tickClock = () => { $('clock').textContent = new Date().toLocaleTimeString('es-AR', { timeZone: TZ, hour12: false }) + ' ART'; };
  tickClock(); setInterval(tickClock, 1000);
  const syncConn = () => {
    const t = $('status').textContent;
    $('connWrap').dataset.state = t === 'En vivo' ? 'ok' : /^Conectando/.test(t) ? 'wait' : 'bad';
    $('status').title = t;
  };
  new MutationObserver(syncConn).observe($('status'), { childList: true, characterData: true, subtree: true });
  syncConn();
  // Limpieza al cerrar la pagina (no si va a bfcache): timers y canales.
  window.addEventListener('pagehide', e => {
    if (e.persisted) return;
    for (const t of [escTimer, resyncT, sirenT, CMD.timer, eqTimer, geoTimer, mapTimer, rqT, armTimer]) { clearInterval(t); clearTimeout(t); }
    stopSiren(); closeNotifs();
    for (const c of [channel, chOrders, chGeo, CMD.ch]) if (c) { try { sb.removeChannel(c); } catch (_) {} }
  });
  window.addEventListener('offline', () => { netOff = true; $('status').textContent = 'Sin conexión a internet'; updateConnBar(); });
  window.addEventListener('online', () => { netOff = false; $('status').textContent = 'Reconectando…'; updateConnBar(); resyncNow(); });

  sb.auth.getSession().then(({ data }) => { if (data.session) start(data.session); });
})();
