// auth.js — Firebase Authentication + Cloud Profile Sync
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getDatabase, ref, set, get } from 'firebase/database';
import {
    getAuth, onAuthStateChanged,
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut as fbSignOut,
    GoogleAuthProvider, GithubAuthProvider, signInWithPopup,
    sendEmailVerification, sendPasswordResetEmail, updateProfile
} from 'firebase/auth';

const FB_CONFIG = {
    apiKey:            "AIzaSyCr1bcF_Lc1lKNoTmVYqIduwDqZIxK-mrM",
    authDomain:        "cerberusai-87db2.firebaseapp.com",
    projectId:         "cerberusai-87db2",
    storageBucket:     "cerberusai-87db2.firebasestorage.app",
    messagingSenderId: "942100846980",
    appId:             "1:942100846980:web:b1437acb40fc973a0d25d1",
    databaseURL:       "https://cerberusai-87db2-default-rtdb.firebaseio.com"
};

// ── Firebase init (reuse existing app if present) ────────────────────
let _app, _db, _auth;
try {
    _app  = getApps().find(a => a.name === 'animesao-pro') ?? initializeApp(FB_CONFIG, 'animesao-pro');
    _db   = getDatabase(_app);
    _auth = getAuth(_app);
} catch(e) { console.warn('[Auth] Firebase init:', e.message); }

const $el     = id  => document.getElementById(id);
const toast   = msg => window.showToast?.(msg);
const esc     = s   => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

let _currentUser  = null;
let _cloudProfile = null;

// ── RTDB: user data ──────────────────────────────────────────────────
async function saveUserProfile(user, extra = {}) {
    if (!_db || !user) return;
    const data = {
        displayName: user.displayName || extra.username || '',
        username:    extra.username   || user.displayName || '',
        photoURL:    user.photoURL    || '',
        email:       user.email       || '',
        updatedAt:   Date.now()
    };
    try { await set(ref(_db, `users/${user.uid}/profile`), data); } catch(_) {}
}

async function loadUserProfile(user) {
    if (!_db || !user) return null;
    try {
        const snap = await get(ref(_db, `users/${user.uid}/profile`));
        return snap.val() || null;
    } catch(_) { return null; }
}

async function savePreferences(uid) {
    if (!_db || !uid) return;
    const prefs = {
        aiPersonalization: localStorage.getItem('aiPersonalization') !== 'off',
        aiCatalogOnly:     localStorage.getItem('aiCatalogOnly')     === 'on',
        theme:             localStorage.getItem('theme')              || 'dark',
        accentColor:       localStorage.getItem('accent_color')       || '#6366f1',
        cardSize:          localStorage.getItem('card_size')          || 'normal',
        updatedAt:         Date.now()
    };
    try { await set(ref(_db, `users/${uid}/preferences`), prefs); } catch(_) {}
}

async function loadPreferences(uid) {
    if (!_db || !uid) return null;
    try {
        const snap = await get(ref(_db, `users/${uid}/preferences`));
        return snap.val() || null;
    } catch(_) { return null; }
}

function applyPreferences(prefs) {
    if (!prefs) return;
    if (prefs.theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    }
    if (prefs.accentColor) {
        document.documentElement.style.setProperty('--accent-primary', prefs.accentColor);
        localStorage.setItem('accent_color', prefs.accentColor);
    }
    if (prefs.cardSize) localStorage.setItem('card_size', prefs.cardSize);
}

