// info-table.js — Tabla de Información + Dev Panel (Firebase Realtime Database)
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, get } from 'firebase/database';
import { getAuth, signInWithEmailAndPassword, signOut as fbSignOut } from 'firebase/auth';

const FB_CONFIG = {
    apiKey: "AIzaSyCr1bcF_Lc1lKNoTmVYqIduwDqZIxK-mrM",
    authDomain: "cerberusai-87db2.firebaseapp.com",
    projectId: "cerberusai-87db2",
    storageBucket: "cerberusai-87db2.firebasestorage.app",
    messagingSenderId: "942100846980",
    appId: "1:942100846980:web:b1437acb40fc973a0d25d1",
    databaseURL: "https://cerberusai-87db2-default-rtdb.firebaseio.com"
};

// ── Firebase init ─────────────────────────────────────────────────────
const $el = id => document.getElementById(id);
const toast = msg => { try { window.showToast?.(msg); } catch(_){} };
const nav = view => { try { window.Navigation?.switchView(view); } catch(_){} };

let _db = null, _auth = null;
try {
    const existing = getApps().find(a => a.name === 'animesao-pro');
    const app = existing ? getApp('animesao-pro') : initializeApp(FB_CONFIG, 'animesao-pro');
    _db   = getDatabase(app);
    _auth = getAuth(app);
} catch(e) { console.warn('[InfoTable] Firebase init error:', e.message); }

// ── Default data ──────────────────────────────────────────────────────
function defBoard() {
    return {
        titulo: 'Nueva actualización',
        tituloAccent: 'disponible',
        descripcion: 'Hemos mejorado la precisión de las recomendaciones con IA y la velocidad de búsqueda. También añadimos nuevas funciones que te encantarán.',
        fecha: '03 de mayo, 2026',
        tipo: 'Actualización',
        firma: '¡Gracias por ser parte de AniBot! 💜'
    };
}
function defInfo() {
    const d = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
        nombre: 'AniBot',
        version: 'v2.0',
        apiStatus: 'Conectada',
        iaStatus: 'Activa',
        servidor: 'Online',
        ultimaActualizacion: `Hoy, ${d}`,
        proximaActualizacion: 'Próximamente'
    };
}
function defNotas() {
    return { items: [
        { texto: 'Estamos trabajando en una nueva función de seguimiento de animes.', fecha: '02/05' },
        { texto: 'Optimización de velocidad y precisión en recomendaciones.', fecha: '01/05' },
        { texto: 'Próximamente: integración con más APIs de anime.', fecha: '30/04' }
    ]};
}
function defFooter() {
    return {
        devName: 'Jimmy',
        devSub: 'Gracias por apoyar el proyecto 🙌',
        avatarUrl: '',
        visitUrl: 'https://animesao.replit.app'
    };
}

// ── Status color helper ───────────────────────────────────────────────
function statusColor(v) {
    if (['Conectada','Activa','Online'].includes(v)) return '#4ade80';
    if (['Desconectada','Inactiva','Offline'].includes(v)) return '#f87171';
    return '#fbbf24';
}

// ── Render: board ─────────────────────────────────────────────────────
function renderBoard(b) {
    const s = (id, v) => { const el = $el(id); if (el) el.textContent = v ?? ''; };
    s('it-board-date-text', b.fecha);
    s('it-board-badge',     b.tipo || 'Actualización');
    s('it-board-title',     b.titulo);
    s('it-board-title-accent', b.tituloAccent || 'disponible');
    s('it-board-desc',      b.descripcion);
    s('it-board-firma',     b.firma);
}

