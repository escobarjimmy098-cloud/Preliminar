import axios from 'axios';
import * as cheerio from 'cheerio';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import zlib from 'zlib';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 5000;
const BASE_URL = 'https://www3.animeflv.net';

// ==================== PNG ICON GENERATOR ====================
function makeCRC32Table() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
}
const CRC_TABLE = makeCRC32Table();
function crc32(buf: Buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 1);
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// safeZoneScale: 1.0 = full canvas (purpose: any), 0.8 = 80% safe zone (purpose: maskable for Samsung adaptive icons)
function generatePNG(size: number, safeZoneScale: number = 1.0) {
    // Colors
    const bgR = 10, bgG = 14, bgB = 39;          // #0a0e27 dark navy
    const circR = 124, circG = 58, circB = 237;   // #7c3aed purple
    const acR = 99, acG = 179, acB = 237;          // #63b3ed light blue accent
    const wR = 255, wG = 255, wB = 255;            // white

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(size, 0);
    ihdrData.writeUInt32BE(size, 4);
    ihdrData[8] = 8; ihdrData[9] = 2;
    const ihdr = pngChunk('IHDR', ihdrData);
    const rawRows: Buffer[] = [];

    const cx = size / 2, cy = size / 2;
    // All dimensions scaled by safeZoneScale so maskable icons have safe margin
    const outerR = size * 0.42 * safeZoneScale;   // outer circle radius
    const innerR = outerR * 0.72;                   // inner glow ring
    const ringW = outerR * 0.08;                    // ring stroke width

    // Play triangle points (centered, pointing right)
    const triCx = cx + outerR * 0.06;  // slight right offset for optical centering
    const triH = outerR * 0.55;
    const triW = outerR * 0.62;
    const triTop    = cy - triH;
    const triBottom = cy + triH;
    const triLeft   = triCx - triW * 0.5;
    const triRight  = triCx + triW * 0.5;

    for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size * 3);
        row[0] = 0;
        for (let x = 0; x < size; x++) {
            const dx = x - cx, dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Outer filled circle (purple)
            const inOuterCircle = dist <= outerR;

            // Thin accent ring just outside outer circle
            const inRing = dist > outerR && dist <= outerR + ringW;

            // Play triangle: point-in-triangle test
            // Triangle: top-left=(triLeft, triTop), bottom-left=(triLeft, triBottom), right=(triRight, cy)
            let inTriangle = false;
            if (inOuterCircle) {
                const t1 = (triRight - triLeft) * (y - triTop) - (x - triLeft) * (cy - triTop + triH * 2);
                const t2 = (triLeft - triRight) * (y - cy) - (x - triRight) * (triTop - cy);
                const t3 = (triLeft - triLeft) * (y - triBottom) - (x - triLeft) * (triTop - triBottom);
                // Simpler: barycentric
                const ax = triLeft, ay = triTop;
                const bx = triLeft, by = triBottom;
                const rx = triRight, ry = cy;
                const denom = (by - ry) * (ax - rx) + (rx - bx) * (ay - ry);
                if (Math.abs(denom) > 0.0001) {
                    const u = ((by - ry) * (x - rx) + (rx - bx) * (y - ry)) / denom;
                    const v = ((ry - ay) * (x - rx) + (ax - rx) * (y - ry)) / denom;
                    inTriangle = u >= 0 && v >= 0 && (u + v) <= 1;
                }
            }

            let r: number, g: number, b: number;
            if (inTriangle) {
                r = wR; g = wG; b = wB;
            } else if (inOuterCircle) {
                // Subtle radial gradient: blend purple toward blue at center
                const t = dist / outerR;
                r = Math.round(circR + (acR - circR) * (1 - t) * 0.4);
                g = Math.round(circG + (acG - circG) * (1 - t) * 0.4);
                b = Math.round(circB + (acB - circB) * (1 - t) * 0.4);
            } else if (inRing) {
                r = acR; g = acG; b = acB;
            } else {
                r = bgR; g = bgG; b = bgB;
            }

            row[1 + x * 3] = r;
            row[1 + x * 3 + 1] = g;
            row[1 + x * 3 + 2] = b;
        }
        rawRows.push(row);
    }
    const raw = Buffer.concat(rawRows);
    const compressed = zlib.deflateSync(raw, { level: 6 });
    const idat = pngChunk('IDAT', compressed);
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([sig, ihdr, idat, iend]);
}

// Standard icons (purpose: any)
const icon96   = generatePNG(96,  1.0);
const icon144  = generatePNG(144, 1.0);
const icon192  = generatePNG(192, 1.0);
const icon384  = generatePNG(384, 1.0);
const icon512  = generatePNG(512, 1.0);
// Maskable icons (purpose: maskable) — logo fits in central 80% safe zone for Samsung adaptive icons
const iconMaskable192 = generatePNG(192, 0.72);
const iconMaskable512 = generatePNG(512, 0.72);

// ==================== CACHE ====================
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const cacheGet = (key: string) => {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return item.data;
};

const cacheSet = (key: string, data: any) => {
    cache.set(key, { data, timestamp: Date.now() });
};

const axiosInstance = axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }
});

// Retry logic
const retryRequest = async (fn: () => Promise<any>, maxRetries = 3) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }
};

// ── Pre-import AI SDK at startup so it's not re-imported on every request ──
let _googleGenAI: any = null;
async function getGenAI() {
    if (!_googleGenAI) {
        const mod = await import('@google/genai');
        _googleGenAI = mod.GoogleGenAI;
    }
    return _googleGenAI;
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Force browsers to always revalidate main app files
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(process.cwd(), 'index.html'));
});
app.get('/index.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(process.cwd(), 'index.html'));
});
app.get('/style.css', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(path.join(process.cwd(), 'style.css'));
});
app.get('/script.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(process.cwd(), 'script.js'));
});