// ── Settings profile card ────────────────────────────────────────────
function updateSettingsCard(user, profile) {
    const avatarEl  = $el('cfg-avatar');
    const nameEl    = document.querySelector('.cfg-profile-name');
    const subEl     = document.querySelector('.cfg-profile-sub');
    const syncEl    = $el('cfg-profile-sync');
    const btnEl     = $el('cfg-edit-profile');
    const genreWrap = $el('cfg-profile-genres');

    if (!user) {
        if (avatarEl)   avatarEl.innerHTML = ICON_USER;
        if (nameEl)     nameEl.innerHTML   = 'Cuenta';
        if (subEl)      subEl.textContent  = 'Inicia sesión para guardar tus datos en la nube';
        if (syncEl)     syncEl.style.display = 'none';
        if (btnEl)      btnEl.innerHTML    = `Acceder ${ICON_CHEVRON}`;
        if (genreWrap)  genreWrap.style.display = '';
        return;
    }

    const name     = profile?.displayName || profile?.username || user.displayName || user.email?.split('@')[0] || 'Usuario';
    const photoURL = profile?.photoURL    || user.photoURL     || '';

    if (avatarEl) {
        if (photoURL) {
            avatarEl.innerHTML = `<img src="${esc(photoURL)}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display='none'">`;
        } else {
            avatarEl.innerHTML = `<span class="cfg-avatar-initials">${esc(name.charAt(0).toUpperCase())}</span>`;
        }
    }
    if (nameEl)    nameEl.innerHTML  = `${esc(name)} <svg class="cfg-verified" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    if (subEl)     subEl.textContent = user.email || '';
    if (syncEl)  { syncEl.style.display = ''; syncEl.textContent = 'Cuenta sincronizada'; }
    if (btnEl)     btnEl.innerHTML  = `Editar ${ICON_CHEVRON}`;
    if (genreWrap) genreWrap.style.display = 'none';
}

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.8"><polyline points="9 18 15 12 9 6"/></svg>`;
const ICON_USER    = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;

// ── Auth overlay: screen management ─────────────────────────────────
const SCREENS = ['welcome','login','register','verify','account'];
let _currentScreen = 'welcome';
let _prevScreen    = 'welcome';

function show() {
    const overlay = $el('auth-overlay');
    if (!overlay) return;
    overlay.classList.add('auth-overlay--active');
    document.body.style.overflow = 'hidden';
}

function hide() {
    const overlay = $el('auth-overlay');
    if (!overlay) return;
    overlay.classList.remove('auth-overlay--active');
    document.body.style.overflow = '';
}

function showScreen(name, direction = 'forward') {
    SCREENS.forEach(s => {
        const el = $el(`auth-sc-${s}`);
        if (!el) return;
        el.classList.remove('auth-screen--active','auth-screen--slide-out-left','auth-screen--slide-out-right','auth-screen--slide-in-left','auth-screen--slide-in-right');
        if (s === name) {
            el.classList.add('auth-screen--active', direction === 'back' ? 'auth-screen--slide-in-right' : 'auth-screen--slide-in-left');
        } else if (s === _currentScreen) {
            el.classList.add(direction === 'back' ? 'auth-screen--slide-out-right' : 'auth-screen--slide-out-left');
        }
    });
    _prevScreen    = _currentScreen;
    _currentScreen = name;
}

function clearErrors() {
    [$el('auth-login-error'), $el('auth-reg-error')].forEach(el => { if (el) el.textContent = ''; });
}

function setLoading(btnId, loading, label) {
    const btn = $el(btnId);
    if (!btn) return;
    btn.disabled = loading;
    const target = btn.querySelector('span') || btn;
    if (!loading) target.textContent = label;
    else { btn.dataset.origLabel = target.textContent; target.textContent = 'Un momento...'; }
}

// ── Email / Password ─────────────────────────────────────────────────
async function loginWithEmail() {
    const email = $el('auth-login-email')?.value.trim();
    const pw    = $el('auth-login-pw')?.value;
    const errEl = $el('auth-login-error');
    if (!email || !pw) { if (errEl) errEl.textContent = 'Completa todos los campos.'; return; }
    if (!_auth) { if (errEl) errEl.textContent = 'Sin conexión con Firebase.'; return; }

    setLoading('auth-login-submit', true);
    try {
        await signInWithEmailAndPassword(_auth, email, pw);
        hide();
        clearErrors();
    } catch(e) {
        if (errEl) errEl.textContent = authErrorMsg(e.code);
    }
    setLoading('auth-login-submit', false, 'Iniciar sesión');
}

async function registerWithEmail() {
    const username = $el('auth-reg-username')?.value.trim();
    const email    = $el('auth-reg-email')?.value.trim();
    const pw       = $el('auth-reg-pw')?.value;
    const errEl    = $el('auth-reg-error');
    if (!username || !email || !pw) { if (errEl) errEl.textContent = 'Completa todos los campos.'; return; }
    if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
        if (errEl) errEl.textContent = 'La contraseña debe tener mín. 8 caracteres con letras y números.'; return;
    }
    if (!_auth) { if (errEl) errEl.textContent = 'Sin conexión con Firebase.'; return; }

    setLoading('auth-reg-submit', true);
    try {
        const cred = await createUserWithEmailAndPassword(_auth, email, pw);
        await updateProfile(cred.user, { displayName: username });
        await saveUserProfile(cred.user, { username });
        await sendEmailVerification(cred.user);
        const dispEl = $el('auth-verify-email-display');
        if (dispEl) dispEl.textContent = email;
        showScreen('verify');
    } catch(e) {
        if (errEl) errEl.textContent = authErrorMsg(e.code);
    }
    setLoading('auth-reg-submit', false, 'Crear cuenta');
}

// ── Social login ─────────────────────────────────────────────────────
async function socialLogin(providerName, errElId) {
    if (!_auth) { toast('Sin conexión con Firebase'); return; }
    const errEl    = $el(errElId);
    const provider = providerName === 'google' ? new GoogleAuthProvider() : new GithubAuthProvider();
    provider.setCustomParameters?.({ prompt: 'select_account' });
    try {
        await signInWithPopup(_auth, provider);
        hide();
        clearErrors();
    } catch(e) {
        if (e.code === 'auth/popup-closed-by-user') return;
        const msg = authErrorMsg(e.code);
        if (errEl) errEl.textContent = msg; else toast(msg);
    }
}