// ── Render: info general ─────────────────────────────────────────────
function renderInfo(info) {
    const card = $el('it-info-card');
    if (!card) return;

    const chevronSvg = `<svg class="it-row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;

    const dot = v => `<span class="it-dot" style="background:${statusColor(v)}"></span>`;

    const nombre   = info.nombre   || 'AniBot';
    const version  = info.version  || 'v2.0';
    const apiSt    = info.apiStatus || 'Conectada';
    const iaSt     = info.iaStatus  || 'Activa';
    const servSt   = info.servidor  || 'Online';
    const ultima   = info.ultimaActualizacion  || '—';
    const proxima  = info.proximaActualizacion || 'Próximamente';

    const rows = [
        {
            icon: '🔵', cls: 'it-row-icon--blue',
            label: 'Nombre de la app',
            val: `<span>${nombre}</span>${chevronSvg}`
        },
        {
            icon: '🔷', cls: 'it-row-icon--blue',
            label: 'Versión actual',
            val: `<span class="it-ver-badge">${version}</span>${chevronSvg}`
        },
        {
            icon: '⭐', cls: 'it-row-icon--yellow',
            label: 'API (Gemini)',
            val: `${dot(apiSt)}<span class="it-status-text" style="color:${statusColor(apiSt)}">${apiSt}</span>${chevronSvg}`
        },
        {
            icon: '🌐', cls: 'it-row-icon--blue',
            label: 'Estado de la IA',
            val: `${dot(iaSt)}<span class="it-status-text" style="color:${statusColor(iaSt)}">${iaSt}</span>${chevronSvg}`
        },
        {
            icon: '🗄', cls: 'it-row-icon--purple',
            label: 'Servidor',
            val: `${dot(servSt)}<span class="it-status-text" style="color:${statusColor(servSt)}">${servSt}</span>${chevronSvg}`
        },
        {
            icon: '📅', cls: 'it-row-icon--blue',
            label: 'Última actualización',
            val: `<span>${ultima}</span>${chevronSvg}`
        },
        {
            icon: '🕐', cls: 'it-row-icon--yellow',
            label: 'Próxima actualización',
            val: `<span class="it-yellow-text">${proxima}</span>${chevronSvg}`
        }
    ];

    card.innerHTML = rows.map((r, i) => `
        ${i ? '<div class="it-divider"></div>' : ''}
        <div class="it-row">
            <div class="it-row-left">
                <span class="it-row-icon ${r.cls}">${r.icon}</span>
                <span class="it-row-label">${r.label}</span>
            </div>
            <div class="it-row-val">${r.val}</div>
        </div>`).join('');
}

// ── Render: notas ────────────────────────────────────────────────────
let _showAllNotas = false;
let _allNotas = [];

function renderNotas(notas) {
    _allNotas = (notas && notas.items) ? notas.items : [];
    _renderNotasList();
}

function _renderNotasList() {
    const list = $el('it-notas-list');
    if (!list) return;
    const items = _showAllNotas ? _allNotas : _allNotas.slice(0, 3);
    if (!items.length) {
        list.innerHTML = '<p class="it-notas-empty">Sin notas por ahora.</p>';
        return;
    }
    list.innerHTML = items.map(item => `
        <div class="it-nota-item">
            <span class="it-nota-dot"></span>
            <span class="it-nota-text">${item.texto}</span>
            <span class="it-nota-date">${item.fecha}</span>
        </div>`).join('');

    const btn = $el('it-ver-todas-btn');
    if (btn) {
        if (_allNotas.length <= 3) {
            btn.style.display = 'none';
        } else {
            btn.style.display = 'flex';
            btn.innerHTML = _showAllNotas
                ? 'Ver menos <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>'
                : 'Ver todas <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
        }
    }
}

// ── Render: footer ───────────────────────────────────────────────────
let _visitUrl = 'https://animesao.replit.app';

function renderFooter(footer) {
    const nameEl   = $el('it-dev-name');
    const subEl    = $el('it-dev-sub');
    const imgEl    = $el('it-footer-img');

    if (nameEl) nameEl.textContent = footer.devName || 'Jimmy';
    if (subEl)  subEl.textContent  = footer.devSub  || 'Gracias por apoyar el proyecto 🙌';
    _visitUrl = footer.visitUrl || 'https://animesao.replit.app';

    if (imgEl) {
        if (footer.avatarUrl && footer.avatarUrl.startsWith('http')) {
            imgEl.src = footer.avatarUrl;
            imgEl.style.display = '';
        } else {
            imgEl.src = '/icon-192.png';
            imgEl.style.display = '';
        }
    }
}

// ── Real-time subscription ────────────────────────────────────────────
let _unsubscribe = null;
let _firstLoad = true;

function attachRealtime() {
    if (!_db) {
        // No database — render defaults
        renderBoard(defBoard());
        renderInfo(defInfo());
        renderNotas(defNotas());
        renderFooter(defFooter());
        showContent();
        return;
    }
    if (_unsubscribe) return; // already subscribed

    const publicRef = ref(_db, 'public');
    _unsubscribe = onValue(publicRef, (snapshot) => {
        const data = snapshot.val() || {};
        renderBoard(data.board  || defBoard());
        renderInfo(data.info   || defInfo());
        renderNotas(data.notas  || defNotas());
        renderFooter(data.footer || defFooter());
        if (_firstLoad) { showContent(); _firstLoad = false; }
    }, (err) => {
        console.warn('[InfoTable] onValue error:', err.message);
        renderBoard(defBoard());
        renderInfo(defInfo());
        renderNotas(defNotas());
        renderFooter(defFooter());
        showContent();
    });
}

function detachRealtime() {
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    _firstLoad = true;
}

function showContent() {
    const loading = $el('it-loading'), content = $el('it-content');
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
}

function showLoading() {
    const loading = $el('it-loading'), content = $el('it-content');
    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
}

// ── InfoTableManager (exposed globally) ───────────────────────────────
const InfoTableManager = {
    open() {
        nav('view-info-table');
        if (_firstLoad) showLoading();
        attachRealtime();
    },

    refresh() {
        // With Realtime DB, data is always current — just force a visual reload
        detachRealtime();
        showLoading();
        _firstLoad = true;
        attachRealtime();
        toast('Actualizando...');
    }
};
window.InfoTableManager = InfoTableManager;

// ── Dev Panel: helpers ────────────────────────────────────────────────
function showDevLogin() {
    const m = $el('dev-login-modal');
    if (m) { m.style.display = 'flex'; $el('dev-email')?.focus(); }
}

function hideDevLogin() {
    const m = $el('dev-login-modal');
    if (m) m.style.display = 'none';
    const e = $el('dev-email'), p = $el('dev-password'), err = $el('dev-login-error');
    if (e) e.value = ''; if (p) p.value = ''; if (err) err.textContent = '';
}

async function devLogin() {
    const emailEl = $el('dev-email'), pwEl = $el('dev-password');
    const errEl = $el('dev-login-error'), btn = $el('dev-login-btn');
    const email = emailEl?.value.trim(), password = pwEl?.value;
    if (!email || !password) { if (errEl) errEl.textContent = 'Completa todos los campos.'; return; }
    if (!_auth) { if (errEl) errEl.textContent = 'Error de conexión con Firebase.'; return; }

    if (btn) { btn.textContent = 'Verificando...'; btn.disabled = true; }
    if (errEl) errEl.textContent = '';

    try {
        await signInWithEmailAndPassword(_auth, email, password);
        hideDevLogin();
        openDevPanel(email);
    } catch(e) {
        const codes = {
            'auth/user-not-found':      'Email o contraseña incorrectos.',
            'auth/wrong-password':      'Email o contraseña incorrectos.',
            'auth/invalid-credential':  'Email o contraseña incorrectos.',
            'auth/too-many-requests':   'Demasiados intentos. Espera un momento.',
            'auth/network-request-failed': 'Sin conexión a internet.'
        };
        if (errEl) errEl.textContent = codes[e.code] || 'Credenciales incorrectas.';
    }
    if (btn) { btn.textContent = 'Acceder al panel'; btn.disabled = false; }
}

async function devLogout() {
    try { if (_auth) await fbSignOut(_auth); } catch(_) {}
    const p = $el('dev-panel'); if (p) p.style.display = 'none';
    toast('Sesión cerrada');
}

function openDevPanel(email) {
    const panel = $el('dev-panel');
    if (panel) panel.style.display = 'flex';
    const emailEl = $el('dp-user-email');
    if (emailEl) emailEl.textContent = email;
    loadPanelFromRealtime();
}

// ── Dev Panel: load current data into form fields ──────────────────
function loadPanelFromRealtime() {
    if (!_db) { populatePanelFields({}); return; }
    const publicRef = ref(_db, 'public');
    get(publicRef).then(snapshot => {
        populatePanelFields(snapshot.val() || {});
    }).catch(() => {
        populatePanelFields({});
    });
}

function populatePanelFields(data) {
    const b = data.board  || defBoard();
    const i = data.info   || defInfo();
    const n = data.notas  || defNotas();
    const f = data.footer || defFooter();

    const set = (id, v) => { const el = $el(id); if (el) el.value = v || ''; };

    // Board
    set('dp-board-title',        b.titulo);
    set('dp-board-title-accent', b.tituloAccent || 'disponible');
    set('dp-board-desc',         b.descripcion);
    set('dp-board-fecha',        b.fecha);
    set('dp-board-tipo',         b.tipo);
    set('dp-board-firma',        b.firma);

    // Info
    set('dp-info-nombre',  i.nombre);
    set('dp-info-version', i.version);
    set('dp-info-ultima',  i.ultimaActualizacion);
    set('dp-info-proxima', i.proximaActualizacion);
    const setSel = (id, val) => {
        const el = $el(id);
        if (!el) return;
        for (const o of el.options) { if (o.text === val) { o.selected = true; break; } }
    };
    setSel('dp-info-api',      i.apiStatus);
    setSel('dp-info-ia',       i.iaStatus);
    setSel('dp-info-servidor', i.servidor);

    // Notas
    renderNotasEditor(n.items || []);

    // Footer
    set('dp-footer-name',   f.devName);
    set('dp-footer-sub',    f.devSub);
    set('dp-footer-avatar', f.avatarUrl);
    set('dp-footer-url',    f.visitUrl);
}

// ── Dev Panel: save helpers ──────────────────────────────────────────
async function saveSection(path, data, btnId, successMsg) {
    const btn = $el(btnId);
    if (btn) { btn.textContent = 'Publicando...'; btn.disabled = true; }
    if (!_db) { toast('Sin conexión a Firebase'); if (btn) { btn.textContent = successMsg.replace('✅ ', '') + ''; btn.disabled = false; } return; }
    try {
        await set(ref(_db, path), data);
        toast(successMsg);
    } catch(e) {
        toast('Error: ' + e.message);
    }
    if (btn) { btn.textContent = btn.getAttribute('data-label') || 'Publicar'; btn.disabled = false; }
}

async function saveBoard() {
    const data = {
        titulo:       $el('dp-board-title')?.value        || '',
        tituloAccent: $el('dp-board-title-accent')?.value || 'disponible',
        descripcion:  $el('dp-board-desc')?.value         || '',
        fecha:        $el('dp-board-fecha')?.value        || '',
        tipo:         $el('dp-board-tipo')?.value         || '',
        firma:        $el('dp-board-firma')?.value        || ''
    };
    await saveSection('public/board', data, 'dp-save-board', '✅ Pizarrón publicado');
}

async function saveInfo() {
    const getSel = id => {
        const el = $el(id);
        return el ? el.options[el.selectedIndex]?.text || '' : '';
    };
    const data = {
        nombre:               $el('dp-info-nombre')?.value  || '',
        version:              $el('dp-info-version')?.value || '',
        apiStatus:            getSel('dp-info-api'),
        iaStatus:             getSel('dp-info-ia'),
        servidor:             getSel('dp-info-servidor'),
        ultimaActualizacion:  $el('dp-info-ultima')?.value  || '',
        proximaActualizacion: $el('dp-info-proxima')?.value || ''
    };
    await saveSection('public/info', data, 'dp-save-info', '✅ Información publicada');
}

async function saveNotas() {
    const items = Array.from(document.querySelectorAll('.dp-nota-row')).map(r => ({
        texto: r.querySelector('.dp-nota-texto')?.value        || '',
        fecha: r.querySelector('.dp-nota-fecha-input')?.value  || ''
    })).filter(i => i.texto.trim());
    await saveSection('public/notas', { items }, 'dp-save-notas', '✅ Notas publicadas');
}

async function saveFooter() {
    const data = {
        devName:  $el('dp-footer-name')?.value   || 'Jimmy',
        devSub:   $el('dp-footer-sub')?.value    || 'Gracias por apoyar el proyecto 🙌',
        avatarUrl: $el('dp-footer-avatar')?.value || '',
        visitUrl:  $el('dp-footer-url')?.value    || 'https://animesao.replit.app'
    };
    await saveSection('public/footer', data, 'dp-save-footer', '✅ Footer publicado');
}

// ── Dev Panel: notas editor ──────────────────────────────────────────
function renderNotasEditor(items) {
    const container = $el('dp-notas-container');
    if (!container) return;
    container.querySelectorAll('.dp-nota-row').forEach(el => el.remove());
    const addBtn = $el('dp-add-nota');
    items.forEach(item => {
        const row = makeNotaRow(item.texto, item.fecha);
        if (addBtn) container.insertBefore(row, addBtn);
    });
}

function makeNotaRow(texto = '', fecha = '') {
    const row = document.createElement('div');
    row.className = 'dp-nota-row';
    row.innerHTML = `
        <div class="dp-nota-inputs">
            <input type="text" class="dp-input dp-nota-texto" value="${texto.replace(/"/g,'&quot;')}" placeholder="Texto de la nota...">
            <input type="text" class="dp-input dp-nota-fecha-input" value="${fecha}" placeholder="DD/MM" style="width:72px;flex-shrink:0">
        </div>
        <button class="dp-nota-del" title="Eliminar">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    row.querySelector('.dp-nota-del').addEventListener('click', () => row.remove());
    return row;
}