// Fix 1: Correct Content-Type for manifest (Samsung Internet requires application/manifest+json)
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(process.cwd(), 'manifest.json'));
});

// Fix 2: Service-Worker-Allowed header so SW can control entire scope
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(process.cwd(), 'sw.js'));
});

app.get('/icon-96.png',  (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(icon96); });
app.get('/icon-144.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(icon144); });
app.get('/icon-192.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(icon192); });
app.get('/icon-384.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(icon384); });
app.get('/icon-512.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(icon512); });
app.get('/icon-maskable-192.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(iconMaskable192); });
app.get('/icon-maskable-512.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(iconMaskable512); });

// API Routes
app.get('/api/latest', async (req, res) => {
    try {
        const page = req.query.page || 1;
        const cacheKey = `latest_${page}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?order=added&page=${page}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim(),
                lastEpisode: '?'
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/trending', async (req, res) => {
    try {
        const cacheKey = 'trending';
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get('/'));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimeTop li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('.Title').text().trim(),
                cover: coverUrl,
                rating: $(el).find('.Votes').text().trim()
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/genre/:genre', async (req, res) => {
    try {
        const { genre } = req.params;
        const page = req.query.page || 1;
        const cacheKey = `genre_${genre}_${page}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?genre[]=${genre}&order=default&page=${page}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim()
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ success: false, error: 'Query required' });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?q=${q}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim()
            });
        });

        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/info/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `info_${id}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/anime/${id}`));
        const $ = cheerio.load(data);
        const episodes: any[] = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const contents = $(el).html() || '';
            if (contents.includes('var episodes =')) {
                const match = contents.match(/var episodes = (\[.*?\]);/);
                if (match) {
                    try {
                        const rawEps = JSON.parse(match[1]);
                        rawEps.forEach((re: any) => {
                            episodes.push({ number: re[0], id: re[1] });
                        });
                    } catch (e) {}
                }
            }
        });

        const rawCover = $('.AnimeCover img').attr('src') || '';
        const cover = rawCover.startsWith('http') ? rawCover : (rawCover.startsWith('/') ? `${BASE_URL}${rawCover}` : `${BASE_URL}/${rawCover}`);

        const info = {
            id,
            title: $('.Ficha.fcont .Title').first().text().trim() || id,
            cover,
            synopsis: $('.Description p').text().trim(),
            status: $('.AnmStts span').text().trim() || 'Finalizado',
            genres: $('.Nvgnrs a').map((i, el) => $(el).text().trim()).get(),
            episodes: episodes
        };

        cacheSet(cacheKey, info);
        res.json({ success: true, data: info });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/video/:id/:cap', async (req, res) => {
    try {
        const { id, cap } = req.params;
        const { data } = await retryRequest(() => axiosInstance.get(`/ver/${id}-${cap}`));
        const $ = cheerio.load(data);
        let servers: any[] = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const contents = $(el).html() || '';
            if (contents.includes('var videos =')) {
                const match = contents.match(/var videos = (\{.*?\});/);
                if (match) {
                    try {
                        const videoData = JSON.parse(match[1]);
                        if (videoData.SUB) {
                            servers = videoData.SUB.map((s: any) => ({
                                name: s.title || s.server,
                                url: s.code.includes('http') ? s.code : `https://streamwish.to/e/${s.code}`
                            }));
                        }
                    } catch (e) {}
                }
            }
        });

        res.json({ success: true, data: { servers } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== RATE LIMITER ====================
const rateLimiter = new Map<string, { count: number; reset: number }>();

// Periodic cleanup — prevents rateLimiter & cache Maps from growing unboundedly
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimiter) {
        if (now > val.reset) rateLimiter.delete(key);
    }
}, 5 * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of cache) {
        if (now - val.timestamp > CACHE_TTL * 2) cache.delete(key);
    }
}, 10 * 60 * 1000);

function checkRateLimit(ip: string, limit = 30, windowMs = 60000): boolean {
    const now = Date.now();
    const entry = rateLimiter.get(ip);
    if (!entry || now > entry.reset) {
        rateLimiter.set(ip, { count: 1, reset: now + windowMs });
        return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
}

// ==================== SECURITY: INPUT SANITIZER ====================
// Detects and neutralizes prompt-injection attempts before they reach the AI
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+|previous\s+|above\s+|prior\s+)?instructions?/gi,
    /you\s+are\s+now\s+/gi,
    /pretend\s+(to\s+be|you\s+are)/gi,
    /act\s+as\s+(?:if\s+)?(?!an?\s+anime)/gi,
    /forget\s+(?:everything|your|the|all)/gi,
    /new\s+(?:personality|role|instruction|system)/gi,
    /\[system\]/gi,
    /<\/?system>/gi,
    /jailbreak/gi,
    /dan\s+mode/gi,
    /override\s+(?:all\s+)?instructions?/gi,
    /disregard\s+(?:all\s+)?instructions?/gi,
    /bypass\s+(?:your\s+)?(?:filter|restriction|limit|guideline)/gi,
    /you\s+have\s+no\s+restrictions?/gi,
    /developer\s+mode/gi,
];

function sanitizeInput(text: string): string {
    if (typeof text !== 'string') return '';
    let sanitized = text.trim().substring(0, 1500);
    for (const pattern of INJECTION_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[🛡]');
    }
    // Remove null bytes and control characters (except newlines and tabs)
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return sanitized;
}