// ── Forgot password ──────────────────────────────────────────────────
async function sendReset() {
    const email = $el('auth-reset-email')?.value.trim() || $el('auth-login-email')?.value.trim();
    if (!email || !_auth) { toast('Introduce tu correo electrónico'); return; }
    try {
        await sendPasswordResetEmail(_auth, email);
        toast('✉️ Enlace enviado a ' + email);
        const ff = $el('auth-forgot-form'); if (ff) ff.style.display = 'none';
    } catch(e) { toast(authErrorMsg(e.code)); }
}

async function resendVerification() {
    if (!_auth?.currentUser) return;
    try { await sendEmailVerification(_auth.currentUser); toast('✉️ Correo reenviado'); } catch(_) {}
}

// ── Sign out ─────────────────────────────────────────────────────────
async function signOut() {
    if (!_auth) return;
    try {
        if (_currentUser) await savePreferences(_currentUser.uid);
        await fbSignOut(_auth);
        hide();
        toast('Sesión cerrada');
    } catch(e) { toast('Error al cerrar sesión'); }
}

// ── Error messages ───────────────────────────────────────────────────
function authErrorMsg(code) {
    const map = {
        'auth/user-not-found':          'No existe una cuenta con ese correo.',
        'auth/wrong-password':          'Contraseña incorrecta.',
        'auth/invalid-credential':      'Correo o contraseña incorrectos.',
        'auth/email-already-in-use':    'Ese correo ya está registrado.',
        'auth/invalid-email':           'El correo no es válido.',
        'auth/weak-password':           'Contraseña muy débil.',
        'auth/too-many-requests':       'Demasiados intentos. Espera un momento.',
        'auth/network-request-failed':  'Sin conexión a internet.',
        'auth/account-exists-with-different-credential': 'Ya existe una cuenta con ese correo. Inicia sesión con otro método.',
        'auth/popup-blocked':           'El navegador bloqueó la ventana. Permite ventanas emergentes.',
    };
    return map[code] || 'Ocurrió un error. Intenta de nuevo.';
}

// ── Password validation hints ────────────────────────────────────────
function validatePassword(pw) {
    const lenOk = pw.length >= 8;
    const mixOk = /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
    const hintLen = $el('auth-hint-len');
    const hintMix = $el('auth-hint-mix');
    if (hintLen) hintLen.classList.toggle('aform-hint--ok', lenOk);
    if (hintMix) hintMix.classList.toggle('aform-hint--ok', mixOk);
}

// ── Auth state listener ───────────────────────────────────────────────
if (_auth) {
    onAuthStateChanged(_auth, async (user) => {
        _currentUser = user;
        if (user) {
            _cloudProfile = await loadUserProfile(user);
            if (!_cloudProfile) {
                await saveUserProfile(user, {});
                _cloudProfile = await loadUserProfile(user);
            }
            const prefs = await loadPreferences(user.uid);
            applyPreferences(prefs);
            updateSettingsCard(user, _cloudProfile);
            Settings_updateStats?.();
        } else {
            _cloudProfile = null;
            updateSettingsCard(null, null);
            // Restore local profile card via ProfileEditor
            window.ProfileEditor?.applyToCard?.();
        }
    });
}

// Expose for script.js Settings.updateProfileStats to call
function Settings_updateStats() {
    const libEl       = $el('cfg-stat-library');
    const watchedEl   = $el('cfg-stat-watched');
    const completedEl = $el('cfg-stat-completed');
    // Still reads from local AppState (values are already in DOM via script.js)
    // Auth just ensures the card header is correct
    // Future: read from RTDB stats here
}