// ── Setup ─────────────────────────────────────────────────────────────
function setup() {
    // Back button
    $el('it-back-btn')?.addEventListener('click', () => nav('view-settings'));

    // Refresh button
    $el('it-refresh-btn')?.addEventListener('click', () => InfoTableManager.refresh());

    // Panel de control button
    $el('it-panel-btn')?.addEventListener('click', () => {
        if (_auth?.currentUser) {
            openDevPanel(_auth.currentUser.email);
        } else {
            showDevLogin();
        }
    });

    // Ver todas notas
    $el('it-ver-todas-btn')?.addEventListener('click', () => {
        _showAllNotas = !_showAllNotas;
        _renderNotasList();
    });

    // Visit site
    $el('it-visit-btn')?.addEventListener('click', () => {
        window.open(_visitUrl, '_blank', 'noopener');
    });

    // Tutorials
    $el('it-tutorials-btn')?.addEventListener('click', () => toast('Tutoriales disponibles próximamente'));

    // Dev login modal
    $el('dev-login-btn')?.addEventListener('click', devLogin);
    $el('dev-login-cancel')?.addEventListener('click', hideDevLogin);
    $el('dev-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') devLogin(); });

    // Dev panel header
    $el('dp-back-btn')?.addEventListener('click', () => {
        const p = $el('dev-panel'); if (p) p.style.display = 'none';
    });
    $el('dp-logout-btn')?.addEventListener('click', devLogout);

    // Dev panel save buttons — store original labels
    const saveBtns = ['dp-save-board','dp-save-info','dp-save-notas','dp-save-footer'];
    saveBtns.forEach(id => {
        const btn = $el(id);
        if (btn) btn.setAttribute('data-label', btn.textContent.trim());
    });

    $el('dp-save-board')?.addEventListener('click',  saveBoard);
    $el('dp-save-info')?.addEventListener('click',   saveInfo);
    $el('dp-save-notas')?.addEventListener('click',  saveNotas);
    $el('dp-save-footer')?.addEventListener('click', saveFooter);

    // Add nota row
    $el('dp-add-nota')?.addEventListener('click', () => {
        const container = $el('dp-notas-container');
        const addBtn    = $el('dp-add-nota');
        const row = makeNotaRow();
        if (container && addBtn) container.insertBefore(row, addBtn);
    });
}

setup();