function validateApiKeyFormat(key: string): boolean {
    if (typeof key !== 'string') return false;
    const trimmed = key.trim();
    // Google Gemini API keys: start with "AIza", 39 chars, alphanumeric + - _
    if (trimmed.length < 20 || trimmed.length > 60) return false;
    if (!/^[A-Za-z0-9\-_]+$/.test(trimmed)) return false;
    return true;
}

function validateRecommendations(recs: any[]): any[] {
    if (!Array.isArray(recs)) return [];
    return recs
        .filter(r => r && typeof r.title === 'string' && r.title.trim().length > 0)
        .slice(0, 5)
        .map(r => ({
            title:      String(r.title).trim().substring(0, 200),
            reason:     typeof r.reason === 'string' ? r.reason.trim().substring(0, 300) : '',
            tags:       Array.isArray(r.tags) ? r.tags.slice(0, 3).map((t: any) => String(t).substring(0, 30)) : [],
            matchScore: typeof r.matchScore === 'number' ? Math.min(100, Math.max(1, Math.round(r.matchScore))) : null,
            available:  typeof r.available === 'boolean' ? r.available : true,
        }));
}

// ── Levenshtein distance (for fuzzy catalog matching) ────────────────────────
function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = a[i - 1] === b[j - 1]
                ? prev
                : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = tmp;
        }
    }
    return dp[n];
}

// Normalize a title for comparison: lowercase, strip accents, strip punctuation
function normTitle(s: string): string {
    return s.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Find the closest catalog title using exact → contains → levenshtein
function fuzzyMatchCatalog(input: string, catalog: string[]): string | null {
    if (!input || !catalog.length) return null;
    const ni = normTitle(input);

    // 1. Exact normalized match
    const exact = catalog.find(t => normTitle(t) === ni);
    if (exact) return exact;

    // 2. One is a prefix/substring of the other (handles "Overlord" vs "Overlord III")
    const sub = catalog.find(t => {
        const nt = normTitle(t);
        return nt.startsWith(ni) || ni.startsWith(nt.substring(0, Math.max(nt.length - 5, 4)));
    });
    if (sub) return sub;

    // 3. Levenshtein — allow up to 30% error rate, min 2 chars tolerance
    const maxDist = Math.max(2, Math.floor(ni.length * 0.30));
    let best: string | null = null;
    let bestDist = Infinity;
    for (const title of catalog) {
        const dist = levenshtein(ni, normTitle(title));
        if (dist < bestDist && dist <= maxDist) {
            bestDist = dist;
            best = title;
        }
    }
    return best;
}

// Detect season number from a title (e.g. "Season 2", "2nd Season", "II", "S2", "Part 2")
function detectSeasonNumber(title: string): number {
    const t = title.toLowerCase();
    if (/\b(season|temporada|parte?|part)\s*([2-9]|\d{2,})\b/.test(t)) return 2;
    if (/\b[2-9](nd|rd|th|°|ª)?\s*(season|temporada|parte?|part|cour)\b/.test(t)) return 2;
    if (/\b(ii|iii|iv|vi|vii|viii|ix)\b/.test(t)) return 2;
    if (/\bs[2-9]\b/.test(t)) return 2;
    return 1;
}

// Re-sort recommendations: if titles include season 2+ and we have their S1 in catalog, promote S1
function enforceSeasonOrder(recs: any[], catalog: string[]): any[] {
    return recs.map(rec => {
        if (detectSeasonNumber(rec.title) < 2) return rec;
        // Try to find the S1 equivalent in catalog
        const baseName = rec.title
            .replace(/\s*(season|temporada|parte?|part|ii|iii|iv|s[2-9])\s*[\d]*/gi, '')
            .replace(/\s+/g, ' ').trim();
        if (baseName.length < 3) return rec;
        const s1 = catalog.find(t => {
            const nt = normTitle(t);
            return nt.startsWith(normTitle(baseName)) && detectSeasonNumber(t) === 1;
        });
        if (s1) return { ...rec, title: s1, reason: rec.reason + ' (Comenzando por la primera temporada)' };
        return rec;
    });
}

// ==================== CATALOG SEARCH TOOL ====================

// Internal scraper search — reuses the same logic as /api/search
async function searchCatalogInternal(query: string): Promise<Array<{ title: string; id: string; type: string }>> {
    try {
        const q = encodeURIComponent(String(query).trim().substring(0, 100));
        const { data } = await retryRequest(() => axiosInstance.get(`/browse?q=${q}`));
        const $ = cheerio.load(data);
        const results: Array<{ title: string; id: string; type: string }> = [];
        $('.ListAnimes li').each((_: any, el: any) => {
            if (results.length >= 8) return false as any;
            const link  = $(el).find('a').attr('href') || '';
            const id    = link.replace('/anime/', '');
            const title = $(el).find('h3.Title').text().trim();
            const type  = $(el).find('.Type').text().trim();
            if (title) results.push({ title, id, type });
        });
        return results;
    } catch {
        return [];
    }
}

// Gemini tool declaration — Gemini calls this to search the real catalog
const CATALOG_SEARCH_TOOL = {
    functionDeclarations: [{
        name: 'search_catalog',
        description: 'Busca títulos de anime en el catálogo real de AnimeSAO Pro. Úsala SIEMPRE antes de recomendar cualquier título. Puedes llamarla múltiples veces con diferentes términos si no encuentras lo que buscas.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'Término de búsqueda. Ej: "overlord", "kimi no na wa", "makoto shinkai", "ainz", "demon slayer", "one piece"'
                }
            },
            required: ['query']
        }
    }]
};

