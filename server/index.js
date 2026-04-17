import express from 'express';
import puppeteer from 'puppeteer-extra';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { URL, fileURLToPath } from 'url';
import CryptoJS from 'crypto-js';
import path from 'path';
import { createServer } from 'http';

// ─── ENV ─────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SECRET_KEY = process.env.ENCRYPTION_KEY;
const PORT       = process.env.PORT || 8080;

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
}));
app.use(express.json({ limit: '1mb' }));

// Trust Nginx reverse proxy
app.set('trust proxy', 1);

// ─── SUPABASE ────────────────────────────────────────────────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    global: {
      fetch: (url, options = {}) => fetch(url, { ...options, timeout: 8000 }),
    },
  });
}

// ─── PUPPETEER ───────────────────────────────────────────────────────────────
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--window-size=1280,720',
];

const CHROME_PATH = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';

let _browser     = null;
let _browserBusy = false;
let _launchLock  = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launchLock) return _launchLock;

  _launchLock = (async () => {
    try {
      console.log('[browser] Launching Chrome…');
      const b = await puppeteer.launch({
        args: BROWSER_ARGS,
        executablePath: CHROME_PATH,
        headless: true,
        timeout: 20000,
      });
      b.on('disconnected', () => {
        console.warn('[browser] Chrome disconnected — will relaunch on next request.');
        _browser = null;
      });
      _browser = b;
      console.log('[browser] Chrome ready.');
      return b;
    } finally {
      _launchLock = null;
    }
  })();

  return _launchLock;
}

// Warm the browser on startup
getBrowser().catch((e) => console.error('[browser] Warm-up failed:', e.message));

// ─── OPENSUBTITLES TOKEN CACHE ───────────────────────────────────────────────
let _osTokenCache   = { token: null, expiresAt: 0 };
let _osTokenPending = null;

const OS_BASE = 'https://api.opensubtitles.com/api/v1';

function buildOsHeaders() {
  return {
    'Api-Key':      process.env.OPENSUBTITLES_API_KEY,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'User-Agent':   process.env.OPENSUBTITLES_USER_AGENT || 'StreamApp v1.0',
  };
}

