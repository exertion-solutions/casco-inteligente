/* Vigía · Casco Inteligente · visor. Logica movida tal cual desde index.html; cambios de presentacion marcados con [UI]. */
(() => {
  const $ = id => document.getElementById(id);
  const cfg = window.CASCO_CONFIG || {};
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let audioCtx = null, channel = null, chOrders = null, chGeo = null, escTimer = null;
  const TZ = 'America/Argentina/Buenos_Aires';
  const fmt = iso => new Date(iso).toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' });   // 24 h, como el reloj del encabezado

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
  // Mensajes crudos de Supabase/red -> frases cortas en español (el detalle técnico queda en la consola).
  function errEs(e) {
    const m = String((e && e.message) || e || ''), c = String((e && e.code) || '');
    try { console.warn('[vigia] error:', c, m); } catch (_) {}
    if (/invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/email not confirmed/i.test(m)) return 'El correo todavía no fue confirmado.';
    if (/failed to fetch|networkerror|load failed|network request|sin conexi/i.test(m)) return 'No hay conexión con el servidor. Revisá tu internet y probá de nuevo.';
    if (/jwt|token.*(expired|invalid)|session.*(expired|missing)/i.test(m) || c === 'PGRST301') return 'Tu sesión venció. Ingresá de nuevo.';
    if (c === '42501' || /permission denied|row-level security|not authorized|rol no autorizado|no autorizado/i.test(m)) return 'No tenés permiso para hacer esto.';
    if (c === '23505' || /duplicate key/i.test(m)) return 'Ese dato ya existe.';
    if (/rate limit|too many requests|over_.*rate/i.test(m)) return 'Demasiados intentos seguidos. Esperá un momento y probá de nuevo.';
    if (/timeout|timed out|statement timeout/i.test(m) || c === '57014') return 'El servidor tardó demasiado en responder. Probá de nuevo.';
    if (/could not find the (table|relation)|schema cache|does not exist/i.test(m)) return 'Esta función todavía no está disponible en el servidor.';
    if (/violates|constraint|invalid input/i.test(m)) return 'El servidor rechazó el dato. Revisalo y probá de nuevo.';
    return 'El servidor devolvió un error. Probá de nuevo; si sigue, avisá a un administrador.';
  }
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
    if (!liveOk() || !DEV_RE.test(id)) return null;
    if (lives.has(id)) return lives.get(id);
    const sec = mk('section', 'card live collapsed');   // colapsado por defecto en el Centro (ver CSS .live.collapsed)
    sec.setAttribute('aria-label', 'Video en vivo del casco ' + id);
    const head = mk('div', 'live-head'), body = mk('div', 'live-body');
    head.append(dlEl('h2', id, 'Video en vivo · '));
    sec.append(head, body);
    const row = mk('div', 'row');
    const bStart = mk('button', '', 'Iniciar'); bStart.type = 'button';
    const bStop = mk('button', 'ghost', 'Detener'); bStop.type = 'button'; bStop.disabled = true;
    const state = mk('span', 'state', 'Detenido'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    bStart.setAttribute('aria-label', 'Iniciar el video del casco ' + id); bStop.setAttribute('aria-label', 'Detener el video del casco ' + id);
    const bView = mk('button', 'ghost bview', 'Ver en vivo'); bView.type = 'button'; bView.setAttribute('aria-expanded', 'false');
    const syncView = () => {
      const open = !sec.classList.contains('collapsed');
      bView.textContent = open ? 'Ocultar video' : 'Ver en vivo';
      bView.setAttribute('aria-expanded', String(open));
      bView.setAttribute('aria-label', bView.textContent + ', casco ' + id);
    };
    syncView();
    const stats = mk('span', 'mute');
    const bRetry = mk('button', 'attend hidden', 'Reintentar');   // accion segura: acento, no rojo bRetry.type = 'button';
    bRetry.setAttribute('aria-label', 'Reintentar la conexión de video con el casco ' + id);
    const bTalk = mk('button', '', 'Hablar'); bTalk.type = 'button';
    bTalk.setAttribute('aria-label', 'Hablar con el casco ' + id + ' (llamada de voz en vivo)');
    row.append(bStart, bStop, bTalk, bRetry, stats);
    head.append(state, bView);   // el estado queda visible aunque el panel este colapsado
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
      // el nombre accesible empieza con el texto visible (control por voz)
      bRot.setAttribute('aria-label', bRot.textContent + ', casco ' + id + ': gira la imagen 90 grados y pasa a modo manual');
      bAuto.setAttribute('aria-label', bAuto.textContent + ', casco ' + id + ': orientación automática de la imagen');
    };
    const saveRot = () => { try { localStorage.setItem(ROT_KEY, String(rot)); localStorage.setItem(MODE_KEY, auto ? 'auto' : 'manual'); } catch (_) {} };
    const bRot = mk('button', 'ghost', 'Girar'); bRot.type = 'button';
    bRot.addEventListener('click', () => { rot = (curRot() + 90) % 360; auto = false; applyRot(); saveRot(); });
    const bAuto = mk('button', 'ghost', 'Auto'); bAuto.type = 'button';
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
    bFull.setAttribute('aria-label', 'Pantalla completa, casco ' + id);
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
      bSound.setAttribute('aria-label', bSound.textContent + ', casco ' + id);
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
    const bHang = mk('button', 'danger', 'Colgar'); bHang.type = 'button';
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
    bShot.setAttribute('aria-label', 'Captura, casco ' + id + ': guarda la imagen como PNG');
    const bAgain = mk('button', 'ghost hidden', 'Descargar de nuevo'); bAgain.type = 'button';
    const chk = (txt, on) => { const l = mk('label', 'chk'); const i = mk('input'); i.type = 'checkbox'; i.checked = on; l.append(i, txt); return [l, i]; };
    const [lMicRec, cMic] = chk('Incluir mi micrófono', true), [lCasRec, cCasco] = chk('Incluir audio del casco', true);
    const recState = mk('span', 'state', ''); recState.setAttribute('role', 'status'); recState.setAttribute('aria-live', 'polite');
    const recTime = mk('span', 'mute', '');
    const recNote = mk('p', 'mute', ''); recNote.style.margin = '0';
    rrow.append(bRec, bShot, bAgain, lMicRec, lCasRec, recTime, recState);
    body.append(row, rrow, recNote, asistMini(id), cmdBar(id), vrow, wrap);
    $('lives').append(sec); $('lives').classList.remove('hidden');

    const L = { id, sec, bStart, bStop, gen: 0, pc: null, loc: null, statsTimer: null };
    L.syncSound = syncSound;
    const setState = (t, bad) => { state.textContent = t; state.classList.toggle('bad', !!bad); state.dataset.w = ''; };
    // El contador de segundos va en un span aria-hidden: el lector anuncia el cambio de estado, no cada segundo.
    const cnt = mk('span', 'mute'); cnt.setAttribute('aria-hidden', 'true');
    const setWait = secs => {
      if (state.dataset.w !== '1') { setState('Esperando al casco…'); state.dataset.w = '1'; state.append(cnt); }
      cnt.textContent = ' ' + secs + ' s';
    };
    L.expand = () => { sec.classList.remove('collapsed'); syncView(); };
    bView.addEventListener('click', () => {
      if (sec.classList.contains('collapsed')) { L.expand(); if (!L.isLive() && !bStart.disabled) L.start(); bStop.focus({ preventScroll: true }); }
      else { sec.classList.add('collapsed'); syncView(); bView.focus({ preventScroll: true }); }
    });
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
      const tick = () => { if (gen === L.gen) setWait(Math.floor((Date.now() - t0) / 1000)); };
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
      logAccess('view_live', id);
      const gen = ++L.gen;
      L.expand();
      closePc();   // reinicia el ciclo en un clic: se cierra cualquier intento anterior
      bRetry.classList.add('hidden');
      bStart.disabled = true; bStop.disabled = false;
      setState('Solicitando…');
      const { error } = await sb.from('stream_commands').insert({ device_id: id, action: 'start' });
      if (gen !== L.gen) return;
      if (error) { fail('no se pudo solicitar: ' + errEs(error)); return; }
      run(gen);
    };
    L.stop = async () => {
      L.gen++;
      bStart.disabled = false; bStop.disabled = true;
      closePc(); video.srcObject = null; wrap.classList.add('hidden'); bRetry.classList.add('hidden');
      setState('Deteniendo…');
      await deleteSession();
      const { error } = await sb.from('stream_commands').insert({ device_id: id, action: 'stop' });
      if (error) setState('Error: no se pudo enviar stop: ' + errEs(error), true); else setState('Detenido');
    };
    bStart.addEventListener('click', () => { asistAuto(id); L.start(); });   // "Iniciar": abre sola la sesion de asistencia si no hay una
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
      if (s !== wmSec) { wmSec = s; wmTxt = 'Vigía · Casco ' + id + ' · ' + new Date().toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }); }
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
      logAccess('record_stop', id, { dur_s: Math.max(0, Math.round((Date.now() - r.t0) / 1000)), size: blob.size, auto: !!r.auto });
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
      logAccess('record_start', id, { auto: !!auto, mic: !!mic });
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
      logAccess('photo', id, { via: 'captura' }); noteLocalPhoto(id);
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
    bTalk.addEventListener('click', () => { asistAuto(id); startCall(); });   // "Hablar": idem
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
  // Severidad: 3 critica (sos, caida), 2 alta (zona de peligro, sin movimiento), 1 media (casco sin usar, zona restringida/permitida, equipo).
  // Sirena y cartel a pantalla completa solo desde nivel 2; nivel 1 = aviso silencioso (banner ambar, insignia y tono corto).
  const SEV_LOUD = 2;
  const sevOf = ev => {
    if (ev.type === 'sos' || ev.type === 'fall') return 3;
    if (ev.type === 'inactive') return 2;
    if (ev.type === 'geofence') { const p = ev.payload; return p && typeof p === 'object' && p.kind === 'peligro' ? 2 : 1; }
    return 1;
  };
  const SEV_NAME = { 3: 'crítica', 2: 'alta', 1: 'media' };
  // La mas grave primero; a igual gravedad, la que lleva mas tiempo esperando.
  const topPending = () => [...pending.values()].sort((a, c) => sevOf(c) - sevOf(a) || a.created_at.localeCompare(c.created_at))[0];
  const loudCount = () => { let n = 0; for (const e of pending.values()) if (sevOf(e) >= SEV_LOUD) n++; return n; };
  const nAlertas = n => n + (n === 1 ? ' alerta' : ' alertas');
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
    const last = topPending();
    const loud = loudCount() > 0;
    b.classList.toggle('med', !loud);   // solo avisos de nivel medio: banner ambar y sin anuncio asertivo
    b.setAttribute('role', loud ? 'alert' : 'status'); b.setAttribute('aria-live', loud ? 'assertive' : 'polite');
    const txt = document.createElement('span');
    txt.textContent = (pending.size === 1 ? '1 alerta sin atender: ' : nAlertas(pending.size) + ' sin atender. La más grave: ') +
      alertLabel(last) + (isManDown(last) ? ' · HOMBRE CAÍDO' : '') + ' · ' + label(last.device_id) + ' · ' + fmt(last.created_at);
    const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Ver alerta';
    go.addEventListener('click', () => {
      showTab('main');
      const li = pendEls.get(last.id) || cards.get(last.id);
      if (li) { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); const inp = li.querySelector('input'); if (inp) inp.focus({ preventScroll: true }); }
    });
    let cam = null;
    if (liveOk()) {
      cam = document.createElement('button'); cam.type = 'button'; cam.textContent = 'Ver en vivo';
      cam.addEventListener('click', () => openLive(last.device_id, true));
    }
    // Solo se reemplaza el contenido si el texto cambio (un re-render sin cambios no vuelve a anunciar el aviso).
    const sig = txt.textContent + '|' + last.id;
    if (b.dataset.sig !== sig || b.style.display !== 'block') {
      b.dataset.sig = sig;
      b.replaceChildren(txt, go, ...(cam ? [cam] : []));
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
  // Transcurrido legible: "16 s", "3 min 16 s", "1 h 05 min" (antes "03:16", ambiguo entre h:min y min:s).
  const elapsed = s => {
    s = Math.max(0, Math.floor(s));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min ' + pad2(s % 60) + ' s';
    return Math.floor(s / 3600) + ' h ' + pad2(Math.floor(s % 3600 / 60)) + ' min';
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
    if (age > OFFLINE_MS) out.push({ key: 'off', sev: 'warn', text: tag + 'sin señal: el casco avisó por última vez ' + ago(age) });
    const bat = batOf(s);
    if (bat != null && bat < BAT_CRIT) out.push({ key: 'bat-crit', sev: 'crit', text: tag + 'batería crítica (' + n1(bat) + ' %)' });
    else if (bat != null && bat < BAT_WARN) out.push({ key: 'bat-warn', sev: 'warn', text: tag + 'batería baja (' + n1(bat) + ' %)' });
    const t = num(s.p && s.p.temp_c);
    if (t != null && t > TEMP_MAX) out.push({ key: 'temp', sev: 'warn', text: tag + 'temperatura alta (' + n1(t) + ' °C)' });
    const fr = num(s.p && s.p.free_mb);
    if (fr != null && fr < FREE_MIN_MB) out.push({ key: 'free', sev: 'warn', text: tag + 'almacenamiento casi lleno (' + n1(fr / 1024) + ' GB libres)' });
    if (age <= OFFLINE_MS && posLoaded) {   // casco en linea pero sin fix GPS nuevo
      const lp = lastPos.get(id);
      if (!lp) out.push({ key: 'gps', sev: 'warn', text: tag + 'GPS sin posición: todavía no mandó una posición válida' });
      else if (now - lp.fixT > NOFIX_MS) out.push({ key: 'gps', sev: 'warn', text: tag + 'GPS sin posición nueva ' + ago(now - lp.fixT) });
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
      b.setAttribute('aria-label', 'Entendido, ocultar el aviso: ' + a.text);
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
    // Cascos activos registrados que nunca mandaron señal de vida: tambien cuentan como "sin señal".
    const never = EQ.devices.filter(d => !d.deleted_at && (d.status || 'activo') === 'activo' && DEV_RE.test(d.device_id) && !devState.has(d.device_id)).map(d => d.device_id);
    off += never.length;
    fillDest();
    if (!devLoaded && !devState.size) {   // antes de la primera lectura: "—", no "0 en línea"
      $('kpiDevN').textContent = '—'; $('kpiDevOff').textContent = devErr ? 'No se pudieron leer' : 'Cargando…'; $('kpiDevOff').className = devErr ? 'bad' : 'mute';
      box.className = devErr ? 'bad' : 'mute'; box.textContent = devErr ? 'No se pudieron leer los cascos. Se reintenta solo.' : 'Cargando cascos…';
      pruneCmdBars(new Set()); return;
    } else {
      $('kpiDevN').textContent = on + ' en línea';
      $('kpiDevOff').textContent = off + ' sin señal';
      $('kpiDevOff').className = off ? 'bad' : 'mute';
    }
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
        b.setAttribute('aria-label', 'Ver en el mapa, casco ' + id);
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
  let devLoaded = false, devErr = false;   // devLoaded: hubo al menos una lectura de cascos terminada (con o sin datos)
  async function loadDevices() {
    const HB = 'device_id,created_at,battery,type,payload';
    const hb = () => sb.from('events').select(HB).eq('type', 'heartbeat');
    try {
      const { data, error } = await hb().order('created_at', { ascending: false }).limit(200);
      if (!error && Array.isArray(data)) { devErr = false; devLoaded = true; for (const e of data) noteDevice(e.device_id, e.created_at, e.battery, e.payload); }
      else if (error && isAuthErr(error)) { sessionExpired(); return; }
      else if (error) devErr = true;
      // Un casco muy parlanchin llena la ventana global: los que faltan se piden uno por uno (ultimos 5 heartbeats).
      const missing = knownDevices().filter(id => !devState.has(id));
      const rs = await Promise.all(missing.map(id => hb().eq('device_id', id).order('created_at', { ascending: false }).limit(5)));
      for (const r of rs) if (!r.error && Array.isArray(r.data)) for (const e of r.data) noteDevice(e.device_id, e.created_at, e.battery, e.payload);
    } catch (_) { devErr = true; }
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
    $('pendList').querySelectorAll('.age').forEach(el => {
      el.textContent = 'hace ' + elapsed((Date.now() - Number(el.dataset.t)) / 1000);
    });
    $('pendList').querySelectorAll('.rulebox').forEach(b => ruleSet(b, (Date.now() - Number(b.dataset.t)) / 60000));
    // Antes de la primera lectura no se afirma "0 / Sin alertas": los KPI muestran "—" y quedan aria-busy.
    if (!evLoaded) {
      $('kpiPendN').textContent = '—'; $('kpiPend').classList.remove('alert'); $('kpiPend').setAttribute('aria-busy', 'true');
      $('kpiPendAge').textContent = syncFail ? 'No se pudieron cargar las alertas' : 'Cargando…';
      return;
    }
    $('kpiPend').removeAttribute('aria-busy');
    $('kpiPendN').textContent = String(pending.size);
    $('kpiPend').classList.toggle('alert', pending.size > 0);
    $('kpiPendAge').textContent = o ? 'La más antigua: hace ' + elapsed((Date.now() - new Date(o.created_at).getTime()) / 1000) : connDown() ? 'Sin conexión: no se puede confirmar' : 'Sin alertas pendientes';
    const nb = $('navPend'); nb.textContent = String(pending.size); nb.classList.toggle('hidden', !pending.size);
    nb.classList.toggle('med', pending.size > 0 && loudCount() === 0);
    // La insignia es visible para lectores de pantalla: el nombre de la pestaña incluye el conteo.
    const tl = pending.size ? 'Centro, ' + nAlertas(pending.size) + ' pendientes' + (loudCount() ? '' : ' (avisos de nivel medio)') : 'Centro';
    if ($('tabMain').getAttribute('aria-label') !== tl) $('tabMain').setAttribute('aria-label', tl);
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
    if (!liveOk() || !DEV_RE.test(devId || '')) return null;
    const see = mk('button', 'ghost', 'Ver en vivo'); see.type = 'button';
    see.setAttribute('aria-label', 'Ver en vivo el casco ' + devId);
    see.addEventListener('click', () => openLive(devId, true));
    return see;
  }
  function buildPending(ev) {   // [UI] tarjeta dominante: icono + texto + contador + regla de estacion
    const li = mk('li', 'card pitem t-' + ev.type + ' sv-' + sevOf(ev));
    const head = mk('div', 'a-head');
    const type = mk('span', 'a-type');
    type.append(icon(ICONS[ev.type] ? ev.type : 'sos', 28), document.createTextNode(alertLabel(ev)));
    head.append(type);
    if (isManDown(ev)) head.append(mk('span', 'tag sos', 'HOMBRE CAÍDO'));
    if (sevOf(ev) === 1) head.append(mk('span', 'tag warn', 'AVISO'));   // nivel medio: sin sirena ni cartel
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
    btn.setAttribute('aria-label', 'Atender, alerta del casco ' + ev.device_id);
    btn.addEventListener('click', () => attend(ev, btn, note));
    act.append(note, btn);
    const lv = liveAction(ev.device_id); if (lv) act.append(lv);
    li.append(head, meta, geoInfoEl('p' + ev.id, ev), rule);
    if (!isAuditor()) li.append(act);   // el auditor solo mira: sin nota ni Atender
    return li;
  }
  function renderPending() {
    const ul = $('pendList');
    const list = [...pending.values()].sort((a, b) => sevOf(b) - sevOf(a) || new Date(a.created_at) - new Date(b.created_at));   // mas grave primero; luego la mas antigua
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
  function attendError(btn, msg, errEl) {
    const act = btn.parentElement;
    if (errEl) errEl.textContent = msg;   // cartel SOS: el error va dentro del propio cartel
    else if (act) {
      let p = act.parentElement && act.parentElement.querySelector(':scope > .a-err');
      if (!p) { p = mk('p', 'a-err bad'); p.setAttribute('role', 'alert'); act.after(p); }
      p.textContent = msg;
    }
    toast(msg);
  }
  async function attend(ev, btn, noteEl, errEl) {
    if (isAuditor()) return;
    btn.disabled = true;
    if (errEl) errEl.textContent = '';
    const lbl = btn.textContent; btn.textContent = 'Atendiendo…';
    const done = () => { btn.disabled = false; btn.textContent = lbl; };
    const row = { event_id: ev.id };
    const t = noteEl ? noteEl.value.trim() : '';
    if (t) row.note = t;
    let error = null;
    try { error = (await sb.from('event_acks').insert(row)).error; } catch (e) { error = { message: String((e && e.message) || e) }; }
    if (error && error.code !== '23505') {
      done();
      if (isAuthErr(error)) { sessionExpired(); attendError(btn, 'Sesión vencida: ingresá de nuevo para atender la alerta.', errEl); return; }
      const m = String(error.message || ''), c = String(error.code || '');
      attendError(btn, c === '42501' || /row-level|permission/i.test(m)
        ? 'No tenés permiso para atender esta alerta.'
        : /fetch|network|timeout|conexi/i.test(m)
          ? 'No se pudo atender la alerta: sin conexión con el servidor. Probá de nuevo; si sigue, avisá por radio.'
          : 'No se pudo atender la alerta. Probá de nuevo; si sigue, avisá por radio.', errEl);
      return;
    }
    let data = null;
    try { data = (await sb.from('event_acks').select(ACK_COLS).eq('event_id', ev.id).maybeSingle()).data; } catch (_) {}
    // El acuse ya quedo guardado: si no se pudo releer, se muestra como atendida igual.
    applyAck(data || { event_id: ev.id, acked_by_email: $('who').dataset.email || null, acked_at: new Date().toISOString(), note: t || null });
    done();
    afterAttend(ev);
  }
  // Tras atender: anuncio y foco a algo logico (nada de caer en <body> porque la tarjeta desaparecio).
  function afterAttend(ev) {
    announce('Alerta de ' + label(ev.device_id) + ' atendida. ' + (pending.size ? 'Quedan ' + nAlertas(pending.size) + ' sin atender.' : 'No quedan alertas pendientes.'));
    if (!sosOv.hidden) { ovAtend.focus({ preventScroll: true }); return; }   // el cartel sigue con la proxima alerta
    if ($('panelMain').classList.contains('hidden')) return;               // el usuario esta en otra pestaña: el foco ya volvio donde estaba
    const next = $('pendList').querySelector('.pitem input');
    const t = next || $('pendH');
    if (t === $('pendH')) t.tabIndex = -1;
    t.focus({ preventScroll: false });
  }

  // ---- Escalamiento (solo lectura de public.escalation_rules) ----
  async function loadEscalation() {
    const el = $('escState');
    try {
      const { data, error } = await sb.from('escalation_rules').select('after_seconds,enabled').limit(10);
      if (error) { if (isAuthErr(error)) sessionExpired(); el.textContent = 'No se pudo leer el aviso a responsables (se reintenta solo)'; return; }
      if (!Array.isArray(data) || !data.length) { el.textContent = 'Aviso a responsables: sin configurar'; return; }
      const on = data.filter(r => r.enabled === true && num(r.after_seconds) != null).map(r => r.after_seconds);
      const n = on.length ? Math.min(...on) : 0, t = n >= 60 && n % 60 === 0 ? (n / 60) + ' min' : n + ' s';
      el.textContent = on.length ? 'Aviso a responsables: si nadie atiende una alerta en ' + t + ', se avisa a los responsables' : 'Aviso a responsables: desactivado';
    } catch (_) { el.textContent = 'No se pudo leer el aviso a responsables (se reintenta solo)'; }
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
            ? 'recibido ' + new Date(at).toLocaleTimeString('es-AR', { timeZone: TZ, hourCycle: 'h23' })
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
    return 'No se pudo enviar la orden: ' + errEs(error);
  }
  async function sendBroadcast(kind, message, dest, rep, errEl, btn) {
    if (isAuditor()) return false;
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
    logAccess('command', dest || 'todos', { orden: kind, repeticiones: r });
    if (res.data) { if (frozen) freezeTargets(res.data.id, frozen); noteBc(res.data); renderBroadcasts(); }
    $('orderOk').textContent = (kind === 'evacuacion' ? 'Evacuación enviada' : 'Mensaje enviado') + ' a ' + (dest ? 'el casco ' + dest : 'todos los cascos') + '.';
    return true;
  }
  // Reenvio a los cascos que no confirmaron: nueva orden solo para esos ids (mismo texto y repeticiones).
  async function resendBroadcast(b, ids) {
    if (isAuditor()) return;
    $('orderErr').textContent = ''; $('orderOk').textContent = '';
    const ok = await askConfirm('¿Reenviar a los que no confirmaron?',
      [mk('p', '', (b.kind === 'evacuacion' ? 'Evacuación' : 'Mensaje') + (b.message ? ': “' + b.message + '”' : '')), mk('p', 'mute', 'Cascos: ' + ids.map(label).join(', '))], 'Sí, reenviar', b.kind === 'evacuacion');
    if (!ok) return;
    let res;
    try { res = await sb.from('broadcasts').insert({ kind: b.kind, message: b.message, device_ids: ids, repeat: b.repeat }).select(BC_COLS).single(); }
    catch (e) { res = asRes(e); }
    if (res.error) { $('orderErr').textContent = bcError(res.error); return; }
    logAccess('command', ids.length === 1 ? ids[0] : 'varios', { orden: b.kind, reenvio: true, cascos: ids.length });
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
    } else if (isAuditor()) {
      li.classList.add('pending');
      box.append(mk('span', 'tag warn', 'PENDIENTE'));
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
  const TABS = [['main', 'tabMain', 'panelMain'], ['live', 'tabLive', 'panelMain'], ['map', 'tabMap', 'panelMap'], ['eq', 'tabEq', 'panelEq'], ['asis', 'tabAsis', 'panelAsis'], ['const', 'tabConst', 'panelConst'], ['done', 'tabDone', 'panelDone'], ['rep', 'tabRep', 'panelRep'], ['aud', 'tabAud', 'panelAud'], ['cmd', 'tabCmd', 'panelCmd']];
  // Aviso en la insignia de Historial: eventos u ordenes nuevas mientras se mira otra pestaña.
  let histNew = 0;
  function bumpHist() {
    if (!$('panelDone').classList.contains('hidden')) return;
    histNew++;
    const b = $('navHistNew'); b.textContent = String(histNew); b.classList.remove('hidden');
    $('histLive').textContent = histNew === 1 ? 'Hay una novedad nueva en Historial' : 'Hay ' + histNew + ' novedades nuevas en Historial';
    $('tabDone').setAttribute('aria-label', 'Historial, ' + (histNew === 1 ? '1 novedad nueva' : histNew + ' novedades nuevas'));
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
    if (name === 'asis') asisShow();
    if (name === 'const') constShow();
    if (name === 'aud') audShow();
    const selTab = $(act[1]); if (selTab && selTab.scrollIntoView) selTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // barra deslizable
    if (name === 'done') { histNew = 0; $('navHistNew').classList.add('hidden'); $('histLive').textContent = ''; $('tabDone').removeAttribute('aria-label'); }
  }
  for (const [k, t] of TABS) $(t).addEventListener('click', () => showTab(k));
  $('mainNav').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const vis = TABS.filter(x => $(x[1]).offsetParent !== null);   // las pestañas ocultas por CSS no entran en la ronda
    const cur = vis.findIndex(x => $(x[1]).getAttribute('aria-selected') === 'true');
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? vis.length - 1 : (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : vis.length - 1)) % vis.length;
    e.preventDefault();
    showTab(vis[i][0]); $(vis[i][1]).focus();
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
    li.className = 'card ev t-' + ev.type + (needsAttention(ev) ? ' sv-' + sevOf(ev) : '');
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
    if (ev.media_path && isAuditor()) {   // el auditor no accede a Storage: ve la huella registrada, no el archivo
      const h = hashOf(ev.payload);
      li.append(mk('p', 'mute', h ? 'Archivo con huella SHA-256 registrada: ' + h.sha.slice(0, 16) + '…' : 'Archivo sin huella registrada.'));
    } else if (ev.media_path && !IMG.has(String(ev.id))) {   // en segundo plano: no frena la carga ni el resto de las alertas
      const kind = ev.type === 'video' ? 'Video' : 'Foto';
      mediaEl(ev.media_path, ev.type, kind + ' del casco ' + ev.device_id + ', ' + fmt(ev.created_at)).then(el => {
        if (el && li.isConnected !== false && !IMG.has(String(ev.id))) {
          li.insertBefore(el, li.querySelector('.action'));
          el.after(verifyBox({ path: ev.media_path, hash: hashOf(ev.payload), id: ev.id, dev: ev.device_id, what: kind.toLowerCase() + ' del casco ' + ev.device_id + ', ' + fmt(ev.created_at) }));
        }
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
  const dbMsg = e => (noPerm(e) ? NO_PERM_TXT : 'No se pudo leer: ' + errEs(e));
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
    if (d === null || (d.length === 0 && ROLE === 'auditor')) { d = await pull('devices', () => sb.from('devices').select(DEV_COLS).is('deleted_at', null).order('name')); EQ.limited = true; }
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
    return 'No se pudo guardar: ' + errEs(e);
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
    const ok = mk('button', 'danger', yes); ok.type = 'button';
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
    logAccess('export_csv', name, { filas: rows.length });
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
    b.setAttribute('aria-label', 'Ver en mapa, posición del casco ' + ev.device_id);
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
        : 'Sin posición registrada todavía (el casco aún no mandó una posición GPS válida)'));
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
        mk('div', '', 'Hora de la posición: ' + fmt(p.fixT)), mk('div', '', 'Fuente: ' + pi.txt),
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
    if (!loudCount() || sirenMuted || !audioOn()) return;
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
      const n = new Notification((sevOf(ev) >= SEV_LOUD ? '¡' + alertLabel(ev) + (isManDown(ev) ? ' · HOMBRE CAÍDO' : '') + '!' : 'Aviso: ' + alertLabel(ev)) + ' · Vigía', {
        body: label(ev.device_id) + ' · ' + fmt(ev.created_at), tag: 'casco-' + ev.id, requireInteraction: true });
      n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
      n.onclose = () => notifs.delete(n);
      notifs.add(n);
    } catch (_) {}
  }
  const closeNotifs = () => { for (const n of [...notifs]) { try { n.close(); } catch (_) {} } notifs.clear(); };

  const sosOv = mk('div', 'sos-overlay');
  sosOv.id = 'sosOverlay'; sosOv.hidden = true;
  sosOv.setAttribute('role', 'alertdialog'); sosOv.setAttribute('aria-modal', 'true'); sosOv.setAttribute('aria-labelledby', 'sosOvT'); sosOv.setAttribute('aria-describedby', 'sosOvWho');
  const ovT = mk('h2', 'sos-ov-t', '¡ALERTA!'); ovT.id = 'sosOvT';
  const ovWho = mk('p', 'sos-ov-who'), ovWhen = mk('p', 'sos-ov-when mono'), ovMore = mk('p', 'sos-ov-more'), ovHint = mk('p', 'sos-ov-hint', 'Hacé clic o tocá la pantalla para activar el sonido de la alarma.');
  ovWho.id = 'sosOvWho';
  // Atender en un paso: nota opcional + boton; con la nota vacia atiende directo.
  const ovNoteL = mk('label', 'sos-ov-note', 'Nota (opcional)');
  const ovNote = mk('textarea'); ovNote.rows = 2; ovNote.maxLength = 500; ovNote.placeholder = 'Ej.: voy en camino. Enter atiende; Mayús+Enter agrega un renglón.';
  ovNoteL.append(ovNote);
  const ovErr = mk('p', 'sos-ov-err'); ovErr.setAttribute('role', 'alert');
  const ovAtend = mk('button', 'sos-ov-go', 'Atender'), ovLive = mk('button', 'sos-ov-b', 'Ver en vivo');
  const ovMute = mk('button', 'sos-ov-b', 'Silenciar sirena'), ovClose = mk('button', 'sos-ov-b', 'Ver el panel');
  for (const b of [ovAtend, ovLive, ovMute, ovClose]) b.type = 'button';
  const ovBtns = mk('div', 'sos-ov-btns'); ovBtns.append(ovAtend, ovLive, ovMute, ovClose);
  const ovPanelHint = mk('p', 'sos-ov-hint2', 'La sirena y el cartel siguen hasta que se atienda la alerta.');
  sosOv.append(ovT, ovWho, ovWhen, ovMore, ovHint, ovNoteL, ovErr, ovBtns, ovPanelHint);
  document.body.append(sosOv);
  let ovCur = null;   // id de la alerta que muestra el cartel (la nota escrita no pasa a otra alerta)
  // Mostrar/ocultar el cartel: el panel queda inerte detras, y al cerrar el foco vuelve a donde estaba.
  function setOverlay(show) {
    if (show === !sosOv.hidden) return;
    sosOv.hidden = !show;
    if (show) closeDlg();   // el cartel SOS manda: se cierran dialogos (foto, configuracion, confirmaciones)
    $('app').inert = show;
    if (show) { ovPrev = document.activeElement; (ovAtend.hidden ? ovClose : ovAtend).focus({ preventScroll: true }); }
    else {
      const p = ovPrev; ovPrev = null;
      if (p && p !== document.body && p.isConnected && typeof p.focus === 'function') p.focus({ preventScroll: true });
    }
    pumpSaveQueue();   // el cartel de guardado espera a que cierre el de SOS (y se oculta si aparece uno nuevo)
  }
  const closeOverlay = () => { overlayHidden = true; setOverlay(false); };
  sosOv.addEventListener('keydown', e => {   // trampa de foco: Tab no sale del cartel
    if (e.key !== 'Tab') return;
    const f = [ovNote, ovAtend, ovLive, ovMute, ovClose].filter(b => !b.disabled && !b.hidden && !(b.parentElement && b.parentElement.hidden));
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
  });
  // Escape NO descarta una alerta de nivel alto/critico (una tecla accidental no puede ocultar un SOS): solo "Ver el panel".
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sosOv.hidden) e.preventDefault(); });
  ovNote.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ovAtend.click(); } });
  ovAtend.addEventListener('click', () => {
    const top = topPending(); if (!top || ovAtend.disabled) return;
    attend(top, ovAtend, ovNote, ovErr);
  });
  ovLive.addEventListener('click', () => {
    const last = topPending(); closeOverlay();
    if (!last || !liveOk()) return;
    openLive(last.device_id, false);
  });
  ovMute.addEventListener('click', () => { sirenMuted = true; stopSiren(); ovMute.disabled = true; ovAtend.focus({ preventScroll: true }); });
  ovClose.addEventListener('click', closeOverlay);
  function alarmTick() {
    if (!sirenMuted) { ensureAudio(); pumpSiren(); }
    const n = pending.size;
    document.title = (titleFlip = !titleFlip) ? '🚨 ¡ALERTA! ' + nAlertas(n) + ' sin atender · Vigía' : '(' + n + ') Vigía · Casco Inteligente';
  }
  function syncAlarm() {
    autoRecSync();
    if (!pending.size || !loudCount()) {   // sin pendientes, o solo avisos de nivel medio: ni sirena ni cartel
      clearInterval(sirenT); sirenT = null; sirenMuted = false; overlayHidden = false;
      document.title = (pending.size ? '(' + pending.size + ') ' : '') + 'Vigía · Casco Inteligente';
      stopSiren(); setOverlay(false); ovMute.disabled = false; closeNotifs(); ovCur = null; return;
    }
    const last = topPending();   // la mas grave; a igual gravedad, la mas vieja
    if (ovCur !== last.id) { ovCur = last.id; ovNote.value = ''; ovErr.textContent = ''; }
    ovT.textContent = '¡' + alertLabel(last) + (isManDown(last) ? ' · HOMBRE CAÍDO' : '') + '!';
    ovWho.textContent = label(last.device_id);
    ovWhen.textContent = fmt(last.created_at);
    const other = pending.size - 1;
    ovMore.textContent = other > 0 ? (other === 1 ? 'Hay otra alerta más sin atender.' : 'Hay otras ' + other + ' alertas más sin atender.') : '';
    ovHint.hidden = audioOn();   // audio bloqueado: el cartel avisa que hay que tocar la pantalla
    setOverlay(!overlayHidden);
    if (!sirenT) { sirenT = setInterval(alarmTick, 1700); alarmTick(); } else pumpSiren();
  }
  // Tono corto y distinto (seno, 2 notas) para avisos de nivel medio: no es la sirena.
  function softBeep() {
    if (!audioOn()) return;
    const t0 = audioCtx.currentTime;
    [[660, 0], [880, 0.16]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.18, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.14);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + d); o.stop(t0 + d + 0.16);
    });
  }
  function alertSos(ev) {
    ensureAudio();
    if (ev && sevOf(ev) < SEV_LOUD) {   // nivel medio: aviso silencioso con badge + tono corto; no destapa el cartel ni reactiva la sirena
      softBeep();
      if (navigator.vibrate) navigator.vibrate(200);
      notifyAlert(ev);
      return;
    }
    sirenMuted = false; ovMute.disabled = false; overlayHidden = false;
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
    svQ.textContent = saveQ.length ? (saveQ.length === 1 ? 'Hay 1 video más en espera.' : 'Hay ' + saveQ.length + ' videos más en espera.') : '';
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
    micBtn.classList.toggle('hidden', !liveOk() || micPerm === 'granted' || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
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
    if (micAutoTried || !liveOk() || micPerm !== 'prompt' || $('app').classList.contains('hidden')) return;
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
      const ok = mk('button', danger ? 'danger' : '', yes); ok.type = 'button';
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
    a.push({ id: ev.id, created_at: ev.created_at, media_path: ev.media_path, cmd, hash: hashOf(ev.payload) });
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
    openDlg('Foto del casco ' + dev, [img, meta, acts, verifyBox({ path: p.media_path, hash: p.hash, id: p.id, dev, what: 'foto del casco ' + dev + ', ' + fmt(p.created_at) }), err]);
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
      const b = mk('button', 'danger', 'Eliminar seleccionadas (' + nSel + ')'); b.type = 'button';
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
    else if (a.error) note = ' (el archivo se borró pero no se pudo registrar: ' + errEs(a.error) + ')';
    const rec = { by: email, at, reason: why };
    logAccess('delete_media', it.path, { event_id: it.id, casco: it.dev });
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
    if (isAuditor()) return mk('span');   // solo lectura: sin comandos a pedido
    if (shared && cmdBars.has(id)) { const c = cmdBars.get(id); c.update(); return c.box; }
    const box = mk('div', 'cmdbar'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Comandos a pedido del casco ' + id);
    const mkb = (txt, k, aria) => { const b = mk('button', 'ghost', txt); b.type = 'button'; b.dataset.fk = id + '|' + k; b.setAttribute('aria-label', aria); return b; };
    const bPhoto = mkb('Sacar foto', 'photo', 'Sacar foto, casco ' + id);
    const bTorch = mkb('Linterna: encender', 'torch', 'Linterna: encender, casco ' + id);
    const bPing = mkb('Probar enlace', 'ping', 'Probar enlace, casco ' + id);
    const bFrame = mkb('Tomar cuadro del video', 'frame', 'Tomar cuadro del video, casco ' + id);
    bFrame.classList.add('hidden');
    const row = rowOf(bPhoto, bTorch, bPing, bFrame);
    if (isAdmin()) {   // configuracion y reinicio: solo admin (RLS lo exige tambien en el servidor)
      const bCfg = mkb('Configuración del casco', 'cfg', 'Configuración del casco ' + id);
      const bRst = mkb('Reiniciar agente', 'rst', 'Reiniciar agente, casco ' + id);
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
      bTorch.setAttribute('aria-label', bTorch.textContent + ', casco ' + id);
      fillThumbs(strip, id);
    } };
    v.update(); cmdViews.add(v);
    if (shared) cmdBars.set(id, v);
    return box;
  }
  const cmdBusy = (dev, actions) => [...CMD.items.values()].some(x => x.dev === dev && x.state === 'pending' && actions.includes(x.action));
  async function sendCmd(dev, action, params) {
    if (!DEV_RE.test(dev) || isAuditor()) return;
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
        else it.detail = 'no se pudo enviar (' + errEs(e) + ')';
      }
      cmdRefresh(dev); announce(cmdText(it));
      return;
    }
    CMD.avail = 'ok';
    logAccess(action === 'photo' ? 'photo' : 'command', dev, { action, via: 'orden' });
    if (action === 'photo') noteLocalPhoto(dev);
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
    if (r.error) { msg.textContent = ''; err.textContent = noPerm(r.error) ? 'Sin permiso para leer la configuración.' : 'No se pudo leer la configuración: ' + errEs(r.error); return; }
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
        err.textContent = noPerm(res.error) ? 'Sin permiso: solo un administrador puede cambiar la configuración.' : 'No se pudo guardar: ' + errEs(res.error);
        return;
      }
      logAccess('config_change', dev, { claves: Object.keys(p.cfg) });
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
    if (img) li.querySelectorAll(':scope > .media, :scope > .verify-row').forEach(n => n.remove());
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
      return noPerm(res.error) ? 'Sin permiso: solo un administrador puede archivar.' : 'El servidor no permitió archivar: ' + errEs(res.error);
    }
    const email = $('who').dataset.email || '', at = new Date().toISOString();
    ids.forEach(id => ARC.ids.set(id, { by: email, at, reason: reason || '' }));
    logAccess('archive', ids.length === 1 ? ids[0] : 'lote', { cantidad: ids.length, ids: ids.slice(0, 10) });
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
    if (res.error) return noPerm(res.error) ? 'Sin permiso: solo un administrador puede desarchivar.' : 'No se pudo desarchivar: ' + errEs(res.error);
    logAccess('archive', id, { desarchivar: true });
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
          setStat('No se pudo cargar: ' + (noPerm(e) ? 'sin permiso para ver estos datos' : errEs(e)) + '.', true);
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
      logAccess('export_pdf', o.csv, { pagina: st.page + 1 });
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
      } catch (e) { setStat('No se pudo exportar: ' + errEs(e) + '.', true); }
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
      host.className = ''; host.replaceChildren(mk('p', 'err', 'No se pudo cargar la guía de comandos. ' + errEs(e)), rowOf(rb, a2));
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
    logAccess('photo', dev, { via: 'cuadro' }); noteLocalPhoto(dev);
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

  // ======================================================================
  // Tanda C (docs/PROTOCOLO-ASISTENCIA.md, migracion 013): asistencia remota registrada, constancias de EPP y capacitacion,
  // auditoria de accesos, huella SHA-256 de fotos/videos y rol auditor. Tablas: assist_sessions, epp_deliveries,
  // training_records, training_attendees(_audit), access_log, org_settings; rpc log_access y create_training.
  // Mientras el servidor no tenga la migracion: aviso claro "Falta aplicar la migracion 013" y nada se rompe.
  // ======================================================================
  const MIG_TXT = 'Falta aplicar la migración 013 en el servidor: esta sección todavía no está disponible.';
  let MY_ID = '';
  function isAuditor() { return ROLE === 'auditor'; }
  function canWrite() { return ROLE === 'admin' || ROLE === 'viewer'; }
  function roleName() { return ROLE === 'admin' ? 'admin' : ROLE === 'auditor' ? 'auditor' : 'supervisor'; }
  function liveOk() { return OWN_LIVE && ROLE !== 'auditor'; }   // el auditor no ve video ni manda ordenes
  const ymdAR = s => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '');
  const nowLocalAR = () => {
    const p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  };
  const localToIso = v => new Date(v + ':00-03:00').toISOString();   // Argentina = UTC-3 fijo
  const isoToLocalAR = iso => { const t = fmtAR(iso); return t ? t.slice(6, 10) + '-' + t.slice(3, 5) + '-' + t.slice(0, 2) + 'T' + t.slice(11) : ''; };
  const tryQ = async fn => { try { return await fn(); } catch (e) { return asRes(e); } };
  const missingBox = () => { const d = mk('p', 'state bad migration', MIG_TXT); d.setAttribute('role', 'status'); return d; };
  const errLine = (e, what) => { const d = mk('p', 'state bad', (what || 'No se pudo leer') + ': ' + (noPerm(e) ? NO_PERM_TXT.toLowerCase() : errEs(e)) + '.'); d.setAttribute('role', 'status'); return d; };

  // Tabla de datos (caption para lectores, columnas con scope). rows: [{ cells: [texto | nodo | {t, cls}], cls }]
  function dataTable(caption, heads, rows, emptyTxt) {
    const wrap = mk('div', 'tablewrap'), t = mk('table', 'qtable');
    t.append(mk('caption', 'sr-only', caption));
    const hd = mk('thead'), hr = mk('tr');
    heads.forEach(h => { const o = typeof h === 'object'; const th = mk('th', o ? h.cls : '', o ? h.t : h); th.scope = 'col'; hr.append(th); });
    hd.append(hr);
    const tb = mk('tbody');
    for (const r of rows) {
      const tr = mk('tr', r.cls || '');
      for (const c of r.cells) {
        const o = c && typeof c === 'object' && !(c instanceof Node) ? c : null;
        const td = mk('td', o ? o.cls || '' : '');
        if (c instanceof Node) td.append(c); else { const v = o ? o.t : c; td.textContent = v == null || v === '' ? '—' : String(v); }
        tr.append(td);
      }
      tb.append(tr);
    }
    if (!rows.length) { const tr = mk('tr'), td = mk('td', 'empty mute', emptyTxt || 'Sin registros para estos filtros.'); td.colSpan = heads.length; tr.append(td); tb.append(tr); }
    t.append(hd, tb); wrap.append(t);
    return wrap;
  }
  const kpiBox = items => {
    const k = mk('section', 'kpis'); k.setAttribute('aria-label', 'Resumen');
    for (const [l, n, sub] of items) { const d = mk('div', 'kpi'); d.append(mk('span', 'kl', l), mk('strong', 'kn', n), mk('span', 'mute', sub)); k.append(d); }
    return k;
  };
  const dateIn = (v, max) => inp('date', v, max ? { max } : {});
  const roHint = msg => mk('p', 'mute rolenote noprint', msg);

  // ---- Auditoria: log_access (silencioso, no bloquea, 1 reintento) ----
  const LOGACC = { off: false };
  function logAccess(action, target, detail) {
    if (LOGACC.off) return;
    let d = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
    try { if (JSON.stringify(d).length > 900) d = { truncado: true }; } catch (_) { d = {}; }
    const args = { action, target: target == null ? null : String(target).slice(0, 120), detail: d };
    (async () => {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await sb.rpc('log_access', args);
          if (!r.error) return;
          if (r.status === 404 || tableMissing(r)) { LOGACC.off = true; return; }   // sin migracion: no insiste
          if (isAuthErr(r.error) || noPerm(r.error)) return;
        } catch (_) {}
        if (i === 0) await sleep(1200);
      }
    })();
  }

  // ---- Huella SHA-256 de fotos y videos (docs seccion 7) ----
  const HEX64 = /^[0-9a-f]{64}$/;
  const VERIFY_MAX = 300 * 1048576;
  function hashOf(payload) {   // -> { sha, size, alg, at } | null
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p || typeof p.sha256 !== 'string') return null;
    return { sha: p.sha256.trim().toLowerCase(), size: numOf(p.size), alg: typeof p.hash_alg === 'string' ? p.hash_alg : 'sha256', at: typeof p.captured_at === 'string' ? p.captured_at : '' };
  }
  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function verifyMedia(m) {   // -> { state: 'ok' | 'bad' | 'none' | 'error', text }
    if (!m.hash || !HEX64.test(m.hash.sha)) return { state: 'none', text: 'Sin huella registrada: el casco no la mandó para este archivo (puede ser anterior a esta función).' };
    if (String(m.hash.alg).toLowerCase().replace('-', '') !== 'sha256') return { state: 'none', text: 'El casco usó un algoritmo de huella que el visor no verifica (' + String(m.hash.alg).slice(0, 20) + ').' };
    if (!(window.crypto && crypto.subtle)) return { state: 'error', text: 'Este navegador no puede calcular la huella: abrí el visor por HTTPS.' };
    const u = await signed(m.path);
    if (!u) return { state: 'error', text: 'No se pudo obtener el archivo para verificarlo (enlace no disponible o sin permiso).' };
    let buf;
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const len = Number(r.headers.get('content-length'));
      if (len > VERIFY_MAX) return { state: 'error', text: 'El archivo es demasiado grande para verificarlo en el navegador (' + mb(len) + ').' };
      buf = await r.arrayBuffer();
    } catch (e) { return { state: 'error', text: 'No se pudo descargar el archivo para verificarlo: ' + errEs(e) }; }
    if (buf.byteLength > VERIFY_MAX) return { state: 'error', text: 'El archivo es demasiado grande para verificarlo en el navegador (' + mb(buf.byteLength) + ').' };
    const got = toHex(await crypto.subtle.digest('SHA-256', buf));
    return got === m.hash.sha
      ? { state: 'ok', text: 'Íntegro: el archivo coincide con la huella SHA-256 que registró el casco (' + got.slice(0, 12) + '…).' }
      : { state: 'bad', text: 'No coincide: este archivo no es el que registró el casco (calculado ' + got.slice(0, 12) + '… y registrado ' + m.hash.sha.slice(0, 12) + '…).' };
  }
  function verifyBox(m) {
    const box = mk('div', 'row verify-row');
    const b = mk('button', 'ghost', 'Verificar integridad'); b.type = 'button';
    b.setAttribute('aria-label', 'Verificar integridad, ' + m.what);
    const st = mk('span', 'verify-st'); st.setAttribute('role', 'status');
    box.append(b, st);
    b.addEventListener('click', async () => {
      b.disabled = true; st.className = 'verify-st mute'; st.textContent = 'Verificando…';
      let r;
      try { r = await verifyMedia(m); } catch (e) { r = { state: 'error', text: 'No se pudo verificar: ' + errEs(e) }; }
      b.disabled = false;
      st.className = 'verify-st ' + (r.state === 'ok' ? 'ok' : r.state === 'none' ? 'mute' : 'bad');
      st.textContent = r.text;
      logAccess('hash_verify', m.path, { event_id: m.id, casco: m.dev, resultado: r.state });
    });
    return box;
  }

  // ---- Datos del empleador (org_settings): encabezado de lo que se imprime ----
  const ORG_COLS = 'legal_name,cuit,address,responsible_name,responsible_role,contact';
  const CN = { sub: 'epp', avail: { epp: 'unknown', trn: 'unknown', org: 'unknown' }, org: null, orgP: null, orgErr: null,
    epp: [], trn: [], att: new Map(), attErr: null, err: {}, loaded: { epp: false, trn: false }, busy: {}, trunc: {}, f: { from: '', to: '', per: '' } };
  function loadOrg(force) {
    if (CN.orgP && !force) return CN.orgP;
    const p = (async () => {
      const r = await tryQ(() => sb.from('org_settings').select(ORG_COLS).eq('id', 1).maybeSingle());
      if (tableMissing(r)) { CN.avail.org = 'missing'; return null; }
      if (r.error) { CN.avail.org = 'error'; CN.orgErr = r.error; if (CN.orgP === p) CN.orgP = null; return null; }
      CN.avail.org = 'ok'; CN.orgErr = null; CN.org = r.data || null;
      return CN.org;
    })();
    CN.orgP = p;
    return p;
  }
  async function printPanel(hostId, title, desc) {
    const host = $(hostId);
    let org = null;
    try { org = await loadOrg(); } catch (_) {}
    const l2 = org ? [org.cuit ? 'CUIT ' + org.cuit : '', org.address || '', org.responsible_name ? 'Responsable: ' + org.responsible_name + (org.responsible_role ? ' (' + org.responsible_role + ')' : '') : '',
      org.contact ? 'Contacto: ' + org.contact : ''].filter(Boolean).join(' · ') : '';
    host.replaceChildren(
      mk('p', 'emp-name', org && org.legal_name ? org.legal_name : 'Empleador: datos sin cargar (Constancias > Empleador)'),
      ...(l2 ? [mk('p', 'emp-data', l2)] : []),
      mk('p', 'emp-doc', title + (desc ? ' · ' + desc : '')),
      mk('p', 'emp-gen', 'Generado el ' + fmtAR(new Date().toISOString()) + ' (hora de Argentina) por ' + ($('who').dataset.email || '—') + '.'));
    logAccess('export_pdf', title, {});
    window.print();
  }
  // Imprime una sola fila (constancia individual): las demas se ocultan solo para la impresion.
  function printRow(tr, hostId, title, desc) {
    const others = [...tr.parentElement.children].filter(x => x !== tr);
    others.forEach(x => x.classList.add('noprint'));
    const undo = () => others.forEach(x => x.classList.remove('noprint'));
    window.addEventListener('afterprint', undo, { once: true });
    printPanel(hostId, title, desc).finally(() => setTimeout(undo, 1500));
  }

  // ======================================================================
  // Asistencia remota (assist_sessions)
  // ======================================================================
  const ASSIST_COLS = 'id,device_id,started_at,ended_at,topic,outcome,note,photos,opened_by,opened_by_email,closed_by_email';
  const ASSIST_MAX = 500;
  const OUTCOME_LBL = { resuelto: 'Resuelto', derivado: 'Derivado', sin_resolver: 'Sin resolver' };
  const AS = { avail: 'unknown', open: new Map(), rows: [], trunc: false, f: { from: '', to: '', dev: '' }, loaded: false, busy: false, again: false, err: null,
    drafts: new Map(), minis: new Map(), opening: new Set(), autoIds: new Set(), autoErr: new Map(), localPh: new Map(), ch: null, ready: null, sig: '',
    startDraft: { dev: '', topic: '' } };
  let asReloadT = null;
  const durS = s => (s.ended_at ? Math.max(0, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000)) : null);
  function personAt(dev, iso) {   // quien tenia el casco en ese momento (asignaciones cargadas)
    const t = new Date(iso).getTime();
    const a = EQ.assigns.find(x => x.device_id === dev && new Date(x.starts_at).getTime() <= t && (x.ends_at == null || new Date(x.ends_at).getTime() > t));
    const p = a && EQ.people.find(x => x.id === a.person_id);
    return p ? p.full_name : '';
  }
  function noteLocalPhoto(dev) { const s = AS.open.get(dev); if (s) AS.localPh.set(s.id, (AS.localPh.get(s.id) || 0) + 1); }
  async function countPhotos(s) {
    let n = AS.localPh.get(s.id) || 0;
    try {
      const r = await sb.from('events').select('id', { count: 'exact', head: true }).eq('device_id', s.device_id).eq('type', 'photo').gte('created_at', s.started_at);
      if (!r.error && typeof r.count === 'number') n = Math.max(n, r.count);
    } catch (_) {}
    return Math.min(n, 1000);
  }
  function syncAsisBadge() {
    const n = AS.open.size, b = $('navAsis');
    b.textContent = String(n); b.classList.toggle('hidden', !n);
    if (n) $('tabAsis').setAttribute('aria-label', 'Asistencia, ' + (n === 1 ? '1 sesión abierta' : n + ' sesiones abiertas')); else $('tabAsis').removeAttribute('aria-label');
  }
  function asisRefresh() {
    syncAsisBadge();
    for (const v of AS.minis.values()) v.update();
    renderAsis();
  }
  async function loadAssistOpen() {
    const r = await tryQ(() => sb.from('assist_sessions').select(ASSIST_COLS).is('ended_at', null).order('started_at', { ascending: false }).limit(100));
    if (tableMissing(r)) { AS.avail = 'missing'; AS.open = new Map(); asisRefresh(); return; }
    if (r.error || !Array.isArray(r.data)) { if (isAuthErr(r.error)) sessionExpired(); AS.err = r.error || new Error('sin datos'); asisRefresh(); return; }
    AS.avail = 'ok'; AS.err = null;
    const m = new Map();
    for (const s of r.data) if (!m.has(s.device_id)) m.set(s.device_id, s);   // la mas reciente por casco
    AS.open = m;
    ensureAssistChannel();
    asisRefresh();
  }
  async function loadAssistRange() {
    if (AS.avail === 'missing') return;
    if (AS.busy) { AS.again = true; return; }
    AS.busy = true;
    const f = AS.f.from || today(), t = AS.f.to || today();
    let q = sb.from('assist_sessions').select(ASSIST_COLS).gte('started_at', dayStartISO(f)).lt('started_at', dayStartISO(t, 1));
    if (AS.f.dev) q = q.eq('device_id', AS.f.dev);
    const r = await tryQ(() => q.order('started_at', { ascending: false }).limit(ASSIST_MAX + 1));
    AS.busy = false;
    if (tableMissing(r)) AS.avail = 'missing';
    else if (r.error || !Array.isArray(r.data)) { if (isAuthErr(r.error)) sessionExpired(); AS.err = r.error || new Error('sin datos'); }
    else { AS.err = null; AS.avail = 'ok'; AS.trunc = r.data.length > ASSIST_MAX; AS.rows = r.data.slice(0, ASSIST_MAX); AS.loaded = true; }
    asisRefresh();
    if (AS.again) { AS.again = false; loadAssistRange(); }
  }
  const reloadAssistSoon = () => { clearTimeout(asReloadT); asReloadT = setTimeout(() => { loadAssistOpen(); if (AS.loaded) loadAssistRange(); }, 400); };
  function ensureAssistChannel() {
    if (AS.ch || AS.avail !== 'ok') return;
    AS.ch = sb.channel('assist-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assist_sessions' }, reloadAssistSoon)
      .subscribe(resubscribed(reloadAssistSoon));
  }
  const rateOrPerm = (e, what) => e && e.code === '54000' ? 'Demasiadas sesiones en poco tiempo (máximo 20 por minuto). Esperá unos segundos.'
    : noPerm(e) ? 'Tu rol no puede ' + what + '.' : 'No se pudo ' + what + ': ' + errEs(e);
  async function assistOpen(devId, topic, auto) {   // -> { row } | { error }
    if (!canWrite()) return { error: 'Tu rol es de solo lectura: no puede registrar asistencias.' };
    if (!DEV_RE.test(devId)) return { error: 'Elegí un casco.' };
    if (AS.avail === 'missing') return { error: MIG_TXT };
    if (AS.open.has(devId)) return { row: AS.open.get(devId) };
    if (AS.opening.has(devId)) return { error: '' };
    AS.opening.add(devId); AS.autoErr.delete(devId);
    const body = { device_id: devId }; if (topic) body.topic = topic;
    const r = await tryQ(() => sb.from('assist_sessions').insert(body).select(ASSIST_COLS).single());
    AS.opening.delete(devId);
    if (tableMissing(r)) { AS.avail = 'missing'; asisRefresh(); return { error: MIG_TXT }; }
    if (r.error || !r.data) {
      if (isAuthErr(r.error)) sessionExpired();
      const msg = isAuthErr(r.error) ? 'Sesión vencida: ingresá de nuevo.' : rateOrPerm(r.error, 'registrar la sesión de asistencia');
      if (auto) AS.autoErr.set(devId, msg);
      asisRefresh();
      return { error: msg };
    }
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    AS.avail = 'ok'; AS.open.set(devId, row);
    if (auto) AS.autoIds.add(row.id);
    logAccess('assist_open', devId, { id: row.id, auto: !!auto, tema: topic || null });
    announce('Se abrió una sesión de asistencia con ' + label(devId) + '.');
    ensureAssistChannel();
    if (AS.loaded) loadAssistRange();
    asisRefresh();
    return { row };
  }
  // Al tocar "Iniciar" o "Hablar" sin sesion abierta: se abre sola (cfg.ASSIST_AUTO === false la apaga). No frena el video ni la llamada.
  function asistAuto(devId) {
    if (cfg.ASSIST_AUTO === false || !canWrite() || !DEV_RE.test(devId) || AS.avail === 'missing') return;
    Promise.resolve(AS.ready).then(() => {
      if (AS.open.has(devId) || AS.opening.has(devId)) return;
      assistOpen(devId, '', true);
    }).catch(() => {});
  }
  async function assistClose(s, v) {   // -> '' si salio bien, o el mensaje de error
    const r = await tryQ(() => sb.from('assist_sessions')
      .update({ ended_at: new Date().toISOString(), outcome: v.outcome, note: v.note || null, photos: v.photos })
      .eq('id', s.id).is('ended_at', null).select(ASSIST_COLS).maybeSingle());
    if (tableMissing(r)) { AS.avail = 'missing'; asisRefresh(); return MIG_TXT; }
    if (r.error) {
      if (isAuthErr(r.error)) { sessionExpired(); return 'Sesión vencida: ingresá de nuevo y cerrá la sesión.'; }
      if (noPerm(r.error)) return 'Solo quien abrió la sesión o un administrador puede cerrarla.';
      return 'No se pudo cerrar la sesión: ' + errEs(r.error);
    }
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row) return 'No se pudo cerrar: la sesión ya estaba cerrada o solo la puede cerrar quien la abrió o un administrador.';
    if (AS.open.get(row.device_id) && AS.open.get(row.device_id).id === row.id) AS.open.delete(row.device_id);
    AS.drafts.delete(s.id); AS.autoIds.delete(s.id); AS.localPh.delete(s.id);
    const i = AS.rows.findIndex(x => x.id === row.id);
    if (i >= 0) AS.rows[i] = row;
    logAccess('assist_close', row.device_id, { id: row.id, resultado: row.outcome, dur_s: durS(row), fotos: row.photos });
    announce('Sesión de asistencia con ' + label(row.device_id) + ' cerrada: ' + (OUTCOME_LBL[row.outcome] || '').toLowerCase() + '.');
    if (AS.loaded) loadAssistRange();
    asisRefresh();
    return '';
  }
  // Formulario de cierre (resultado + nota + fotos). Los borradores sobreviven a los repintados por Realtime.
  function closeForm(s, where) {
    if (!(s.opened_by === MY_ID || isAdmin())) {
      return mk('p', 'mute', 'La abrió ' + (s.opened_by_email || 'otra persona') + ': la cierra esa persona o un administrador.');
    }
    const dr = AS.drafts.get(s.id) || {}; AS.drafts.set(s.id, dr);
    const f = mk('form', 'assist-close noprint'); f.noValidate = true;
    const out = sel([['', 'Elegí el resultado…'], ['resuelto', 'Resuelto'], ['derivado', 'Derivado'], ['sin_resolver', 'Sin resolver']], dr.outcome || '');
    const note = inp('text', dr.note || '', { maxLength: 1000, autocomplete: 'off', placeholder: 'Qué se hizo o qué quedó pendiente' });
    const ph = inp('number', dr.photos != null ? dr.photos : '', { min: 0, max: 1000, inputMode: 'numeric' });
    out.addEventListener('change', () => { dr.outcome = out.value; });
    note.addEventListener('input', () => { dr.note = note.value; });
    ph.addEventListener('input', () => { dr.photos = ph.value; });
    if (dr.photos == null) countPhotos(s).then(n => { if (dr.photos == null && ph.isConnected !== false && !ph.value) ph.value = String(n); });
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const go = mk('button', '', 'Cerrar sesión'); go.type = 'submit';
    go.setAttribute('aria-label', 'Cerrar sesión de asistencia, casco ' + s.device_id);
    const tag = ' (casco ' + s.device_id + ')';
    const g = mk('div', 'grid2'); g.append(fld('Resultado' + tag, out), fld('Fotos tomadas' + tag, ph));
    f.append(g, fld('Nota (opcional)' + tag, note), rowOf(go), err);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      if (!out.value) { err.textContent = 'Elegí el resultado de la asistencia.'; out.focus(); return; }
      const raw = String(ph.value).trim(), n = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 1000) { err.textContent = 'Las fotos tienen que ser un número entero de 0 a 1000.'; ph.focus(); return; }
      go.disabled = true;
      const m = await assistClose(s, { outcome: out.value, note: note.value.trim().replace(/\s+/g, ' '), photos: n });
      go.disabled = false;
      if (m) { err.textContent = m; return; }
      requestAnimationFrame(() => {   // el formulario se reemplazo: el foco va al boton del mini-cartel o al titulo de la pestaña
        const mv = AS.minis.get(s.device_id), t = where === 'mini' ? mv && mv.box.querySelector('button') : $('asisH');
        if (t) { if (t.tagName !== 'BUTTON') t.tabIndex = -1; t.focus({ preventScroll: true }); }
      });
    });
    return f;
  }
  // Mini-cartel dentro de cada panel de video: estado de la sesion + cierre con resultado y nota.
  function asistMini(devId) {
    const box = mk('div', 'assist-mini noprint');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Sesión de asistencia del casco ' + devId);
    const v = { id: devId, box, sid: '', err: null, update() {
      const s = AS.open.get(devId);
      const hide = !canWrite() || AS.avail === 'missing';
      box.classList.toggle('hidden', hide);
      if (hide) return;
      if (!s) {
        if (v.sid !== '-') {
          v.sid = '-';
          const b = mk('button', 'ghost', 'Registrar asistencia'); b.type = 'button';
          b.setAttribute('aria-label', 'Registrar asistencia, casco ' + devId + ': abre una sesión de asistencia remota');
          b.addEventListener('click', async () => { b.disabled = true; await assistOpen(devId, '', false); b.disabled = false; });
          v.err = mk('span', 'err'); v.err.setAttribute('role', 'alert');
          box.replaceChildren(rowOf(b, v.err));
        }
        v.err.textContent = AS.autoErr.get(devId) || '';
        return;
      }
      if (v.sid !== s.id) {
        v.sid = s.id;
        const head = mk('p', 'assist-st');
        head.append(mk('strong', '', 'Asistencia en curso'), mk('span', 'mute', ' · desde ' + fmtAR(s.started_at) + (s.topic ? ' · ' + s.topic : '')));
        const kids = [head];
        if (AS.autoIds.has(s.id)) kids.push(mk('p', 'mute', 'Se abrió sola al tocar Iniciar o Hablar. Cerrala con el resultado cuando termines (también desde la pestaña Asistencia).'));
        kids.push(closeForm(s, 'mini'));
        box.replaceChildren(...kids);
      }
    } };
    AS.minis.set(devId, v);
    v.update();
    return box;
  }

  function asisCsvRows() {
    return AS.rows.map(s => [fmtAR(s.started_at), s.ended_at ? fmtAR(s.ended_at) : '', s.device_id, personAt(s.device_id, s.started_at), s.topic || '',
      s.ended_at ? (OUTCOME_LBL[s.outcome] || '') : 'Abierta', durS(s) != null ? durS(s) : '', s.photos, s.opened_by_email || '', s.closed_by_email || '', s.note || '', s.id]);
  }
  const ASIS_HEAD = ['inicio', 'fin', 'casco', 'persona', 'tema', 'resultado', 'duracion_seg', 'fotos', 'abierta_por', 'cerrada_por', 'nota', 'id_sesion'];
  function asisDesc() {
    return 'Desde ' + ymdAR(AS.f.from || today()) + ' hasta ' + ymdAR(AS.f.to || today()) + ' · casco: ' + (AS.f.dev ? label(AS.f.dev) : 'todos');
  }
  function renderAsis() {
    const host = $('asisHost');
    if (!host || $('panelAsis').classList.contains('hidden')) return;
    const sig = JSON.stringify([AS.avail, !!AS.err, AS.loaded, AS.trunc, AS.rows.map(r => [r.id, r.ended_at, r.outcome, r.photos]), [...AS.open.values()].map(s => s.id),
      AS.f, ROLE, knownDevices().join(','), [...personOf].join(',')]);
    if (sig === AS.sig && host.firstChild) return;
    AS.sig = sig;
    if (AS.avail === 'missing') { host.replaceChildren(missingBox()); return; }
    if (AS.avail === 'unknown' && !AS.err) { host.replaceChildren(mk('p', 'mute', 'Cargando sesiones…')); return; }
    const kids = [];
    if (AS.err) kids.push(errLine(AS.err, 'No se pudieron leer las sesiones de asistencia (se reintenta solo)'));
    const devs = knownDevices();
    // 1) iniciar una sesion a mano
    if (canWrite()) {
      const f = mk('form', 'qform noprint'); f.noValidate = true;
      const dv = sel([['', '(elegí un casco)'], ...devs.map(i => [i, label(i)])], AS.startDraft.dev);
      const tp = inp('text', AS.startDraft.topic, { maxLength: 200, autocomplete: 'off', placeholder: 'Ej.: calibrar el equipo, revisar la bomba' });
      dv.addEventListener('change', () => { AS.startDraft.dev = dv.value; });
      tp.addEventListener('input', () => { AS.startDraft.topic = tp.value; });
      const go = mk('button', '', 'Iniciar sesión'); go.type = 'submit';
      const err = mk('div', 'err'); err.setAttribute('role', 'alert');
      const g = mk('div', 'grid2 qgrid'); g.append(fld('Casco', dv), fld('Tema (opcional, hasta 200 caracteres)', tp));
      f.append(mk('h3', '', 'Iniciar una sesión de asistencia'), g, rowOf(go), err,
        mk('p', 'mute', 'También se abre sola al tocar Iniciar o Hablar en el video de un casco, si no hay una sesión abierta con ese casco.'));
      f.addEventListener('submit', async e => {
        e.preventDefault(); err.textContent = '';
        if (!dv.value) { err.textContent = 'Elegí un casco.'; dv.focus(); return; }
        if (AS.open.has(dv.value)) { err.textContent = 'Ya hay una sesión abierta con ese casco: cerrala primero.'; return; }
        go.disabled = true;
        const r = await assistOpen(dv.value, tp.value.trim().replace(/\s+/g, ' '), false);
        go.disabled = false;
        if (r.error) { err.textContent = r.error; return; }
        AS.startDraft = { dev: '', topic: '' };
      });
      kids.push(f);
    } else kids.push(roHint('Tu rol (auditor) es de solo lectura: podés ver, exportar e imprimir las sesiones, pero no abrirlas ni cerrarlas.'));
    // 2) abiertas
    const open = [...AS.open.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
    const hOpen = mk('h3', '', 'Sesiones abiertas (' + open.length + ')');
    kids.push(hOpen);
    if (!open.length) kids.push(mk('p', 'mute', 'No hay sesiones abiertas.'));
    else {
      const ul = mk('ul');
      for (const s of open) {
        const li = mk('li', 'bcitem');
        const h = mk('div', 'row');
        h.append(dlEl('strong', s.device_id, ''), mk('span', 'tag warn', 'ABIERTA'), mk('span', 'mute', 'desde ' + fmtAR(s.started_at) + ' · ' + ago(Date.now() - new Date(s.started_at).getTime())));
        li.append(h, mk('div', 'mute', (s.topic ? 'Tema: ' + s.topic + ' · ' : '') + 'abrió ' + (s.opened_by_email || '—')));
        if (canWrite()) li.append(closeForm(s, 'tab'));
        ul.append(li);
      }
      kids.push(ul);
    }
    // 3) resumen + filtros + tabla
    const done = AS.rows.filter(r => r.ended_at), durs = done.map(durS);
    const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const res = done.filter(r => r.outcome === 'resuelto').length;
    kids.push(mk('h3', '', 'Sesiones del período'));
    const ff = mk('form', 'qform noprint'); ff.noValidate = true;
    const inFrom = dateIn(AS.f.from || today()), inTo = dateIn(AS.f.to || today());
    const sDev = sel([['', 'Todos los cascos'], ...devs.map(i => [i, label(i)])], AS.f.dev);
    const bGo = mk('button', '', 'Buscar'); bGo.type = 'submit';
    const bCsv = mk('button', 'ghost', 'Exportar CSV'); bCsv.type = 'button';
    const bPr = mk('button', 'ghost', 'Imprimir / PDF'); bPr.type = 'button';
    bCsv.disabled = bPr.disabled = !AS.rows.length;
    const fg = mk('div', 'grid2 qgrid'); fg.append(fld('Desde', inFrom), fld('Hasta', inTo), fld('Casco', sDev));
    const ferr = mk('div', 'err'); ferr.setAttribute('role', 'alert');
    ff.append(fg, rowOf(bGo, bCsv, bPr), ferr);
    ff.addEventListener('submit', e => {
      e.preventDefault(); ferr.textContent = '';
      if (inFrom.value && inTo.value && inFrom.value > inTo.value) { ferr.textContent = 'La fecha Desde es posterior a Hasta.'; return; }
      AS.f = { from: inFrom.value, to: inTo.value, dev: sDev.value };
      loadAssistRange();
    });
    bCsv.addEventListener('click', () => csvDownload('asistencia_' + today() + '.csv', ASIS_HEAD, asisCsvRows()));
    bPr.addEventListener('click', () => printPanel('asisPrint', 'Sesiones de asistencia remota', asisDesc()));
    kids.push(ff);
    kids.push(kpiBox([
      ['Sesiones', String(AS.rows.length), open.length ? open.length + ' abiertas' : 'en el período'],
      ['Duración media', avg == null ? '—' : elapsed(avg), done.length + ' cerradas'],
      ['Resueltas', done.length ? Math.round(res * 100 / done.length) + ' %' : '—', res + ' de ' + done.length + ' cerradas'],
    ]));
    kids.push(mk('p', 'print-only', asisDesc()));
    if (!AS.loaded) kids.push(mk('p', 'mute', 'Cargando…'));
    else {
      kids.push(dataTable('Sesiones de asistencia remota', ['Inicio', 'Casco', 'Persona', 'Tema', 'Duración', 'Resultado', 'Fotos', 'Abrió', 'Nota'],
        AS.rows.map(s => ({ cls: s.ended_at ? '' : 'pend', cells: [{ t: fmtAR(s.started_at), cls: 'mono' }, label(s.device_id), personAt(s.device_id, s.started_at), s.topic,
          s.ended_at ? { t: elapsed(durS(s)), cls: 'mono' } : { t: 'Abierta', cls: 'bad' }, s.ended_at ? OUTCOME_LBL[s.outcome] : '', String(s.photos), s.opened_by_email, s.note] })),
        'No hay sesiones en este período.'));
      if (AS.trunc) kids.push(mk('p', 'mute', 'Se muestran las primeras ' + ASSIST_MAX + ' sesiones: acotá las fechas para ver el resto.'));
    }
    host.replaceChildren(...kids);
  }
  function asisShow() {
    if (!AS.f.from) AS.f = { from: today(), to: today(), dev: AS.f.dev || '' };
    renderAsis();
    loadAssistOpen(); loadAssistRange();
  }

  // ======================================================================
  // Constancias: EPP (epp_deliveries) y capacitacion (training_records + training_attendees) + datos del empleador
  // ======================================================================
  const CONST_MAX = 500;
  const ACK_LBL = { conforme: 'Conforme', con_observaciones: 'Con observaciones', no_firma: 'No firma' };
  const PLACE_LBL = { presencial: 'Presencial', virtual: 'Virtual' }, SYNC_LBL = { sincronica: 'Sincrónica', asincronica: 'Asincrónica' };
  const EPP_COLS = 'id,person_id,device_id,item,quantity,model,brand,certified,cert_ref,delivered_at,worker_ack,observation,supersedes,created_by_email,created_at';
  const TRN_COLS = 'id,held_at,topic,trainer,modality_place,modality_sync,assisted,duration_min,supersedes,created_by_email,created_at';
  const pnameOf = (id, emb) => (emb && emb.full_name) || (EQ.people.find(p => p.id === id) || {}).full_name || 'persona ' + String(id || '').slice(0, 8);
  const cDbErr = (e, tabla) => {
    const c = String((e && e.code) || ''), m = String((e && e.message) || '');
    if (isAuthErr(e)) { sessionExpired(); return 'Sesión vencida: ingresá de nuevo.'; }
    if (c === '23505') return 'Ese registro ya fue corregido por otro posterior: actualizá la lista.';
    if (c === '54000' || /rate limit/i.test(m)) return 'Demasiados registros en poco tiempo. Esperá unos segundos y probá de nuevo.';
    if (noPerm(e)) return 'Tu rol no puede guardar constancias.';
    if (c === '22023') return m.replace(new RegExp('^' + (tabla || '\\w+') + ': '), '');
    return 'No se pudo guardar: ' + errEs(e);
  };
  async function loadEpp() {
    if (CN.busy.epp) return;
    CN.busy.epp = true;
    const from = CN.f.from || ymdAgo(90), to = CN.f.to || today();
    const emb = 'person:people(full_name,legajo,job_title,sector)';   // el DNI no es columna de people: viene de people_full (EQ.people, solo admin)
    const build = cols => {
      let q = sb.from('epp_deliveries').select(cols).gte('delivered_at', from).lte('delivered_at', to);
      if (CN.f.per) q = q.eq('person_id', CN.f.per);
      return q.order('delivered_at', { ascending: false }).order('created_at', { ascending: false }).limit(CONST_MAX + 1);
    };
    let r = await tryQ(() => build(EPP_COLS + ',' + emb));
    if (r.error && !tableMissing(r) && !noPerm(r.error) && !isAuthErr(r.error)) r = await tryQ(() => build(EPP_COLS));   // sin el cruce con personas
    CN.busy.epp = false;
    if (tableMissing(r)) CN.avail.epp = 'missing';
    else if (r.error || !Array.isArray(r.data)) { if (isAuthErr(r.error)) sessionExpired(); CN.err.epp = r.error || new Error('sin datos'); }
    else { CN.err.epp = null; CN.avail.epp = 'ok'; CN.trunc.epp = r.data.length > CONST_MAX; CN.epp = r.data.slice(0, CONST_MAX); CN.loaded.epp = true; }
    renderConst();
  }
  async function loadTrn() {
    if (CN.busy.trn) return;
    CN.busy.trn = true;
    const from = CN.f.from || ymdAgo(90), to = CN.f.to || today();
    const r = await tryQ(() => sb.from('training_records').select(TRN_COLS).gte('held_at', dayStartISO(from)).lt('held_at', dayStartISO(to, 1))
      .order('held_at', { ascending: false }).limit(CONST_MAX + 1));
    if (tableMissing(r)) { CN.avail.trn = 'missing'; CN.busy.trn = false; renderConst(); return; }
    if (r.error || !Array.isArray(r.data)) {
      if (isAuthErr(r.error)) sessionExpired();
      CN.err.trn = r.error || new Error('sin datos'); CN.busy.trn = false; renderConst(); return;
    }
    CN.err.trn = null; CN.avail.trn = 'ok';
    const recs = r.data.slice(0, CONST_MAX);
    // Asistentes: viewer/admin leen la tabla (con cruce a personas); el auditor lee la vista training_attendees_audit
    // (la persona viene vacia cuando dejo una observacion: identidad reservada).
    const att = new Map(); CN.attErr = null;
    const aud = isAuditor();
    for (let i = 0; i < recs.length; i += 40) {
      const ids = recs.slice(i, i + 40).map(x => x.id);
      const q = aud
        ? sb.from('training_attendees_audit').select('training_id,person_id,ack,observation').in('training_id', ids)
        : sb.from('training_attendees').select('training_id,person_id,ack,observation,person:people(full_name,legajo)').in('training_id', ids);
      let a = await tryQ(() => q);
      if (a.error && !aud && !tableMissing(a) && !noPerm(a.error) && !isAuthErr(a.error)) a = await tryQ(() => sb.from('training_attendees').select('training_id,person_id,ack,observation').in('training_id', ids));
      if (a.error || !Array.isArray(a.data)) { CN.attErr = a.error || new Error('sin datos'); break; }
      for (const x of a.data) { if (!att.has(x.training_id)) att.set(x.training_id, []); att.get(x.training_id).push(x); }
    }
    CN.att = att; CN.trunc.trn = r.data.length > CONST_MAX; CN.trn = recs; CN.loaded.trn = true; CN.busy.trn = false;
    renderConst();
  }
  function closeConstForm() { const h = $('constForm'); h.replaceChildren(); h.classList.add('hidden'); }
  function formCard(title, fields, spec, onSave) {
    const f = mk('form', 'card section noprint'); f.noValidate = true;
    const h = mk('h3', '', title); h.tabIndex = -1;
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const go = mk('button', '', 'Guardar constancia'); go.type = 'submit';
    const no = mk('button', 'ghost', 'Cancelar'); no.type = 'button';
    no.addEventListener('click', () => { closeConstForm(); const t = $('constBody').querySelector('button'); if (t) t.focus(); });
    f.append(h, ...fields, rowOf(go, no), err);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const r = collect(spec);
      if (r.errors.length) { err.textContent = r.errors.join(' '); return; }
      go.disabled = true;
      const msg = await onSave(r.v);
      go.disabled = false;
      if (msg) { err.textContent = msg; return; }
      closeConstForm();
    });
    $('constForm').replaceChildren(f); $('constForm').classList.remove('hidden');
    const first = f.querySelector('input:not([readonly]),select'); if (first) first.focus();
    return f;
  }
  const personOpts = () => [['', '(elegí una persona)'], ...EQ.people.filter(p => p.active !== false).map(p => [p.id, p.full_name + (p.legajo ? ' (' + p.legajo + ')' : '')])];
  function eppForm(pre) {
    if (!canWrite()) return;
    const po = personOpts();
    if (pre && !po.some(o => o[0] === pre.person_id)) po.push([pre.person_id, pnameOf(pre.person_id, pre.person)]);
    const per = sel(po, pre ? pre.person_id : '');
    if (pre) per.disabled = true;   // la correccion es de la misma persona (lo exige el servidor)
    const dev = sel([['', '(sin casco)'], ...EQ.devices.filter(d => d.status !== 'baja').map(d => [d.device_id, d.device_id + ' · ' + d.name])], pre && pre.device_id || '');
    const item = inp('text', pre ? pre.item : '', { maxLength: 120, autocomplete: 'off', placeholder: 'Ej.: casco de seguridad, guantes, botines' });
    const qty = inp('number', pre ? pre.quantity : 1, { min: 1, max: 999, inputMode: 'numeric' });
    const model = inp('text', pre && pre.model || '', { maxLength: 120, autocomplete: 'off' });
    const brand = inp('text', pre && pre.brand || '', { maxLength: 120, autocomplete: 'off' });
    const cert = sel([['', '(elegí)'], ['si', 'Sí, posee certificación'], ['no', 'No posee certificación']], pre ? (pre.certified ? 'si' : 'no') : '');
    const cref = inp('text', pre && pre.cert_ref || '', { maxLength: 200, autocomplete: 'off', placeholder: 'Norma, certificado o disposición' });
    const date = inp('date', pre ? pre.delivered_at : today(), { max: today() });
    const ack = sel([['', '(elegí)'], ['conforme', 'Conforme'], ['con_observaciones', 'Con observaciones'], ['no_firma', 'No firma']], pre ? pre.worker_ack : '');
    const obs = inp('text', pre && pre.observation || '', { maxLength: 500, autocomplete: 'off' });
    const spec = [
      { k: 'person_id', el: per, label: 'Trabajador', req: true },
      { k: 'device_id', el: dev, label: 'Casco' },
      { k: 'item', el: item, label: 'Producto', req: true, max: 120 },
      { k: 'quantity', el: qty, label: 'Cantidad', req: true, re: /^\d{1,3}$/, msg: 'número entero de 1 a 999.' },
      { k: 'model', el: model, label: 'Modelo o tipo', max: 120 },
      { k: 'brand', el: brand, label: 'Marca', max: 120 },
      { k: 'cert', el: cert, label: 'Certificación', req: true },
      { k: 'cert_ref', el: cref, label: 'Referencia de la certificación', max: 200 },
      { k: 'delivered_at', el: date, label: 'Fecha de entrega', req: true },
      { k: 'worker_ack', el: ack, label: 'Conformidad del trabajador', req: true },
      { k: 'observation', el: obs, label: 'Observación', max: 500 },
    ];
    const g1 = mk('div', 'grid2'); g1.append(fld('Trabajador', per), fld('Casco asignado (opcional)', dev));
    const g2 = mk('div', 'grid2'); g2.append(fld('Producto (EPP entregado)', item), fld('Cantidad', qty), fld('Modelo o tipo', model), fld('Marca', brand));
    const g3 = mk('div', 'grid2'); g3.append(fld('¿Posee certificación?', cert), fld('Referencia de la certificación (norma o certificado)', cref), fld('Fecha de entrega', date));
    const g4 = mk('div', 'grid2'); g4.append(fld('Conformidad del trabajador', ack), fld('Observación (obligatoria si hay observaciones)', obs));
    const note = mk('p', 'mute', pre ? 'Estás corrigiendo la entrega del ' + ymdAR(pre.delivered_at) + ' (' + pre.item + '). El registro anterior no se borra: queda marcado como reemplazado.'
      : 'La constancia queda guardada y no se puede modificar: si hay un error, se carga una corrección que reemplaza a la anterior.');
    formCard(pre ? 'Corregir constancia de entrega de EPP' : 'Nueva constancia de entrega de EPP', [note, g1, g2, g3, g4], spec, async v => {
      const q = Number(v.quantity);
      if (!Number.isInteger(q) || q < 1 || q > 999) return 'Cantidad: número entero de 1 a 999.';
      if (v.delivered_at > today()) return 'Fecha de entrega: no puede ser futura.';
      if (v.worker_ack === 'con_observaciones' && !v.observation) return 'Observación: es obligatoria cuando el trabajador firma con observaciones.';
      const row = { person_id: pre ? pre.person_id : v.person_id, item: v.item, quantity: q, certified: v.cert === 'si', delivered_at: v.delivered_at, worker_ack: v.worker_ack };
      if (v.device_id) row.device_id = v.device_id;
      if (v.model) row.model = v.model;
      if (v.brand) row.brand = v.brand;
      if (v.cert_ref) row.cert_ref = v.cert_ref;
      if (v.observation) row.observation = v.observation;
      if (pre) row.supersedes = pre.id;
      const r = await tryQ(() => sb.from('epp_deliveries').insert(row).select('id').single());
      if (tableMissing(r)) { CN.avail.epp = 'missing'; renderConst(); return MIG_TXT; }
      if (r.error) return cDbErr(r.error, 'epp_deliveries');
      const id = (Array.isArray(r.data) ? r.data[0] : r.data || {}).id || '';
      logAccess('epp_create', id, { persona: row.person_id, producto: row.item, correccion: !!pre });
      announce('Constancia de entrega de EPP guardada.');
      loadEpp();
      return '';
    });
  }
  function trnForm(pre) {
    if (!canWrite()) return;
    const peo = EQ.people.filter(p => p.active !== false);
    const held = inp('datetime-local', pre ? isoToLocalAR(pre.held_at) : nowLocalAR(), { max: nowLocalAR() });
    const topic = inp('text', pre ? pre.topic : '', { maxLength: 200, autocomplete: 'off', placeholder: 'Ej.: trabajo en altura, uso de extintores' });
    const trainer = inp('text', pre ? pre.trainer : '', { maxLength: 120, autocomplete: 'off' });
    const place = sel([['', '(elegí)'], ['presencial', 'Presencial'], ['virtual', 'Virtual']], pre && pre.modality_place || '');
    const sync = sel([['', '(elegí)'], ['sincronica', 'Sincrónica'], ['asincronica', 'Asincrónica']], pre && pre.modality_sync || '');
    const assisted = sel([['', '(elegí)'], ['si', 'Sí'], ['no', 'No']], pre ? (pre.assisted ? 'si' : 'no') : '');
    const dur = inp('number', pre && pre.duration_min || '', { min: 1, max: 1440, inputMode: 'numeric', placeholder: 'minutos' });
    const spec = [
      { k: 'held_at', el: held, label: 'Fecha y hora', req: true },
      { k: 'topic', el: topic, label: 'Tema', req: true, max: 200 },
      { k: 'trainer', el: trainer, label: 'Capacitador', req: true, max: 120 },
      { k: 'place', el: place, label: 'Modalidad (lugar)', req: true },
      { k: 'sync', el: sync, label: 'Modalidad (sincronía)', req: true },
      { k: 'assisted', el: assisted, label: 'Capacitación asistida', req: true },
      { k: 'dur', el: dur, label: 'Duración', re: /^\d{1,4}$/, msg: 'minutos, número entero de 1 a 1440.' },
    ];
    const g1 = mk('div', 'grid2'); g1.append(fld('Fecha y hora (hora de Argentina)', held), fld('Tema', topic), fld('Capacitador', trainer), fld('Duración en minutos (opcional)', dur));
    const g2 = mk('div', 'grid2'); g2.append(fld('Modalidad: lugar', place), fld('Modalidad: sincronía', sync), fld('¿Fue asistida por un capacitador?', assisted));
    const prev = new Map((pre ? CN.att.get(pre.id) || [] : []).map(a => [a.person_id, a]));
    const fs = mk('fieldset', 'att-set');
    fs.append(mk('legend', '', 'Asistentes (de 1 a 200)'));
    const rows = peo.map(p => {
      const row = mk('div', 'att-row');
      const lab = mk('label', 'chk'), cb = inp('checkbox'); cb.checked = prev.has(p.id);
      lab.append(cb, p.full_name + (p.legajo ? ' · ' + p.legajo : ''));
      const ak = sel([['conforme', 'Conforme'], ['con_observaciones', 'Con observaciones'], ['no_firma', 'No firma']], prev.has(p.id) ? prev.get(p.id).ack : 'conforme');
      ak.setAttribute('aria-label', 'Conformidad de ' + p.full_name);
      const ob = inp('text', prev.has(p.id) && prev.get(p.id).observation || '', { maxLength: 500, autocomplete: 'off', placeholder: 'Observación (si corresponde)' });
      ob.setAttribute('aria-label', 'Observación de ' + p.full_name);
      row.append(lab, ak, ob);
      return { p, cb, ak, ob, row };
    });
    const cnt = mk('p', 'mute'); cnt.setAttribute('role', 'status');
    const updCnt = () => { const n = rows.filter(x => x.cb.checked).length; cnt.textContent = n + (n === 1 ? ' asistente elegido' : ' asistentes elegidos') + ' de ' + peo.length + '.'; };
    rows.forEach(x => x.cb.addEventListener('change', updCnt));
    const all = mk('button', 'ghost', 'Marcar a todos'); all.type = 'button';
    const none = mk('button', 'ghost', 'Desmarcar a todos'); none.type = 'button';
    all.addEventListener('click', () => { rows.forEach(x => { x.cb.checked = true; }); updCnt(); });
    none.addEventListener('click', () => { rows.forEach(x => { x.cb.checked = false; }); updCnt(); });
    fs.append(rowOf(all, none), ...(rows.length ? rows.map(x => x.row) : [mk('p', 'mute', 'No hay personas activas cargadas: cargalas primero en Equipos > Personas.')]), cnt);
    updCnt();
    const note = mk('p', 'mute', pre ? 'Estás corrigiendo la capacitación del ' + fmtAR(pre.held_at) + ' (' + pre.topic + '). El registro anterior no se borra: queda marcado como reemplazado.'
      : 'La constancia queda guardada y no se puede modificar: si hay un error, se carga una corrección que reemplaza a la anterior.');
    formCard(pre ? 'Corregir constancia de capacitación' : 'Nueva constancia de capacitación', [note, g1, g2, fs], spec, async v => {
      if (v.held_at > nowLocalAR()) return 'Fecha y hora: no puede ser futura.';
      const d = v.dur === null || v.dur === '' ? null : Number(v.dur);
      if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 1440)) return 'Duración: minutos, número entero de 1 a 1440.';
      const sel2 = rows.filter(x => x.cb.checked);
      if (!sel2.length) return 'Asistentes: elegí al menos una persona.';
      if (sel2.length > 200) return 'Asistentes: como máximo 200 por constancia.';
      const attendees = [];
      for (const x of sel2) {
        const o = x.ob.value.trim();
        if (x.ak.value === 'con_observaciones' && !o) return 'Observación de ' + x.p.full_name + ': es obligatoria si firma con observaciones.';
        attendees.push({ person_id: x.p.id, ack: x.ak.value, ...(o ? { observation: o } : {}) });
      }
      const args = { held_at: localToIso(v.held_at), topic: v.topic, trainer: v.trainer, modality_place: v.place, modality_sync: v.sync, assisted: v.assisted === 'si', duration_min: d, attendees };
      if (pre) args.supersedes = pre.id;
      const r = await tryQ(() => sb.rpc('create_training', args));
      if (tableMissing(r)) { CN.avail.trn = 'missing'; renderConst(); return MIG_TXT; }
      if (r.error) return cDbErr(r.error, 'create_training');
      logAccess('training_create', typeof r.data === 'string' ? r.data : '', { tema: v.topic, asistentes: attendees.length, correccion: !!pre });
      announce('Constancia de capacitación guardada.');
      loadTrn();
      return '';
    });
  }

  function constFilters(onGo, printFn, csvFn, hasRows) {
    const ff = mk('form', 'qform noprint'); ff.noValidate = true;
    const inFrom = dateIn(CN.f.from || ymdAgo(90)), inTo = dateIn(CN.f.to || today());
    const grid = mk('div', 'grid2 qgrid'); grid.append(fld('Desde', inFrom), fld('Hasta', inTo));
    let per = null;
    if (onGo.person) { per = sel([['', 'Todas las personas'], ...EQ.people.map(p => [p.id, p.full_name])], CN.f.per); grid.append(fld('Persona', per)); }
    const bGo = mk('button', '', 'Buscar'); bGo.type = 'submit';
    const bCsv = mk('button', 'ghost', 'Exportar CSV'); bCsv.type = 'button';
    const bPr = mk('button', 'ghost', 'Imprimir / PDF'); bPr.type = 'button';
    bCsv.disabled = bPr.disabled = !hasRows;
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    ff.append(grid, rowOf(bGo, bCsv, bPr), err);
    ff.addEventListener('submit', e => {
      e.preventDefault(); err.textContent = '';
      if (inFrom.value && inTo.value && inFrom.value > inTo.value) { err.textContent = 'La fecha Desde es posterior a Hasta.'; return; }
      CN.f = { from: inFrom.value, to: inTo.value, per: per ? per.value : '' };
      onGo.run();
    });
    bCsv.addEventListener('click', csvFn); bPr.addEventListener('click', printFn);
    return ff;
  }
  const cDesc = () => 'Desde ' + ymdAR(CN.f.from || ymdAgo(90)) + ' hasta ' + ymdAR(CN.f.to || today()) + (CN.f.per && CN.sub === 'epp' ? ' · ' + pnameOf(CN.f.per) : '');
  function eppView() {
    if (CN.avail.epp === 'missing') return [missingBox()];
    const out = [];
    const head = mk('div', 'row noprint');
    if (canWrite()) head.append(btn('Nueva entrega de EPP', '', () => eppForm(null)));
    else out.push(roHint('Tu rol (auditor) es de solo lectura: podés ver, exportar e imprimir las constancias.'));
    if (head.children.length) out.push(head);
    if (CN.err.epp) out.push(errLine(CN.err.epp, 'No se pudieron leer las constancias de EPP'));
    const showDni = ROLE === 'admin';
    if (!showDni) out.push(mk('p', 'mute noprint', 'El DNI del trabajador solo lo ve un administrador: si la constancia lo necesita, imprimila desde un usuario administrador.'));
    const sup = new Set(CN.epp.map(r => r.supersedes).filter(Boolean));
    const csvHead = ['fecha_entrega', 'trabajador', 'legajo', ...(showDni ? ['dni'] : []), 'puesto', 'producto', 'cantidad', 'modelo', 'marca', 'certificacion', 'referencia_certificacion',
      'casco', 'conformidad', 'observacion', 'estado', 'cargado_por', 'cargado_el', 'id', 'corrige_a'];
    const stateOf2 = r => (sup.has(r.id) ? 'Reemplazada por una corrección' : r.supersedes ? 'Corrige un registro anterior' : 'Vigente');
    const csvRows = () => CN.epp.map(r => { const pe = r.person || {}, p2 = EQ.people.find(x => x.id === r.person_id) || {};
      return [ymdAR(r.delivered_at), pnameOf(r.person_id, pe), pe.legajo || p2.legajo || '', ...(showDni ? [pe.dni || p2.dni || ''] : []), pe.job_title || p2.job_title || '', r.item, r.quantity,
        r.model || '', r.brand || '', r.certified ? 'Sí' : 'No', r.cert_ref || '', r.device_id || '', ACK_LBL[r.worker_ack] || r.worker_ack, r.observation || '', stateOf2(r),
        r.created_by_email || '', fmtAR(r.created_at), r.id, r.supersedes || '']; });
    out.push(constFilters({ person: true, run: loadEpp }, () => printPanel('constPrint', 'Constancias de entrega de EPP', cDesc()),
      () => csvDownload('constancias_epp_' + today() + '.csv', csvHead, csvRows()), CN.epp.length > 0));
    if (!CN.loaded.epp) { out.push(mk('p', 'mute', 'Cargando…')); return out; }
    out.push(mk('p', 'print-only', cDesc()));
    const heads = ['Entrega', 'Trabajador', ...(showDni ? ['DNI'] : []), 'Puesto', 'Producto', 'Cant.', 'Modelo / marca', 'Certificación', 'Conformidad', 'Estado', 'Cargó', { t: 'Acciones', cls: 'noprint' }];
    const rows = CN.epp.map(r => {
      const pe = r.person || {}, p2 = EQ.people.find(x => x.id === r.person_id) || {};
      const acts = mk('div', 'row');
      if (canWrite() && !sup.has(r.id)) acts.append(btn('Corregir', 'ghost', () => eppForm(r), 'Corregir la entrega de ' + r.item + ' a ' + pnameOf(r.person_id, pe)));
      acts.append(btn('Imprimir constancia', 'ghost', ev => printRow(ev.currentTarget.closest('tr'), 'constPrint', 'Constancia de entrega de EPP', pnameOf(r.person_id, pe) + ' · ' + ymdAR(r.delivered_at)),
        'Imprimir la constancia de ' + r.item + ' de ' + pnameOf(r.person_id, pe)));
      return { cls: sup.has(r.id) ? 'archived' : '', cells: [{ t: ymdAR(r.delivered_at), cls: 'mono' },
        pnameOf(r.person_id, pe) + (pe.legajo || p2.legajo ? ' (' + (pe.legajo || p2.legajo) + ')' : ''), ...(showDni ? [pe.dni || p2.dni || ''] : []),
        pe.job_title || p2.job_title || '', r.item + (r.device_id ? ' · casco ' + r.device_id : ''), String(r.quantity), [r.model, r.brand].filter(Boolean).join(' / '),
        r.certified ? 'Sí' + (r.cert_ref ? ': ' + r.cert_ref : '') : 'No', (ACK_LBL[r.worker_ack] || r.worker_ack) + (r.observation ? ' · ' + r.observation : ''), stateOf2(r),
        (r.created_by_email || '—') + ' · ' + fmtAR(r.created_at), acts] };
    });
    const t = dataTable('Constancias de entrega de EPP', heads, rows, 'No hay constancias de EPP en este período.');
    // la columna de acciones no se imprime
    t.querySelectorAll('tbody tr').forEach(tr => { const l = tr.lastElementChild; if (l && l.querySelector('button')) l.classList.add('noprint'); });
    out.push(t);
    if (CN.trunc.epp) out.push(mk('p', 'mute', 'Se muestran las primeras ' + CONST_MAX + ' constancias: acotá las fechas para ver el resto.'));
    return out;
  }
  function trnView() {
    if (CN.avail.trn === 'missing') return [missingBox()];
    const out = [];
    const head = mk('div', 'row noprint');
    if (canWrite()) head.append(btn('Nueva capacitación', '', () => trnForm(null)));
    else out.push(roHint('Tu rol (auditor) es de solo lectura: podés ver, exportar e imprimir las constancias. Las observaciones de los asistentes se muestran sin identificar a la persona.'));
    if (head.children.length) out.push(head);
    if (CN.err.trn) out.push(errLine(CN.err.trn, 'No se pudieron leer las capacitaciones'));
    if (CN.attErr) out.push(errLine(CN.attErr, 'No se pudieron leer los asistentes'));
    const sup = new Set(CN.trn.map(r => r.supersedes).filter(Boolean));
    const attOf = id => (CN.att.get(id) || []);
    const aud = isAuditor();
    const attName = a => (aud ? (a.person_id ? pnameOf(a.person_id) : 'Persona reservada') : (a.person ? a.person.full_name : pnameOf(a.person_id)));
    const attTxt = a => attName(a) + ' (' + (ACK_LBL[a.ack] || a.ack) + ')' + (a.observation && !aud ? ': ' + a.observation : '');
    const stateOf2 = r => (sup.has(r.id) ? 'Reemplazada por una corrección' : r.supersedes ? 'Corrige un registro anterior' : 'Vigente');
    const modTxt = r => [PLACE_LBL[r.modality_place], SYNC_LBL[r.modality_sync], r.assisted ? 'asistida' : 'no asistida'].filter(Boolean).join(' · ');
    const csvHead = ['fecha_hora', 'tema', 'capacitador', 'modalidad_lugar', 'modalidad_sincronia', 'asistida', 'duracion_min', 'asistentes', 'observaciones_sin_identificar', 'estado', 'cargado_por', 'cargado_el', 'id', 'corrige_a'];
    const csvRows = () => CN.trn.map(r => [fmtAR(r.held_at), r.topic, r.trainer, PLACE_LBL[r.modality_place] || '', SYNC_LBL[r.modality_sync] || '', r.assisted ? 'Sí' : 'No', r.duration_min || '',
      attOf(r.id).map(attTxt).join(' | '), aud ? attOf(r.id).filter(a => a.observation).map(a => a.observation).join(' | ') : '', stateOf2(r), r.created_by_email || '',
      fmtAR(r.created_at), r.id, r.supersedes || '']);
    out.push(constFilters({ person: false, run: loadTrn }, () => printPanel('constPrint', 'Constancias de capacitación', cDesc()),
      () => csvDownload('constancias_capacitacion_' + today() + '.csv', csvHead, csvRows()), CN.trn.length > 0));
    if (!CN.loaded.trn) { out.push(mk('p', 'mute', 'Cargando…')); return out; }
    out.push(mk('p', 'print-only', cDesc()));
    const rows = CN.trn.map(r => {
      const list = mk('ul', 'att-list');
      const at = attOf(r.id);
      for (const a of at) list.append(mk('li', '', attName(a) + ' · ' + (ACK_LBL[a.ack] || a.ack) + (a.observation && !aud ? ' · «' + a.observation + '»' : '')));
      const obsOnly = aud ? at.filter(a => a.observation) : [];
      const cell = mk('div', 'section');
      cell.append(mk('span', 'mute', at.length + (at.length === 1 ? ' asistente' : ' asistentes')), list);
      if (obsOnly.length) { cell.append(mk('span', 'mute', 'Observaciones (sin identificar):')); const ol = mk('ul', 'att-list'); obsOnly.forEach(a => ol.append(mk('li', '', '«' + a.observation + '»'))); cell.append(ol); }
      const acts = mk('div', 'row');
      if (canWrite() && !sup.has(r.id)) acts.append(btn('Corregir', 'ghost', () => trnForm(r), 'Corregir la capacitación ' + r.topic));
      acts.append(btn('Imprimir constancia', 'ghost', ev => printRow(ev.currentTarget.closest('tr'), 'constPrint', 'Constancia de capacitación', r.topic + ' · ' + fmtAR(r.held_at)), 'Imprimir la constancia de la capacitación ' + r.topic));
      return { cls: sup.has(r.id) ? 'archived' : '', cells: [{ t: fmtAR(r.held_at), cls: 'mono' }, r.topic, r.trainer, modTxt(r), r.duration_min ? r.duration_min + ' min' : '', cell, stateOf2(r),
        (r.created_by_email || '—') + ' · ' + fmtAR(r.created_at), acts] };
    });
    const t = dataTable('Constancias de capacitación', ['Fecha y hora', 'Tema', 'Capacitador', 'Modalidad', 'Duración', 'Asistentes', 'Estado', 'Cargó', { t: 'Acciones', cls: 'noprint' }], rows,
      'No hay capacitaciones en este período.');
    t.querySelectorAll('tbody tr').forEach(tr => { const l = tr.lastElementChild; if (l && l.querySelector('button')) l.classList.add('noprint'); });
    out.push(t);
    if (CN.trunc.trn) out.push(mk('p', 'mute', 'Se muestran las primeras ' + CONST_MAX + ' capacitaciones: acotá las fechas para ver el resto.'));
    return out;
  }
  function orgView() {
    if (CN.avail.org === 'missing') return [missingBox()];
    const out = [];
    if (CN.orgErr) out.push(errLine(CN.orgErr, 'No se pudieron leer los datos del empleador'));
    const o = CN.org || {};
    out.push(mk('p', 'mute', 'Estos datos encabezan todo lo que se imprime o se exporta a PDF desde Asistencia, Constancias y Auditoría.'));
    if (!isAdmin()) {
      out.push(kv([['Razón social', o.legal_name], ['CUIT', o.cuit], ['Domicilio', o.address], ['Responsable', o.responsible_name], ['Cargo del responsable', o.responsible_role], ['Contacto', o.contact]]));
      out.push(mk('p', 'mute rolenote noprint', 'Los datos del empleador los carga un administrador.'));
      return out;
    }
    const legal = inp('text', o.legal_name || '', { maxLength: 200, autocomplete: 'organization' });
    const cuit = inp('text', o.cuit || '', { maxLength: 13, inputMode: 'numeric', autocomplete: 'off', placeholder: '30-12345678-9' });
    const addr = inp('text', o.address || '', { maxLength: 300, autocomplete: 'street-address' });
    const rn = inp('text', o.responsible_name || '', { maxLength: 120, autocomplete: 'off' });
    const rr = inp('text', o.responsible_role || '', { maxLength: 120, autocomplete: 'off' });
    const ct = inp('text', o.contact || '', { maxLength: 200, autocomplete: 'off' });
    const spec = [
      { k: 'legal_name', el: legal, label: 'Razón social', req: true, max: 200 },
      { k: 'cuit', el: cuit, label: 'CUIT', req: true, re: /^\d{2}-?\d{8}-?\d$/, msg: 'tiene que ser un CUIT de 11 dígitos (30-12345678-9).' },
      { k: 'address', el: addr, label: 'Domicilio', max: 300 },
      { k: 'responsible_name', el: rn, label: 'Responsable', max: 120 },
      { k: 'responsible_role', el: rr, label: 'Cargo del responsable', max: 120 },
      { k: 'contact', el: ct, label: 'Contacto', max: 200 },
    ];
    const f = mk('form', 'section noprint'); f.noValidate = true; f.dataset.org = CN.org ? 'l' : 'e';
    const g = mk('div', 'grid2'); g.append(fld('Razón social', legal), fld('CUIT', cuit), fld('Domicilio', addr), fld('Responsable', rn), fld('Cargo del responsable', rr), fld('Contacto (teléfono o correo)', ct));
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    const ok = mk('div', 'okmsg'); ok.setAttribute('role', 'status');
    const go = mk('button', '', 'Guardar datos del empleador'); go.type = 'submit';
    f.append(g, rowOf(go), err, ok);
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = ''; ok.textContent = '';
      const r = collect(spec);
      if (r.errors.length) { err.textContent = r.errors.join(' '); return; }
      const d = r.v.cuit.replace(/\D/g, '');
      const body = { legal_name: r.v.legal_name, cuit: d.slice(0, 2) + '-' + d.slice(2, 10) + '-' + d.slice(10), address: r.v.address, responsible_name: r.v.responsible_name,
        responsible_role: r.v.responsible_role, contact: r.v.contact };
      go.disabled = true;
      // update y, si la fila no existe todavia, insert con id = 1 (el grant de UPDATE no incluye id: no sirve el upsert directo)
      let res = await tryQ(() => sb.from('org_settings').update(body).eq('id', 1).select(ORG_COLS));
      if (!res.error && Array.isArray(res.data) && !res.data.length) res = await tryQ(() => sb.from('org_settings').insert({ id: 1, ...body }).select(ORG_COLS));
      go.disabled = false;
      if (tableMissing(res)) { CN.avail.org = 'missing'; renderConst(); return; }
      if (res.error) { err.textContent = isAuthErr(res.error) ? (sessionExpired(), 'Sesión vencida: ingresá de nuevo.') : noPerm(res.error) ? 'Solo un administrador puede cambiar los datos del empleador.' : cDbErr(res.error, 'org_settings'); return; }
      CN.org = Object.assign({}, CN.org || {}, body); CN.orgP = Promise.resolve(CN.org); CN.avail.org = 'ok';
      logAccess('config_change', 'org_settings', { claves: Object.keys(body) });
      ok.textContent = 'Datos del empleador guardados.';
      announce('Datos del empleador guardados.');
    });
    out.push(f);
    return out;
  }
  function renderConst() {
    if ($('panelConst').classList.contains('hidden')) return;
    for (const [k, id] of [['epp', 'constTabEpp'], ['trn', 'constTabTrn'], ['org', 'constTabOrg']]) {
      $(id).setAttribute('aria-selected', String(CN.sub === k)); $(id).tabIndex = CN.sub === k ? 0 : -1;
    }
    $('constBody').setAttribute('aria-labelledby', CN.sub === 'epp' ? 'constTabEpp' : CN.sub === 'trn' ? 'constTabTrn' : 'constTabOrg');
    const body = $('constBody');
    if (CN.sub === 'org' && body.querySelector('form[data-org="' + (CN.org ? 'l' : 'e') + '"]')) return;   // no pisar lo que se esta tipeando
    body.replaceChildren(...(CN.sub === 'epp' ? eppView() : CN.sub === 'trn' ? trnView() : orgView()));
  }
  function constShow() {
    if (!EQ.loaded) loadEquipos();
    loadOrg();
    if (CN.sub === 'epp') loadEpp(); else if (CN.sub === 'trn') loadTrn();
    renderConst();
  }
  function setConstSub(k) {
    CN.sub = k; closeConstForm();
    if (k === 'epp' && !CN.loaded.epp) loadEpp(); else if (k === 'trn' && !CN.loaded.trn) loadTrn(); else if (k === 'org') loadOrg(true).then(renderConst);
    renderConst();
  }
  for (const [id, k] of [['constTabEpp', 'epp'], ['constTabTrn', 'trn'], ['constTabOrg', 'org']]) $(id).addEventListener('click', () => setConstSub(k));
  $('constTabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const keys = ['epp', 'trn', 'org'], ids = ['constTabEpp', 'constTabTrn', 'constTabOrg'];
    const i = (keys.indexOf(CN.sub) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    setConstSub(keys[i]); $(ids[i]).focus();
  });

  // ======================================================================
  // Auditoria (access_log): admin y auditor
  // ======================================================================
  const AUD_COLS = 'id,at,user_email,role,action,target,detail';
  const AUD_PAGE = 50, AUD_CSV_PAGE = 250, AUD_CSV_PAGES = 20;
  const AUD_ACTION = { view_live: 'Ver en vivo', record_start: 'Inició una grabación', record_stop: 'Detuvo una grabación', photo: 'Sacó una foto', export_csv: 'Exportó un CSV',
    export_pdf: 'Imprimió o sacó un PDF', config_change: 'Cambió una configuración', command: 'Envió una orden', archive: 'Archivó o desarchivó', delete_media: 'Eliminó una imagen',
    login: 'Ingresó al visor', assist_open: 'Abrió una asistencia', assist_close: 'Cerró una asistencia', epp_create: 'Cargó una constancia de EPP',
    training_create: 'Cargó una constancia de capacitación', hash_verify: 'Verificó la integridad de un archivo' };
  const ROLE_LBL = { admin: 'admin', viewer: 'supervisor', auditor: 'auditor', device: 'casco' };
  const AU = { rows: [], page: 0, cursors: [null], more: false, busy: false, applied: null, avail: 'unknown', err: null, loaded: false, f: { from: '', to: '', user: '', action: '' } };
  const detailTxt = d => {
    if (!d || typeof d !== 'object') return '';
    return Object.entries(d).map(([k, v]) => k + ': ' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' · ');
  };
  function audQuery(f, cur) {
    let q = sb.from('access_log').select(AUD_COLS);
    if (f.from) q = q.gte('at', dayStartISO(f.from));
    if (f.to) q = q.lt('at', dayStartISO(f.to, 1));
    if (f.action) q = q.eq('action', f.action);
    const u = String(f.user || '').replace(/[%*,()\\]/g, '').trim();
    if (u) q = q.ilike('user_email', '%' + u + '%');
    if (cur != null) q = q.lt('id', cur);
    return q.order('id', { ascending: false });
  }
  async function audLoad(page) {
    if (!AU.applied || AU.busy) return;
    AU.busy = true; renderAud();
    const r = await tryQ(() => audQuery(AU.applied, AU.cursors[page]).limit(AUD_PAGE + 1));
    AU.busy = false;
    if (tableMissing(r)) AU.avail = 'missing';
    else if (r.error || !Array.isArray(r.data)) { if (isAuthErr(r.error)) sessionExpired(); AU.err = r.error || new Error('sin datos'); }
    else {
      AU.err = null; AU.avail = 'ok'; AU.page = page; AU.more = r.data.length > AUD_PAGE; AU.rows = r.data.slice(0, AUD_PAGE); AU.loaded = true;
      if (AU.more) AU.cursors[page + 1] = AU.rows[AU.rows.length - 1].id;
    }
    renderAud();
  }
  async function audCsv(btn) {
    if (!AU.applied || AU.busy) return;
    AU.busy = true; renderAud();
    const all = [];
    let cur = null, trunc = false, fail = null;
    for (let i = 0; i < AUD_CSV_PAGES; i++) {
      const r = await tryQ(() => audQuery(AU.applied, cur).limit(AUD_CSV_PAGE + 1));
      if (r.error || !Array.isArray(r.data)) { fail = r.error || new Error('sin datos'); break; }
      all.push(...r.data.slice(0, AUD_CSV_PAGE));
      if (r.data.length <= AUD_CSV_PAGE) break;
      if (i === AUD_CSV_PAGES - 1) trunc = true;
      cur = r.data[AUD_CSV_PAGE - 1].id;
    }
    AU.busy = false;
    if (fail) { AU.err = fail; renderAud(); return; }
    csvDownload('auditoria_' + today() + '.csv', ['fecha', 'usuario', 'rol', 'accion', 'accion_codigo', 'objetivo', 'detalle', 'id'],
      all.map(x => [fmtAR(x.at), x.user_email || '', ROLE_LBL[x.role] || x.role || '', AUD_ACTION[x.action] || x.action, x.action, x.target || '', detailTxt(x.detail), x.id]));
    AU.notice = 'CSV exportado: ' + all.length + ' filas' + (trunc ? ' (tope de ' + AUD_CSV_PAGE * AUD_CSV_PAGES + ': acotá las fechas para ver el resto)' : '') + '.';
    renderAud();
  }
  function renderAud() {
    const host = $('audHost');
    if (!host || $('panelAud').classList.contains('hidden')) return;
    if (AU.avail === 'missing') { host.replaceChildren(missingBox()); return; }
    const ff = mk('form', 'qform noprint'); ff.noValidate = true;
    const inFrom = dateIn(AU.f.from || ymdAgo(7)), inTo = dateIn(AU.f.to || today());
    const usr = inp('text', AU.f.user || '', { maxLength: 80, autocomplete: 'off', placeholder: 'correo o parte del correo' });
    const act = sel([['', 'Todas las acciones'], ...Object.entries(AUD_ACTION)], AU.f.action || '');
    const bGo = mk('button', '', 'Buscar'); bGo.type = 'submit';
    const bCsv = mk('button', 'ghost', 'Exportar CSV'); bCsv.type = 'button';
    const bPr = mk('button', 'ghost', 'Imprimir / PDF'); bPr.type = 'button';
    bCsv.disabled = bPr.disabled = AU.busy || !AU.rows.length;
    bGo.disabled = AU.busy;
    const g = mk('div', 'grid2 qgrid'); g.append(fld('Desde', inFrom), fld('Hasta', inTo), fld('Usuario', usr), fld('Acción', act));
    const err = mk('div', 'err'); err.setAttribute('role', 'alert');
    ff.append(g, rowOf(bGo, bCsv, bPr), err);
    ff.addEventListener('submit', e => {
      e.preventDefault(); err.textContent = '';
      if (inFrom.value && inTo.value && inFrom.value > inTo.value) { err.textContent = 'La fecha Desde es posterior a Hasta.'; return; }
      AU.f = { from: inFrom.value, to: inTo.value, user: usr.value.trim(), action: act.value };
      AU.applied = { ...AU.f }; AU.cursors = [null]; AU.page = 0; AU.notice = '';
      audLoad(0);
    });
    bCsv.addEventListener('click', () => audCsv());
    const desc = () => 'Desde ' + ymdAR(AU.f.from || ymdAgo(7)) + ' hasta ' + ymdAR(AU.f.to || today()) + (AU.f.user ? ' · usuario: ' + AU.f.user : '') + (AU.f.action ? ' · acción: ' + (AUD_ACTION[AU.f.action] || AU.f.action) : '');
    bPr.addEventListener('click', () => printPanel('audPrint', 'Auditoría de accesos', desc() + ' · página ' + (AU.page + 1)));
    const kids = [ff];
    if (AU.err) kids.push(errLine(AU.err, 'No se pudo leer la auditoría'));
    if (AU.notice) { const n = mk('p', 'okmsg', AU.notice); n.setAttribute('role', 'status'); kids.push(n); }
    kids.push(mk('p', 'print-only', desc()));
    if (!AU.applied) kids.push(mk('p', 'mute', 'Elegí los filtros y tocá Buscar.'));
    else if (AU.busy && !AU.loaded) kids.push(mk('p', 'mute', 'Cargando…'));
    else {
      kids.push(dataTable('Auditoría de accesos', ['Fecha', 'Usuario', 'Rol', 'Acción', 'Objetivo', 'Detalle'],
        AU.rows.map(x => ({ cells: [{ t: fmtAR(x.at), cls: 'mono' }, x.user_email, ROLE_LBL[x.role] || x.role, AUD_ACTION[x.action] || x.action, { t: x.target || '', cls: 'mono' }, detailTxt(x.detail).slice(0, 240)] })),
        'No hay registros para estos filtros.'));
      const bPrev = mk('button', 'ghost', 'Anterior'), bNext = mk('button', 'ghost', 'Siguiente');
      bPrev.type = bNext.type = 'button';
      bPrev.disabled = AU.busy || AU.page === 0; bNext.disabled = AU.busy || !AU.more;
      bPrev.addEventListener('click', () => audLoad(AU.page - 1)); bNext.addEventListener('click', () => audLoad(AU.page + 1));
      const a = AU.page * AUD_PAGE;
      const pg = mk('div', 'row pager'); pg.append(bPrev, mk('span', 'mute', AU.rows.length ? 'Página ' + (AU.page + 1) + ' · filas ' + (a + 1) + ' a ' + (a + AU.rows.length) : 'Página ' + (AU.page + 1)), bNext);
      kids.push(pg);
    }
    host.replaceChildren(...kids);
  }
  function audShow() {
    if (!AU.applied) { AU.f = { from: ymdAgo(7), to: today(), user: '', action: '' }; AU.applied = { ...AU.f }; AU.cursors = [null]; audLoad(0); }
    renderAud();
  }

  function resetTandaC() {
    clearTimeout(asReloadT);
    Object.assign(AS, { avail: 'unknown', open: new Map(), rows: [], trunc: false, f: { from: '', to: '', dev: '' }, loaded: false, busy: false, again: false, err: null,
      ready: null, sig: '', startDraft: { dev: '', topic: '' } });
    AS.drafts.clear(); AS.minis.clear(); AS.opening.clear(); AS.autoIds.clear(); AS.autoErr.clear(); AS.localPh.clear();
    Object.assign(CN, { sub: 'epp', avail: { epp: 'unknown', trn: 'unknown', org: 'unknown' }, org: null, orgP: null, orgErr: null, epp: [], trn: [], att: new Map(), attErr: null,
      err: {}, loaded: { epp: false, trn: false }, busy: {}, trunc: {}, f: { from: '', to: '', per: '' } });
    Object.assign(AU, { rows: [], page: 0, cursors: [null], more: false, busy: false, applied: null, avail: 'unknown', err: null, loaded: false, notice: '', f: { from: '', to: '', user: '', action: '' } });
    LOGACC.off = false;
    for (const id of ['asisHost', 'constBody', 'audHost', 'constForm', 'asisPrint', 'constPrint', 'audPrint']) { const e = $(id); if (e) e.replaceChildren(); }
    $('constForm').classList.add('hidden');
    syncAsisBadge();
  }

  // ---- Roles en la UI (el servidor tambien lo exige por RLS): admin hace todo; supervisor (viewer) mira, atiende y manda mensajes ----
  function applyRole() {
    const adm = isAdmin(), aud = isAuditor();
    const who = $('who'), em = who.dataset.email || '', role = roleName();
    who.replaceChildren(...(em ? [mk('span', 'who-email', em)] : []), mk('span', 'who-role', role));
    who.title = (em ? em + ' · ' : '') + 'rol: ' + role;   // tooltip con el texto completo si el correo se recorta
    $('btnEvac').disabled = !adm;
    $('evacRoleNote').classList.toggle('hidden', adm);
    if (!adm) closeEvac();
    for (const id of ['gDrawCircle', 'gDrawPoly', 'gAddPoint']) $(id).disabled = !adm;
    $('mapRoleNote').classList.toggle('hidden', adm);
    if (!adm && typeof setMode === 'function') setMode(null);
    // Tanda C: pestañas segun rol. Auditor: solo lectura (sin En vivo, Mapa, ordenes ni Atender). Auditoria: admin y auditor.
    document.body.dataset.role = ROLE;
    for (const [id, hide] of [['tabLive', aud], ['tabMap', aud], ['tabAud', !(adm || aud)]]) $(id).classList.toggle('hidden', hide);
    for (const id of ['orders', 'testMic']) $(id).classList.toggle('hidden', aud);
    $('toolbarAud').classList.toggle('hidden', !aud);
    ovAtend.hidden = ovLive.hidden = ovNoteL.hidden = aud;
    ovMute.hidden = false;
  }
  const roNote = what => mk('p', 'mute rolenote', 'Tu rol (' + roleName() + ') es de solo lectura: ' + what + ' las hace un administrador.');
  function resetT4() {
    closeDlg();
    CMD.items.clear(); CMD.last.clear(); CMD.torch.clear(); CMD.avail = 'unknown';
    clearInterval(CMD.timer); CMD.timer = null; CMD.polling = false;
    if (CMD.ch) { try { sb.removeChannel(CMD.ch); } catch (_) {} CMD.ch = null; }
    photos.clear(); evAlerts.clear(); signedCache.clear(); cmdViews.clear(); cmdBars.clear(); IMG.clear(); delSel.clear();
    for (const a of frames.values()) a.forEach(f => { try { URL.revokeObjectURL(f.url); } catch (_) {} });
    frames.clear();
    QR.view = 'unknown'; repQ.reset(); histQ.reset();
    resetTandaC();
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
    if (AS.avail === 'ok') loadAssistOpen();   // respaldo del Realtime de las sesiones de asistencia
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
    for (const c of [channel, chOrders, chGeo, AS.ch]) if (c) { try { sb.removeChannel(c); } catch (_) {} }
    channel = chOrders = chGeo = null; AS.ch = null; clearTimeout(asReloadT);
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
    $('navPend').classList.add('hidden'); $('tabMain').removeAttribute('aria-label');
    $('kpiPendN').textContent = '—'; $('kpiPendAge').textContent = 'Cargando…'; $('kpiDevN').textContent = '—'; $('kpiDevOff').textContent = 'Cargando…'; $('kpiDevOff').className = 'mute';
    $('kpiPend').classList.remove('alert');
    $('who').dataset.email = session.user.email;
    $('feed').replaceChildren(); $('feedDone').replaceChildren(); $('pendList').replaceChildren();
    {
      let r = session.user && session.user.app_metadata && session.user.app_metadata.role;
      if (!r) { try { const c = JSON.parse(atob(String(session.access_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); r = c.app_metadata && c.app_metadata.role; } catch (_) {} }
      ROLE = r === 'admin' ? 'admin' : r === 'auditor' ? 'auditor' : 'viewer';
      MY_ID = session.user && session.user.id ? String(session.user.id) : '';
    }
    resetT4(); applyRole();
    // Estado limpio (Reintentar / nuevo ingreso): sin tarjetas fantasma de la sesion anterior.
    cards.clear(); pending.clear(); acks.clear(); pendEls.clear(); devOf.clear(); evAt.clear();
    devState.clear(); hAlerts.clear(); hSig = ''; posLoaded = false; devLoaded = false; devErr = false; lastPos.clear(); trail.clear(); geoInfos.clear(); lastEv = null;
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
        else if (ev.type === 'equip' && !cards.has(ev.id)) softBeep();   // aviso de equipo: nivel medio, tono corto
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
    AS.ready = loadAssistOpen();
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
    if (error) { $('loginErr').textContent = 'No se pudo ingresar: ' + errEs(error); return; }
    manualLogout = false; clearExpired();
    start(data.session);
    logAccess('login', null, {});
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
    for (const t of [escTimer, resyncT, sirenT, CMD.timer, eqTimer, geoTimer, mapTimer, rqT, armTimer, asReloadT]) { clearInterval(t); clearTimeout(t); }
    stopSiren(); closeNotifs();
    for (const c of [channel, chOrders, chGeo, CMD.ch, AS.ch]) if (c) { try { sb.removeChannel(c); } catch (_) {} }
  });
  window.addEventListener('offline', () => { netOff = true; $('status').textContent = 'Sin conexión a internet'; updateConnBar(); });
  window.addEventListener('online', () => { netOff = false; $('status').textContent = 'Reconectando…'; updateConnBar(); resyncNow(); });

  sb.auth.getSession().then(({ data }) => { if (data.session) start(data.session); });
})();