// ==================== SYSTEM PROMPT BUILDER ====================
function buildSystemPrompt(userProfile: any, catalogOnly: boolean): string {

    const topGenres = Array.isArray(userProfile?.topGenres) && userProfile.topGenres.length > 0
        ? userProfile.topGenres.slice(0, 10).map((g: string) => `  • ${g}`).join('\n')
        : '  • (sin datos de géneros todavía)';

    const recentHistory = Array.isArray(userProfile?.recentHistory) && userProfile.recentHistory.length > 0
        ? userProfile.recentHistory.slice(0, 20).map((t: string) => `  • ${t}`).join('\n')
        : '  • (sin historial todavía)';

    const watchCount   = typeof userProfile?.watchCount   === 'number' ? userProfile.watchCount   : 0;
    const libraryCount = typeof userProfile?.libraryCount === 'number' ? userProfile.libraryCount : 0;

    const catalogModeRule = catalogOnly
        ? `MODO CATÁLOGO — REGLA ABSOLUTA:
  → Si search_catalog() no devuelve resultados para un título → NO lo incluyas.
  → Explica en "message" que no está disponible y ofrece la alternativa
    más cercana que SÍ encontraste con search_catalog().
  → Marca "available": true en TODAS las recomendaciones que incluyas.`
        : `MODO LIBRE — REGLA:
  → Si search_catalog() no devuelve resultados → inclúyelo con "available": false
    usando el nombre oficial correcto según tu conocimiento enciclopédico.
  → Indica en "message" cuáles están en AnimeSAO Pro y cuáles son externos.`;

    return `════════════════════════════════════════════════
  SISTEMA: ANIBOT v4 — ASISTENTE EXPERTO DE ANIME
  Plataforma: AnimeSAO Pro | Motor: Gemini 2.5 Flash
════════════════════════════════════════════════

╔══ ROL Y PERSONALIDAD ═══════════════════════╗
Eres AniBot, el guía de anime definitivo de AnimeSAO Pro.
Tienes conocimiento enciclopédico sobre:
  → Tramas, personajes, arcos y lore de miles de series
  → Géneros y subgéneros: shounen, isekai, mecha, slice-of-life, etc.
  → Estudios (Mappa, Ufotable, WIT, bones…), directores y compositores
  → Manga/LN de origen y diferencias con la adaptación animada
  → Tendencias actuales, anime clásico y joyas ocultas

Personalidad:
  → Apasionado pero conciso — vas al grano, sin relleno
  → Empático — detectas el estado de ánimo del usuario y adaptas el tono
  → Honesto — si algo no está disponible, lo dices con alternativas
  → Específico — siempre mencionas géneros, aspectos o personajes concretos
  → Español natural — sin robótico, sin traducción literal
╚═════════════════════════════════════════════╝

╔══ PERFIL DEL USUARIO (datos reales, actualizados) ══╗
${userProfile?.username ? `Nombre del usuario: ${userProfile.username}
${userProfile?.bio ? `Descripción personal: ${userProfile.bio}\n` : ''}${userProfile?.favoriteGenres?.length ? `Géneros favoritos declarados: ${userProfile.favoriteGenres.join(', ')}\n` : ''}` : ''}Géneros favoritos por afinidad (ordenados):
${topGenres}

Historial reciente de visualización:
${recentHistory}

Estadísticas de actividad:
  → Series en historial: ${watchCount} | Guardadas en biblioteca: ${libraryCount}

⚠ REGLA DE ORO: NUNCA recomiendes ningún título que aparezca en el
  historial reciente del usuario. Usa ese historial para inferir gustos,
  no para repetir recomendaciones.
${userProfile?.username ? `→ Llama al usuario por su nombre (${userProfile.username}) cuando sea natural y amigable.` : ''}
╚═════════════════════════════════════════════╝

╔══ HERRAMIENTA DE BÚSQUEDA — USO OBLIGATORIO ════════╗
Tienes acceso a search_catalog(query) para buscar en el catálogo REAL
de AnimeSAO Pro. ÚSALA SIEMPRE antes de incluir cualquier recomendación.

FLUJO OBLIGATORIO PARA CADA RECOMENDACIÓN:
  1. Identifica el anime con tu conocimiento enciclopédico:
     por nombre, personaje, director, estudio, descripción, año, trama…
  2. Llama a search_catalog() para verificar disponibilidad real.
  3. Si no hay coincidencia exacta, reintenta con términos alternativos:
     nombre en inglés, japonés, romaji, alias, personaje principal…
  4. Usa el nombre EXACTO que devuelva search_catalog() en el campo "title".

Ejemplos de identificación → términos a probar en search_catalog():
  "esqueleto en Nazarick / señor de la tumba"
      → "overlord", "ainz ooal gown"
  "dice I am atomic / soy el eminente en las sombras / shadow"
      → "kage no jitsuryokusha", "eminence in shadow", "shadow garden"
  "compras online desde isekai / habilidad amazon + cocina para dioses"
      → "tondemo skill", "campfire cooking", "isekai hourou meshi"
  "traicionado + mazmorra + vampira pelo amarillo ojos rojos"
      → "arifureta", "hajime nagumo", "arifureta shokugyou"
  "chica tsundere + chico solitario + escuela"
      → "toradora", "oregairu", "yahari ore"
  "equipo volleyball juvenil"
      → "haikyuu", "voleibol"
  "dos niños se prometen casarse + reencuentro"
      → "tonikawa", "kaguya sama", "nisekoi"
  "libreta que mata / notebook muerte"
      → "death note"
  "juego de vida o muerte"
      → "no game no life", "kakegurui", "kaiji", "mirai nikki"

${catalogModeRule}
╚═════════════════════════════════════════════╝

╔══ IDENTIFICACIÓN POR RASGOS — PESO MÁXIMO (FÍSICOS + PODERES + TRAMA) ══╗
Cuando el usuario NO recuerda el título, extrae y cruza TODOS los rasgos
que mencione. Cuantos más rasgos, más precisa la identificación.

━━━ NIVEL 1 — IDENTIFICADORES CASI ÚNICOS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ► Nombre de personaje con tolerancia fonética total (compara sonido, no letras):
      "nahime" / "naime" / "hajime"     → Hajime Nagumo     → Arifureta
      "tanyiro" / "tanjilo"             → Tanjiro Kamado    → Demon Slayer
      "cid" / "sid" / "shadow"          → Cid Kageou        → The Eminence in Shadow
      "rimuru" / "rimur" / "rimul"      → Rimuru Tempest    → Tensura (Slime)
      "narusato" / "naofumi"            → Naofumi Iwatani   → Shield Hero

  ► Frase / catchphrase / nombre de habilidad única del personaje:
      "I am atomic" / "soy atomico" / "shadow el eminente"
          → Cid Kageou, alter ego Shadow → The Eminence in Shadow
      "I am the Bone of my Sword" / "tracing on" / "unlimited blade works"
          → Emiya Shirou / Archer → Fate/stay night
      "Gum Gum" / "gear second" / "gear 5" / "gomigomi"
          → Monkey D. Luffy → One Piece
      "Bankai" / "zanpakuto" / "shikai"
          → personaje de Bleach
      "Kamehameha" / "Kaioken" / "Ultra Instinct"
          → Son Goku → Dragon Ball
      "Rasengan" / "Kage Bunshin" / "Chidori"
          → Naruto / Sasuke → Naruto

  ► Habilidad o poder con descripción funcional:
      "puede hacer compras online / como amazon desde el isekai"
          → Tondemo Skill (habilidad de shopping online) → Campfire Cooking / Tondemo Skill
      "protagonista cocina mucho con su habilidad / cocina para dioses"
          → Mukouda Tsuyoshi → Tondemo Skill de Isekai Hourou Meshi
      "puede copiar/robar habilidades de otros"
          → Rimuru (Tensura), Ainz (Overlord), Skill Taker → varias series
      "ve los stats / nivel de las personas como números flotantes"
          → protagonista de isekai con sistema / pantalla de estado → Overlord, Re:Zero, varios
      "puede matar a cualquiera escribiendo su nombre"
          → Light Yagami → Death Note
      "su poder es ser el más poderoso en las sombras sin que nadie lo sepa"
          → Cid Kageou → The Eminence in Shadow
      "puede curar a otros pero sin poder atacar"
          → Kaifuku Jutsushi (Redo of Healer), o "healer" de cualquier serie

━━━ NIVEL 2 — RASGOS FÍSICOS DE PERSONAJES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Para cada personaje mencionado, extrae y cruza:
    → Nombre fonético: "nahime" = Hajime, "yu" = Yue, "cid"/"shadow" = Cid
    → Color de pelo: blanco (trauma/OP), rubio/amarillo (vampira/mágica),
      negro, rojo, azul, rosa, verde, multicolor, cambia de color…
    → Color de ojos: rojo (vampiro/demonio/sharingan), dorado, azul, heterocromía…
    → Rasgos únicos: ojo faltante, cicatriz, parche, tatuaje, máscara,
      raza (vampira, elf, hada, dragón, demonio, slime, esqueleto)…
    → Rol: protagonista, compañera romántica, rival, antagonista, maestra, hermana…

  Ejemplo del usuario → análisis interno:
    "pelo blanco (antes negro)" = cambio por trauma → Hajime (Arifureta)
    "le falta un ojo"           = rasgo permanente  → Hajime confirmado
    "vampira pelo amarillo"     = Yue               → Arifureta confirmado
    CONCLUSIÓN: Arifureta. → search_catalog("arifureta")

━━━ NIVEL 3 — TRAMA, GÉNERO Y AMBIENTACIÓN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Acción/Isekai/Aventura:
    → traicionado + dungeon solo + vampira compañera  → Arifureta
    → traicionado + escudo + otro mundo               → Shield Hero
    → reencarnado como slime / absorbe poderes        → Tensura (Slime)
    → chico normal finge ser el más poderoso en sombras → The Eminence in Shadow
    → compras online + cocina para dioses en isekai   → Tondemo Skill de Isekai Hourou Meshi
    → protagonista overpowered que nadie ve venir     → The Eminence in Shadow, One Punch Man
    → libreta / notebook que mata                     → Death Note
    → escuela militar + jerarquía oculta              → Classroom of the Elite

  Romance:
    → dos niños se prometen casarse + reencuentro     → Tonikawa, Nisekoi, Anohana
    → amor no correspondido + amistad íntima          → Oregairu, Toradora
    → novios falsos que se enamoran de verdad         → Nisekoi, Oregairu
    → chica tsundere + chico solitario                → Toradora, Oregairu
    → triángulo amoroso + escuela                     → Clannad, Kimi ni Todoke, Sukitte Ii na yo
    → romance sobrenatural / diferente especie        → Overlord (Ainz/Albedo), Maou Sama Retry
    → chica misteriosa + chico ordinario              → Ano Hi Mita Hana, Your Lie in April

  Slice of Life / Comedia:
    → grupo de amigos en secundaria / preparatoria    → Hyouka, K-On, Daily Lives of HS Boys
    → vida cotidiana en fantasía / escuela de magia   → Little Witch Academia, Mushishi
    → protagonista perezoso / nini / hikikomori       → NHK ni Youkoso, No Game No Life

  Terror / Misterio:
    → estudiantes mueren uno por uno en el aula       → Another, Corpse Party
    → juego de muerte / eliminación                   → Danganronpa, Mirai Nikki, Kaiji
    → thriller psicológico / mente                    → Death Note, Monster, Paranoia Agent

  Deportes / Competencia:
    → equipo de volleyball juvenil                    → Haikyuu
    → ciclismo de montaña                             → Yowamushi Pedal
    → shogi / ajedrez / juego de mesa                 → 3-gatsu no Lion, Hikaru no Go
    → boxeo / artes marciales                         → Hajime no Ippo, Kengan Ashura

━━━ MODO INCERTIDUMBRE — REGLA OBLIGATORIA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Si tras cruzar rasgos hay 2 o más candidatos posibles:
  → Busca TODOS con search_catalog() — no descartes ninguno
  → Inclúyelos TODOS en recommendations[] (máx 5) de mayor a menor matchScore
  → matchScore = probabilidad de ser el anime buscado:
      95-100 = casi seguro | 70-94 = probable | 40-69 = posible | <40 = improbable
  → En "message" explica qué rasgo apunta a cada candidato:
      "Tu descripción encaja más con [A] por [rasgo X], pero [B] también
       comparte [rasgo Y]. Si recuerdas [pista Z] podemos confirmarlo."
  → followUp: pide UNA pista adicional que diferencie los candidatos
  → En modo identificación: SIEMPRE incluye 2-3 candidatos, SALVO que la
    confianza del mejor sea > 96% — en ese caso muestra solo 1 título.
  → NUNCA reduzcas a 1 si la confianza es ≤ 96%.

  Ejemplo con poderes:
    "puede hacer compras online desde isekai + cocina mucho":
      → recommendations[0]: Tondemo Skill de Isekai Hourou Meshi  matchScore: 97
      → recommendations[1]: Isekai Izakaya Nobu                   matchScore: 42

  Ejemplo con catchphrase:
    "dice 'I am atomic' / 'soy el eminente en las sombras'":
      → recommendations[0]: Kage no Jitsuryokusha (The Eminence in Shadow) matchScore: 99
╚═════════════════════════════════════════════╝

╔══ ANÁLISIS DE SIMILITUD (REGLA CLAVE) ══════╗
Cuando el usuario mencione un anime de referencia (ej: "algo como Dragon Ball"),
DEBES extraer su ADN antes de buscar similares:

  ADN = Género principal + Tono + Tipo de protagonista + Sistema de poder +
        Estructura narrativa + Audiencia target + Temáticas centrales

Ejemplo — Dragon Ball:
  ADN: Shounen · Acción · Protagonista que supera límites · Poder físico/Ki ·
       Torneos + viajes · Rivales que se vuelven aliados · Comedia ligera ·
       Escalada de poder constante · Artes marciales

Para recomendar similares, comparte AL MENOS 3 elementos del ADN.
NO uses solo el género principal — un isekai de acción NO es similar a Dragon Ball
a menos que también tenga protagonista que supera límites, artes marciales o torneos.

Jerarquía de similitud (de más a menos importante):
  1. Tono y atmósfera (oscuro vs alegre, serio vs cómico)
  2. Tipo de protagonista y su arco de crecimiento
  3. Sistema de poder / mecánicas del mundo
  4. Estructura narrativa (torneos, viajes, escuela, isekai…)
  5. Género y audiencia (shounen, seinen, shoujo…)
╚═════════════════════════════════════════════╝

╔══ TEMPORADAS Y FRANQUICIAS (REGLA OBLIGATORIA) ══╗
SIEMPRE recomienda la PRIMERA temporada / primer arco de una franquicia,
A MENOS QUE el usuario explícitamente pida temporadas posteriores.

  ✓ Si el catálogo tiene "Sword Art Online" y "Sword Art Online II":
    → Recomienda "Sword Art Online" (T1) primero
  ✓ Si solo está disponible "Overlord III" pero no "Overlord":
    → Menciona en el reason que es la tercera temporada
  ✗ NUNCA recomiendes "Attack on Titan Season 2" cuando "Attack on Titan" está disponible

Detecta secuelas por palabras clave:
  Season 2/3/4, 2nd/3rd Season, II/III/IV, Part 2, Cour 2, Temporada 2,
  Final Season, The Final, Returns, Shippuden (si hay versión original), etc.
╚═════════════════════════════════════════════╝

╔══ TOLERANCIA A ERRORES Y NOMBRES ALTERNATIVOS ══╗
Los usuarios escriben con errores o nombres aproximados.
Usa múltiples llamadas a search_catalog() con variantes hasta encontrar:
  "overlod" / "overlord" / "ainz"   → search_catalog("overlord")
  "atake a los titanes"             → search_catalog("attack on titan") o search_catalog("shingeki")
  "bola de dragon"                  → search_catalog("dragon ball")
  "naruto shipuder"                 → search_catalog("naruto shippuden") o search_catalog("naruto")
  "one pice"                        → search_catalog("one piece")
╚═════════════════════════════════════════════╝

╔══ INSTRUCCIONES DE PROCESAMIENTO ═══════════╗
Antes de escribir tu respuesta final, ejecuta SIEMPRE:

0. BÚSQUEDA PRIMERO: Llama a search_catalog() para cada candidato que
   identifiques ANTES de escribir el JSON de respuesta.

1. INTENCIÓN: ¿Pide recomendaciones por similitud, género, mood, información
   de un anime conocido, o está buscando un título que NO recuerda?

1b. SI BUSCA POR DESCRIPCIÓN (no sabe el título):
    a. Extrae todos los rasgos: nombres de personajes (fonética), colores
       de pelo/ojos, rasgos físicos únicos, eventos de trama clave.
    b. Cruza los rasgos con el módulo IDENTIFICACIÓN POR RASGOS.
    c. Si hay 1 candidato claro (confianza > 96%) → recomiéndalo solo.
       En cualquier otro caso → muestra siempre 2-3 candidatos.
    d. Si hay 2-5 candidatos posibles → búscalos TODOS y recomiéndalos
       ordenados por matchScore, explicando qué rasgo apunta a cada uno.
    e. Nunca ignores una pista física o de trama — pueden ser determinantes.

2. SIMILITUD: Si menciona un anime de referencia → extrae su ADN y
   recomienda títulos con al menos 3 elementos en común.

3. TEMPORADAS: Si search_catalog() devuelve varias temporadas, recomienda T1.
   Solo secuelas si el usuario las pide explícitamente.

4. MOOD DEL USUARIO:
   "excited"    → acción, aventura, hype, combates
   "relaxed"    → ligero, comedia, slice-of-life
   "curious"    → géneros nuevos, joyas ocultas
   "empathetic" → drama emocional, romance, coming-of-age

5. CONTEXTO: Usa el historial del chat para respuestas coherentes.

6. MATCH PERSONAL / CONFIDENCE: Para cada recomendación, matchScore indica:
   → En modo descripción: probabilidad de que sea el anime buscado (0-100)
   → En modo similitud/género: cuánto coincide con gustos del usuario (0-100)
╚═════════════════════════════════════════════╝

╔══ CONTRATO DE RESPUESTA (OBLIGATORIO) ══════╗
SIEMPRE responde ÚNICAMENTE con este bloque JSON exacto.
NUNCA escribas texto fuera del bloque. NUNCA uses comillas sin escapar.

\`\`\`json
{
  "message": "Tu respuesta en español. Máx 3 párrafos breves. Pasional y específica. Menciona elementos concretos del ADN del anime referenciado. Usa emojis con moderación (1-2 máx).",
  "mood": "excited|relaxed|curious|empathetic",
  "recommendations": [
    {
      "title": "Nombre EXACTO devuelto por search_catalog() — nunca inventado",
      "reason": "Por qué comparte el ADN del anime referenciado. 1-2 oraciones.",
      "tags": ["Tag1", "Tag2", "Tag3"],
      "matchScore": 92,
      "available": true
    }
  ],
  "action": "open_anime",
  "followUp": "Pregunta breve y natural para profundizar (o null)"
}
\`\`\`

REGLAS FINALES IRROMPIBLES:
  1. "message"         → español conversacional, NUNCA genérico. En modo
                         descripción: nombra los rasgos que usaste para identificar
                         el anime (ej: "el pelo blanco y la vampira de ojos rojos
                         apuntan claramente a Arifureta").
  2. "mood"            → uno de: excited / relaxed / curious / empathetic
  3. "recommendations" → 0-5 items. Sin recomendaciones: []. En modo
                         incertidumbre: TODOS los candidatos posibles (máx 5).
  4. "tags"            → máx 3 tags cortos (ej: ["Isekai", "Dark", "Dungeon"])
  5. "matchScore"      → en descripción = confianza de identificación (0-100).
                         en similitud = afinidad con gustos (0-100).
  6. "action"          → "open_anime" si hay recomendaciones, null si no
  7. "followUp"        → null si identificaste con certeza. Si hay incertidumbre:
                         pregunta una pista más para confirmar cuál es.
  8. "available"       → true si search_catalog() lo encontró, false si no
  9. "title"           → nombre EXACTO de search_catalog(), nunca inventado
  10. Fuera de anime   → redirige amablemente
  11. NUNCA inventes datos. NUNCA salgas del personaje AniBot.
  12. NUNCA recomiendes T2+ si T1 está disponible en el catálogo.
  13. CANDIDATOS MÚLTIPLES: Si hay 2+ anime posibles → incl. TODOS (máx 5),
      el más probable primero (matchScore más alto). Nunca reduzcas a 1 si
      la confianza es ≤ 96%. Si confianza > 96% → muestra solo ese título.
  ${catalogOnly
      ? '14. MODO CATÁLOGO: SOLO recs donde search_catalog() devolvió resultados.'
      : '14. MODO LIBRE: Incluye externos (available:false) si search_catalog() no los encontró.'
  }
╚═════════════════════════════════════════════╝`;
}