async function getOsToken(osHeaders) {
  const now = Date.now();
  if (_osTokenCache.token && now < _osTokenCache.expiresAt) return _osTokenCache.token;
  if (_osTokenPending) return _osTokenPending;

  _osTokenPending = fetch(`${OS_BASE}/login`, {
    method:  'POST',
    headers: osHeaders,
    body:    JSON.stringify({
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.token) {
        _osTokenCache.token     = data.token;
        _osTokenCache.expiresAt = Date.now() + 55 * 60 * 1000;
        console.log('[subs] OpenSubtitles token refreshed.');
      } else {
        console.error('[subs] OpenSubtitles login failed:', JSON.stringify(data));
      }
      return data.token || null;
    })
    .catch((err) => {
      console.error('[subs] OpenSubtitles token fetch error:', err.message);
      return null;
    })
    .finally(() => { _osTokenPending = null; });

  return _osTokenPending;
}

// ─── FETCH WITH RETRY ────────────────────────────────────────────────────────
async function fetchWithRetry(url, options, retries = 2) {
  try {
    const res = await fetch(url, options);
    if (res.status >= 500 && retries > 0) {
      await new Promise((r) => setTimeout(r, 500));
      return fetchWithRetry(url, options, retries - 1);
    }
    return res;
  } catch (err) {
    if (retries > 0 && err.name !== 'AbortError') {
      await new Promise((r) => setTimeout(r, 500));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

// ─── IN-PROCESS PLAYLIST CACHE ───────────────────────────────────────────────
const _playlistCache = new Map();
const PLAYLIST_TTL   = 30_000;

function getCachedPlaylist(url) {
  const entry = _playlistCache.get(url);
  if (entry && Date.now() < entry.expiresAt) return entry.text;
  _playlistCache.delete(url);
  return null;
}
function setCachedPlaylist(url, text) {
  _playlistCache.set(url, { text, expiresAt: Date.now() + PLAYLIST_TTL });
  if (_playlistCache.size > 200) {
    const firstKey = _playlistCache.keys().next().value;
    _playlistCache.delete(firstKey);
  }
}

// ─── 1. PROXY ROUTE ──────────────────────────────────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const key = req.query.key;
  let targetUrl    = req.query.url;
  let cookieString = null;

  if (key && supabase) {
    const { data: cacheData } = await supabase
      .from('streams')
      .select('url')
      .eq('key', key)
      .single();

    if (cacheData?.url) {
      const stored = cacheData.url;
      if (typeof stored === 'string' && stored.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.cookie) cookieString = parsed.cookie;
          if (!targetUrl)    targetUrl    = parsed.url;
        } catch {
          if (!targetUrl) targetUrl = stored;
        }
      } else if (!targetUrl) {
        targetUrl = stored;
      }
    } else if (!targetUrl) {
      return res.status(404).send('Stream not found in cache.');
    }
  }

  if (!targetUrl) return res.status(400).send('No target URL resolved.');

  // TMDB key injection
  if (targetUrl.includes('api.themoviedb.org')) {
    try {
      const u = new URL(targetUrl);
      if (!u.searchParams.has('api_key') && process.env.TMDB_API_KEY) {
        u.searchParams.set('api_key', process.env.TMDB_API_KEY);
      }
      targetUrl = u.toString();
    } catch { /* ignore */ }
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000);

  try {
    const forwardedHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer':    'https://vidlink.pro/',
      'Origin':     'https://vidlink.pro/',
    };
    if (cookieString)      forwardedHeaders['Cookie'] = cookieString;
    if (req.headers.range) forwardedHeaders['Range']  = req.headers.range;
    delete forwardedHeaders['accept-encoding'];

    const response = await fetchWithRetry(targetUrl, {
      headers: forwardedHeaders,
      signal:  controller.signal,
    });

    clearTimeout(timeoutId);

    res.status(response.status);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = response.headers.get('content-type') || '';

    // ── Subtitle content-type fix ──────────────────────────────────────────
    // Forces text/vtt so browsers render subtitle tracks correctly regardless
    // of what the upstream server returns (often text/plain or octet-stream).
    if (req.query.type === 'sub') {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    } else {
      res.setHeader('Content-Type', contentType);
    }

    if (response.headers.get('content-range'))  res.setHeader('Content-Range',  response.headers.get('content-range'));
    if (response.headers.get('accept-ranges'))  res.setHeader('Accept-Ranges',  response.headers.get('accept-ranges'));
    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));

    const isPlaylist       = contentType.includes('mpegurl') || targetUrl.includes('.m3u8');
    const isPartialContent = response.status === 206;

    if (!isPlaylist && !isPartialContent) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600');
    }

    // ── M3U8 playlist rewriting ────────────────────────────────────────────
    if (isPlaylist) {
      const cached = getCachedPlaylist(targetUrl);
      let rewritten = cached;

      if (!rewritten) {
        const text         = await response.text();
        const providerBase = new URL(targetUrl).origin + new URL(targetUrl).pathname.replace(/[^/]+$/, '');
        const lines        = text.split('\n');
        rewritten          = '';

        for (let line of lines) {
          if (line.trim() && !line.startsWith('#')) {
            const abs      = line.startsWith('http') ? line : new URL(line, providerBase).href;
            const proxyUrl = key
              ? `/api/proxy?url=${encodeURIComponent(abs)}&key=${encodeURIComponent(key)}`
              : `/api/proxy?url=${encodeURIComponent(abs)}`;
            line = proxyUrl;
          } else if (line.startsWith('#EXT-X-MEDIA') && (line.includes('TYPE=AUDIO') || line.includes('TYPE=SUBTITLES'))) {
            const uriMatch = line.match(/URI\s*=\s*(["']?)([^"'\s]+)\1/);
            if (uriMatch) {
              const uri      = uriMatch[2];
              const absUri   = uri.startsWith('http') ? uri : new URL(uri, providerBase).href;
              const proxyUri = key
                ? `/api/proxy?url=${encodeURIComponent(absUri)}&key=${encodeURIComponent(key)}`
                : `/api/proxy?url=${encodeURIComponent(absUri)}`;
              line = line.replace(uriMatch[0], `URI="${proxyUri}"`);
            }
          }
          rewritten += line + '\n';
        }

        setCachedPlaylist(targetUrl, rewritten);
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // ── Binary / segment streaming ─────────────────────────────────────────
    res.on('error', () => {});
    response.body.on('error', (err) => {
      if (!res.destroyed && !res.headersSent) res.status(502).end();
      else if (!res.destroyed) res.destroy(err);
    });
    req.on('close', () => {
      if (response.body && !response.body.destroyed) response.body.destroy();
    });

    response.body.pipe(res);

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      if (!res.headersSent) return res.status(504).send('Upstream timed out.');
      return;
    }
    if (!res.headersSent) res.status(502).send('Proxy failed to reach provider.');
  }
});

// ─── 2. SCRAPE-STREAM ROUTE ──────────────────────────────────────────────────
app.post('/api/scrape-stream', async (req, res) => {
  const encryptedPayload = req.body.data;
  if (!encryptedPayload) return res.status(400).json({ error: 'Invalid request payload.' });

  if (_browserBusy) {
    return res.status(429).json({ error: 'Scraper is busy, please retry in a moment.' });
  }

  let page = null;
  _browserBusy = true;

  try {
    const bytes           = CryptoJS.AES.decrypt(encryptedPayload, SECRET_KEY);
    const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
    if (!decryptedString) throw new Error('Decryption failed');

    const { id, type, s, e } = JSON.parse(decryptedString);
    if (!id || !type) return res.status(400).json({ error: 'Invalid request payload.' });
    if (!supabase)    return res.status(500).json({ error: 'Service unavailable.' });

    const cacheKey = `${id}-${type}-${s || ''}-${e || ''}`;

    const { data: cacheData, error: cacheError } = await supabase
      .from('streams')
      .select('url, expires_at')
      .eq('key', cacheKey)
      .single();

    if (cacheError && cacheError.code !== 'PGRST116') throw cacheError;

    const now = new Date().toISOString();
    if (cacheData && cacheData.expires_at > now) {
      _browserBusy = false;
      return res.json({ success: true, url: `/api/proxy?key=${encodeURIComponent(cacheKey)}` });
    }

    const browser = await getBrowser();
    page          = await browser.newPage();
    await page.setRequestInterception(true);

    let capturedUrl = null;

    page.on('request', (request) => {
      const url = request.url();
      if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('ads') && !capturedUrl) {
        capturedUrl = url;
      }
      if (['image', 'font', 'stylesheet', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    let target = `https://vidlink.pro/${type}/${id}`;
    if (type === 'tv' && s && e) target = `https://vidlink.pro/tv/${id}/${s}/${e}`;

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.mouse.click(640, 360).catch(() => {});

    capturedUrl = await new Promise((resolve) => {
      const check = setInterval(() => {
        if (capturedUrl) { clearInterval(check); resolve(capturedUrl); }
      }, 300);
      setTimeout(() => { clearInterval(check); resolve(capturedUrl); }, 30000);
    });

    if (!capturedUrl) {
      return res.status(404).json({ success: false, message: 'Stream not found.' });
    }

    const cookies      = await page.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const expiresAt    = new Date(Date.now() + 3_600_000).toISOString();

    await supabase.from('streams').upsert({
      key:        cacheKey,
      url:        JSON.stringify({ url: capturedUrl, cookie: cookieString }),
      expires_at: expiresAt,
    }, { onConflict: 'key' });

    res.json({ success: true, url: `/api/proxy?key=${encodeURIComponent(cacheKey)}` });

  } catch (err) {
    console.error('[scrape-stream]', err.message);
    res.status(500).json({ success: false, error: 'An unexpected server error occurred.' });
  } finally {
    _browserBusy = false;
    if (page) await page.close().catch(() => {});
  }
});

// ─── 3. SUBTITLES ROUTE ──────────────────────────────────────────────────────
// Full OpenSubtitles integration:
//   • Token caching (55-min TTL, single in-flight lock)
//   • TV episode specificity (season + episode params)
//   • Deduplication by language, skip multi-CD releases
//   • All downloads proxied through /api/proxy?type=sub so the browser
//     receives the correct text/vtt CORS headers regardless of OS CDN headers
//   • Promise.allSettled so one failed download doesn't kill the rest
app.post('/api/subs', async (req, res) => {
  try {
    const encryptedPayload = req.body.data;
    if (!encryptedPayload) return res.status(400).json({ error: 'Invalid request payload.' });

    const bytes           = CryptoJS.AES.decrypt(encryptedPayload, SECRET_KEY);
    const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
    if (!decryptedString) return res.status(400).json({ error: 'Invalid request payload.' });

    const { imdbId, type, season, episode } = JSON.parse(decryptedString);
    if (!imdbId) return res.status(400).json({ error: 'Missing imdbId.' });

    const subsController = new AbortController();
    const subsTimeoutId  = setTimeout(() => subsController.abort(), 10000);

    const osHeaders = buildOsHeaders();

    // ── Token auth ────────────────────────────────────────────────────────
    const token = await getOsToken(osHeaders);
    if (token) {
      osHeaders['Authorization'] = `Bearer ${token}`;
    } else {
      console.warn('[subs] Proceeding without Bearer token (API-key only).');
    }

    // ── Search params ─────────────────────────────────────────────────────
    const params = new URLSearchParams({
      tmdb_id:         imdbId,
      languages:       'en',
      order_by:        'download_count',
      order_direction: 'desc',
    });

    // TV episode specificity — without these params OS returns season packs
    // which are multi-CD and get filtered out, leaving no subtitles for TV.
    if (type === 'tv' && season && episode) {
      params.append('season_number',  String(season));
      params.append('episode_number', String(episode));
      params.append('type', 'episode');
    } else {
      params.append('type', 'movie');
    }

    console.log(`[subs] Searching: type=${type} id=${imdbId} s=${season} e=${episode}`);

    const searchRes = await fetch(`${OS_BASE}/subtitles?${params.toString()}`, {
      headers: osHeaders,
      signal:  subsController.signal,
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      console.error('[subs] Search failed:', searchRes.status, errText);
      clearTimeout(subsTimeoutId);
      return res.status(502).json({ error: 'Subtitle search failed.' });
    }

    const searchData = await searchRes.json();
    console.log(`[subs] Results: ${searchData.data?.length ?? 0} found`);

    // ── Pick best subtitle per language ───────────────────────────────────
    let tracksToDownload = [];
    if (searchData.data?.length > 0) {
      const sorted = [...searchData.data].sort((a, b) => {
        // Trusted uploaders first, then highest download count
        const aT = a.attributes.from_trusted ? 1 : 0;
        const bT = b.attributes.from_trusted ? 1 : 0;
        if (bT !== aT) return bT - aT;
        return b.attributes.download_count - a.attributes.download_count;
      });

      const seenLanguages = new Set();
      for (const item of sorted) {
        const attrs = item.attributes;
        const lang  = attrs.language;

        // Skip: already seen this language, multi-CD packs, or no files
        if (seenLanguages.has(lang) || attrs.nb_cd > 1 || !attrs.files?.length) continue;

        tracksToDownload.push({
          title:    attrs.language_name || lang.toUpperCase() || 'Unknown',
          language: lang || 'en',
          fileId:   attrs.files[0].file_id,
        });
        seenLanguages.add(lang);
        if (tracksToDownload.length >= 6) break;
      }
    }

    console.log(`[subs] Downloading ${tracksToDownload.length} subtitle file(s)`);

    // ── Download + proxy-wrap each subtitle ───────────────────────────────
    const downloadResults = await Promise.allSettled(
      tracksToDownload.map(async (track) => {
        const dlRes = await fetch(`${OS_BASE}/download`, {
          method:  'POST',
          headers: osHeaders,
          body:    JSON.stringify({ file_id: track.fileId }),
          signal:  subsController.signal,
        });

        if (!dlRes.ok) {
          console.warn(`[subs] Download failed for fileId ${track.fileId}: ${dlRes.status}`);
          return null;
        }

        const dlData = await dlRes.json();
        if (!dlData.link) {
          console.warn(`[subs] No link returned for fileId ${track.fileId}`);
          return null;
        }

        // Proxy the subtitle URL so the browser gets:
        //   Content-Type: text/vtt; charset=utf-8
        //   Access-Control-Allow-Origin: *
        // regardless of what OpenSubtitles CDN returns.
        return {
          title:    track.title,
          language: track.language,
          uri:      `/api/proxy?url=${encodeURIComponent(dlData.link)}&type=sub`,
        };
      })
    );

    clearTimeout(subsTimeoutId);

    const finalTracks = downloadResults
      .filter((r) => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value);

    console.log(`[subs] Returning ${finalTracks.length} track(s)`);

    const encryptedResponse = CryptoJS.AES.encrypt(
      JSON.stringify({ tracks: finalTracks }),
      SECRET_KEY
    ).toString();

    res.status(200).json({ data: encryptedResponse });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Subtitle service timed out.' });
    }
    console.error('[subs]', error.message);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  }
});

// ─── 4. DATABASE STUBS ───────────────────────────────────────────────────────
app.post('/api/save-progress',    async (req, res) => res.json({ success: !!supabase }));
app.post('/api/add-to-watchlist', async (req, res) => res.json({ success: !!supabase }));

// ─── 5. HEALTH CHECK ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status:      'ok',
    browser:     _browser?.isConnected() ? 'connected' : 'disconnected',
    osToken:     !!_osTokenCache.token,
    osTokenExp:  _osTokenCache.token
      ? new Date(_osTokenCache.expiresAt).toISOString()
      : null,
    supabase:    !!supabase,
    uptime:      Math.floor(process.uptime()),
  });
});

// ─── 6. STATIC FRONTEND ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../dist'), {
  maxAge: '1d',
  etag:   true,
}));

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────
const server = createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT} | PID: ${process.pid}`);
});

process.on('SIGTERM', async () => {
  console.log('[shutdown] SIGTERM received. Closing gracefully…');
  server.close(() => process.exit(0));
  if (_browser) await _browser.close().catch(() => {});
});

export default app;