// ── Setup: event listeners ───────────────────────────────────────────
function setup() {
    // ── cfg-edit-profile intercept (capture phase → runs before script.js's handler) ──
    const editBtn = $el('cfg-edit-profile');
    if (editBtn) {
        editBtn.addEventListener('click', e => {
            e.stopImmediatePropagation();
            if (_currentUser) {
                // Populate account screen
                const aAvatar = $el('auth-account-avatar');
                const aName   = $el('auth-account-name');
                const aEmail  = $el('auth-account-email');
                if (aName)  aName.textContent  = _cloudProfile?.displayName || _currentUser.displayName || '';
                if (aEmail) aEmail.textContent = _currentUser.email || '';
                if (aAvatar) {
                    const p = _cloudProfile?.photoURL || _currentUser.photoURL || '';
                    aAvatar.innerHTML = p
                        ? `<img src="${esc(p)}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
                        : `<span style="font-size:28px;font-weight:700;color:#fff">${esc((_cloudProfile?.displayName || _currentUser.displayName || '?').charAt(0).toUpperCase())}</span>`;
                }
                _currentScreen = 'welcome';
                showScreen('account', 'forward');
                show();
            } else {
                _currentScreen = 'account';
                showScreen('welcome', 'forward');
                show();
            }
        }, true); // capture phase
    }

    // ── Welcome screen ──
    $el('auth-welcome-back')?.addEventListener('click', () => hide());
    $el('auth-to-login')?.addEventListener('click', () => showScreen('login'));
    $el('auth-to-register')?.addEventListener('click', () => showScreen('register'));
    $el('auth-welcome-google')?.addEventListener('click', () => socialLogin('google', null));
    $el('auth-welcome-github')?.addEventListener('click', () => socialLogin('github', null));

    // ── Login screen ──
    $el('auth-login-back')?.addEventListener('click', () => { clearErrors(); showScreen(_prevScreen, 'back'); });
    $el('auth-login-submit')?.addEventListener('click', loginWithEmail);
    $el('auth-login-pw')?.addEventListener('keydown', e => { if (e.key === 'Enter') loginWithEmail(); });
    $el('auth-login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') $el('auth-login-pw')?.focus(); });
    $el('auth-google-login')?.addEventListener('click', () => socialLogin('google', 'auth-login-error'));
    $el('auth-github-login')?.addEventListener('click', () => socialLogin('github', 'auth-login-error'));
    $el('auth-to-register-from-login')?.addEventListener('click', () => { clearErrors(); showScreen('register'); });
    $el('auth-forgot-link')?.addEventListener('click', () => {
        const ff = $el('auth-forgot-form');
        if (ff) {
            const opening = !ff.classList.contains('aform-forgot-panel--open');
            ff.classList.toggle('aform-forgot-panel--open', opening);
            if (opening) {
                const re = $el('auth-reset-email');
                if (re) re.value = $el('auth-login-email')?.value || '';
                setTimeout(() => re?.focus(), 50);
            }
        }
    });
    $el('auth-reset-send')?.addEventListener('click', sendReset);

    // ── Eye toggles ──
    $el('auth-login-eye')?.addEventListener('click', () => togglePw('auth-login-pw', 'auth-login-eye'));
    $el('auth-reg-eye')?.addEventListener('click',   () => togglePw('auth-reg-pw',   'auth-reg-eye'));

    // ── Register screen ──
    $el('auth-register-back')?.addEventListener('click', () => { clearErrors(); showScreen(_prevScreen, 'back'); });
    $el('auth-reg-submit')?.addEventListener('click', registerWithEmail);
    $el('auth-reg-pw')?.addEventListener('input', e => validatePassword(e.target.value));
    $el('auth-google-register')?.addEventListener('click', () => socialLogin('google', 'auth-reg-error'));
    $el('auth-github-register')?.addEventListener('click', () => socialLogin('github', 'auth-reg-error'));
    $el('auth-to-login-from-register')?.addEventListener('click', () => { clearErrors(); showScreen('login', 'back'); });

    // ── Verify screen ──
    $el('auth-verify-back')?.addEventListener('click', () => { clearErrors(); showScreen('register', 'back'); });
    $el('auth-resend-link')?.addEventListener('click', resendVerification);
    $el('auth-verify-continue')?.addEventListener('click', () => { hide(); clearErrors(); });

    // ── Account screen ──
    $el('auth-account-back')?.addEventListener('click', () => hide());
    $el('auth-account-edit')?.addEventListener('click', () => { hide(); window.ProfileEditor?.open?.(); });
    $el('auth-sign-out')?.addEventListener('click', signOut);

    // ── Close on backdrop (welcome screen only) ──
    $el('auth-overlay')?.addEventListener('click', e => {
        if (e.target === $el('auth-overlay') && _currentScreen === 'welcome') hide();
    });
}

function togglePw(inputId, btnId) {
    const inp = $el(inputId);
    const btn = $el(btnId);
    if (!inp) return;
    const shown = inp.type === 'text';
    inp.type = shown ? 'password' : 'text';
    if (btn) btn.innerHTML = shown ? ICON_EYE_OPEN : ICON_EYE_CLOSED;
}

const ICON_EYE_OPEN   = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_CLOSED = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

setup();

// ── AuthManager: public API ───────────────────────────────────────────
const AuthManager = {
    open()            { _currentScreen = 'account'; showScreen('welcome', 'forward'); show(); },
    isAuthenticated() { return !!_currentUser; },
    currentUser()     { return _currentUser; },
    refreshCard()     { updateSettingsCard(_currentUser, _cloudProfile); }
};
window.AuthManager = AuthManager;