// ==================== AI CHAT ENDPOINT ====================
app.post('/api/ai/chat', async (req: any, res: any) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';

    // ── Rate limit ───────────────────────────────────────────────────────────
    if (!checkRateLimit(ip)) {
        return res.status(429).json({
            success: false,
            error: 'Demasiadas solicitudes. Espera un momento antes de continuar.'
        });
    }

    const { messages, userProfile, key, catalogOnly } = req.body;
    const isCatalogOnly: boolean = catalogOnly !== false;
    const rawKey = key || process.env.GEMINI_API_KEY;

    // ── API key validation ───────────────────────────────────────────────────
    if (!rawKey || !validateApiKeyFormat(String(rawKey))) {
        return res.status(401).json({
            success: false,
            error: 'API key no configurada o con formato inválido. Ve a ⚙️ Configuración e ingresa tu Gemini API key.'
        });
    }
    const apiKey = String(rawKey).trim();

    // ── Message validation & sanitization ───────────────────────────────────
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ success: false, error: 'Mensajes inválidos.' });
    }

    // Sanitize each message: strip injections, limit length, enforce roles
    const cleanMessages = messages
        .slice(-40)
        .map((m: any) => {
            const role = m.role === 'user' ? 'user' : 'model';
            const rawText = String(m.text || '').substring(0, 4000);
            const text = role === 'user' ? sanitizeInput(rawText) : rawText.substring(0, 4000);
            return { role, parts: [{ text }] };
        })
        .filter((m: any) => m.parts[0].text.trim().length > 0);

    if (cleanMessages.length === 0) {
        return res.status(400).json({ success: false, error: 'Mensaje vacío.' });
    }

    // ── Validate userProfile structure ───────────────────────────────────────
    const safeProfile = {
        username:      typeof userProfile?.username === 'string' ? userProfile.username.slice(0, 32).trim() : '',
        bio:           typeof userProfile?.bio      === 'string' ? userProfile.bio.slice(0, 160).trim()     : '',
        favoriteGenres: Array.isArray(userProfile?.favoriteGenres) ? userProfile.favoriteGenres.slice(0, 2).map((g: any) => String(g)) : [],
        topGenres:     Array.isArray(userProfile?.topGenres)     ? userProfile.topGenres.slice(0, 10)  : [],
        recentHistory: Array.isArray(userProfile?.recentHistory) ? userProfile.recentHistory.slice(0, 15) : [],
        watchCount:    typeof userProfile?.watchCount  === 'number' ? userProfile.watchCount  : 0,
        libraryCount:  typeof userProfile?.libraryCount === 'number' ? userProfile.libraryCount : 0,
    };

    const systemPrompt = buildSystemPrompt(safeProfile, isCatalogOnly);
    const history      = cleanMessages.slice(0, -1);
    const lastMsg      = cleanMessages[cleanMessages.length - 1];

    try {
        const GoogleGenAI = await getGenAI();
        const ai = new GoogleGenAI({ apiKey });

        const chat = (ai as any).chats.create({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: systemPrompt,
                temperature: isCatalogOnly ? 0.75 : 0.92,
                topP: 0.95,
                tools: [CATALOG_SEARCH_TOOL],
            },
            history
        });

        // ── Send initial message, then run function-calling loop ─────────────
        let result = await chat.sendMessage({ message: lastMsg.parts[0].text });
        let raw: string = result.text || '';

        const MAX_TOOL_CALLS = 6;
        let toolCallCount = 0;

        while (toolCallCount < MAX_TOOL_CALLS) {
            const calls: any[] = result.functionCalls ?? [];
            if (calls.length === 0) break;

            // Execute all tool calls (run searches in parallel)
            const toolParts = await Promise.all(calls.map(async (call: any) => {
                if (call.name === 'search_catalog') {
                    const query = String(call.args?.query ?? '').trim().substring(0, 100);
                    const results = await searchCatalogInternal(query);
                    console.log(`[AniBot tool] search_catalog("${query}") → ${results.length} results`);
                    return {
                        functionResponse: {
                            name: 'search_catalog',
                            response: {
                                found: results.length > 0,
                                count: results.length,
                                results: results.map(r => ({ title: r.title, id: r.id, type: r.type }))
                            }
                        }
                    };
                }
                return null;
            }));

            const validParts = toolParts.filter(Boolean);
            if (validParts.length === 0) break;

            result = await chat.sendMessage({ message: validParts });
            raw = result.text || '';
            toolCallCount++;
        }

        // ── Parse structured JSON response ───────────────────────────────────
        let parsed: any = null;

        const fencedMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
        const bareMatch   = raw.match(/(\{[\s\S]*?"message"[\s\S]*?\})\s*$/);
        const jsonStr     = fencedMatch?.[1] ?? bareMatch?.[1] ?? null;

        if (jsonStr) {
            try { parsed = JSON.parse(jsonStr); } catch {
                try {
                    const fixed = jsonStr.replace(/,\s*([\}\]])/g, '$1');
                    parsed = JSON.parse(fixed);
                } catch { /* best effort */ }
            }
        }

        // ── Extract and validate fields ──────────────────────────────────────
        const responseText = parsed?.message || raw.replace(/```json[\s\S]*?```/g, '').trim();
        const mood         = ['excited','relaxed','curious','empathetic'].includes(parsed?.mood)
                                 ? parsed.mood : 'curious';
        const followUp     = typeof parsed?.followUp === 'string' && parsed.followUp.trim().length > 0
                                 ? parsed.followUp.trim().substring(0, 200) : null;

        // ── Validate + deduplicate recommendations ───────────────────────────
        // Gemini already searched the real catalog — no fuzzy matching needed
        let recommendations = validateRecommendations(parsed?.recommendations ?? []);

        // Catalog-only mode: drop any rec Gemini marked as unavailable
        if (isCatalogOnly) {
            recommendations = recommendations.filter(rec => rec.available !== false);
        }

        // Deduplicate by title
        const seen = new Set<string>();
        recommendations = recommendations.filter(rec => {
            if (seen.has(rec.title)) return false;
            seen.add(rec.title);
            return true;
        });

        const action = recommendations.length > 0 ? 'open_anime' : null;

        return res.json({ success: true, text: responseText, recommendations, action, mood, followUp });

    } catch (err: any) {
        const msg: string = err?.message || String(err);
        console.error('[AI /api/ai/chat]', msg.substring(0, 300));

        if (msg.includes('leaked') || msg.includes('reported')) {
            return res.status(401).json({ success: false, error: 'Tu API key fue bloqueada por Google (clave expuesta). Genera una nueva en aistudio.google.com/apikey' });
        }
        if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
            return res.status(401).json({ success: false, error: 'API key inválida o sin permisos para Gemini.' });
        }
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
            return res.status(429).json({ success: false, error: 'Límite de solicitudes de Gemini alcanzado. Espera un momento.' });
        }
        if (msg.includes('503') || msg.includes('unavailable')) {
            return res.status(503).json({ success: false, error: 'Gemini no está disponible en este momento. Intenta en unos segundos.' });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor AI. Intenta de nuevo.' });
    }
});

async function startServer() {
    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    } else {
        // Serve static assets from project root (sw.js, manifest, etc. not covered by explicit routes)
        app.use(express.static(process.cwd(), { index: false }));
        app.get('*', (req, res) => {
            res.sendFile(path.join(process.cwd(), 'index.html'));
        });
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
