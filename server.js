const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000; // Render folosește porturi dinamice, adăugat suport nativ
const DATA_FILE = path.join(__dirname, 'members-data.json');
const STORE_KEY = 'clan-manager:members-store';

// ── STOCARE (Key Value pe Render, cu fișierul local ca rezervă) ───────────
// Fișierul local se resetează la fiecare deploy (discul nu e permanent pe
// planul gratuit), de-aia ținem datele reale în Key Value. Dacă Key Value nu
// e configurat sau pică temporar, nu lăsăm site-ul să cadă — folosim
// fișierul local ca rezervă, chiar dacă acela nu rezistă la deploy-uri.
let redisClientPromise = null;

function getRedis() {
  if (!process.env.STORE_URL) return null;
  if (!redisClientPromise) {
    const client = createClient({ url: process.env.STORE_URL });
    client.on('error', (err) => console.error('Eroare Key Value:', err.message));
    redisClientPromise = client.connect().then(() => client);
  }
  return redisClientPromise;
}

async function loadStore() {
  try {
    const client = await getRedis();
    if (client) {
      const raw = await client.get(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.error('Key Value indisponibil la citire, folosesc fișierul local:', e.message);
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

async function saveStore(store) {
  const json = JSON.stringify(store);
  try {
    const client = await getRedis();
    if (client) {
      await client.set(STORE_KEY, json);
      return;
    }
  } catch (e) {
    console.error('Key Value indisponibil la scriere, salvez doar local:', e.message);
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare scriere fișier local:', e.message);
  }
}


function toCrDateFormat(isoString) {
  return isoString.replace(/[-:]/g, '').replace(/\.\d{3}Z\$/, '.000Z');
}

async function applyFirstSeen(clanTag, members) {
  const store = await loadStore();

  
  if (!store[clanTag]) {
    const legacyKey = Object.keys(store).find(k => k.toUpperCase() === clanTag.toUpperCase());
    if (legacyKey) {
      store[clanTag] = store[legacyKey];
      if (legacyKey !== clanTag) delete store[legacyKey];
    }
  }

  const isFirstRunEver = !store[clanTag];
  if (!store[clanTag]) store[clanTag] = {};
  const clanStore = store[clanTag];
  const nowIso = new Date().toISOString();
  let changed = true; 


  Object.keys(clanStore).forEach(tag => {
    const val = clanStore[tag];
    if (val && typeof val === 'object') {
      clanStore[tag] = val.manual || val.firstSeen || null;
      changed = true;
    }
  });

  members.forEach(m => {
    if (!(m.tag in clanStore)) {
      clanStore[m.tag] = isFirstRunEver ? null : nowIso; // null = exista deja, dată necunoscută
      changed = true;
    }
    if (clanStore[m.tag]) m.joinedAt = toCrDateFormat(clanStore[m.tag]);
  });

  // curăță membrii care au plecat, ca fișierul să nu crească la infinit
  const currentTags = new Set(members.map(m => m.tag));
  Object.keys(clanStore).forEach(tag => {
    if (!currentTags.has(tag)) { delete clanStore[tag]; changed = true; }
  });

  if (changed) await saveStore(store);
}

async function setManualNew(clanTag, tag) {
  const store = await loadStore();
  if (!store[clanTag]) store[clanTag] = {};
  store[clanTag][tag] = new Date().toISOString();
  await saveStore(store);
}

// Scoate membrul din lista de "noi": punem null (= "există deja, dată
// necunoscută"), NU ștergem cheia — dacă am șterge-o complet, la
// următoarea rulare applyFirstSeen l-ar considera intrat chiar acum
// (isFirstRunEver e false) și l-ar marca din nou ca nou.
async function setManualNotNew(clanTag, tag) {
  const store = await loadStore();
  if (!store[clanTag]) store[clanTag] = {};
  store[clanTag][tag] = null;
  await saveStore(store);
}

function apiRequest(apiPath, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.clashroyale.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.substring(0, 100))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── CLASAMENTE (Moldova) ────────────────────────────────────────────────────
let moldovaLocationIdCache = null;

async function getMoldovaLocationId(apiKey) {
  if (moldovaLocationIdCache) return moldovaLocationIdCache;
  const res = await apiRequest('/v1/locations', apiKey);
  const md = (res.items || []).find(l => l.name === 'Moldova');
  if (md) moldovaLocationIdCache = md.id;
  return moldovaLocationIdCache;
}

// Caută clanul nostru într-un top (până la 200 de rezultate); dacă nu e în
// top, întoarce null — API-ul nu oferă poziții mai jos de atât.
async function findClanInRanking(apiPath, apiKey, ourTagNormalized) {
  const res = await apiRequest(apiPath, apiKey);
  const found = (res.items || []).find(c => c.tag === ourTagNormalized);
  return found || null;
}

async function getMoldovaRankings(apiKey, ourTagNormalized) {
  try {
    const locId = await getMoldovaLocationId(apiKey);
    if (!locId) return null;
    const [trophyEntry, warEntry] = await Promise.all([
      findClanInRanking(`/v1/locations/${locId}/rankings/clans`, apiKey, ourTagNormalized),
      findClanInRanking(`/v1/locations/${locId}/rankings/clanwars`, apiKey, ourTagNormalized)
    ]);
    // Numele câmpului cu scorul poate diferi față de documentație, de-aia
    // încercăm mai multe variante în loc să presupunem unul singur.
    const pick = (obj, keys) => {
      for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
      return null;
    };
    const trophyVal = trophyEntry && pick(trophyEntry, ['clanScore', 'trophies', 'score']);
    const warVal = warEntry && pick(warEntry, ['clanWarTrophies', 'warTrophies', 'clanScore', 'score']);
    return {
      trophies: (trophyEntry && trophyVal !== null) ? { rank: trophyEntry.rank, value: trophyVal } : null,
      war: (warEntry && warVal !== null) ? { rank: warEntry.rank, value: warVal } : null
    };
  } catch (e) {
    console.error('Eroare clasamente Moldova:', e.message);
    return null;
  }
}

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const htmlStat = fs.statSync(path.join(__dirname, 'index.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(HTML);
  }

  if (req.method === 'POST' && url.pathname === '/api') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const parsedBody = JSON.parse(body);
        const clanTag = parsedBody.clanTag;
        
        // În loc de cheia din frontend, folosim cheia securizată setată în Render
        const apiKey = process.env.CLASH_API_KEY; 
        
        if (!apiKey) {
          throw new Error('Eroare: CLASH_API_KEY nu este setat în panoul Render!');
        }

        const normalizedTag = (clanTag.startsWith('#') ? clanTag : '#' + clanTag).toUpperCase();
        const tag = encodeURIComponent(normalizedTag);

        const [clan, warLog, currentWar] = await Promise.all([
          apiRequest(`/v1/clans/${tag}`, apiKey),
          apiRequest(`/v1/clans/${tag}/riverracelog?limit=3`, apiKey),
          apiRequest(`/v1/clans/${tag}/currentriverrace`, apiKey).catch(() => null)
        ]);

        if (clan.reason) throw new Error(clan.reason + ': ' + clan.message);

        await applyFirstSeen(tag, clan.memberList || []);

        // Clasamentele nu sunt critice — dacă pică, nu blocăm restul site-ului.
        const rankings = await getMoldovaRankings(apiKey, normalizedTag);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clan, warLog, currentWar, rankings }));
      } catch(e) {
        console.error('API Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mark-new') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { clanTag, tag } = JSON.parse(body);
        const normalizedTag = (clanTag.startsWith('#') ? clanTag : '#' + clanTag).toUpperCase();
        const encTag = encodeURIComponent(normalizedTag);
        await setManualNew(encTag, tag);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/remove-new') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { clanTag, tag } = JSON.parse(body);
        const normalizedTag = (clanTag.startsWith('#') ? clanTag : '#' + clanTag).toUpperCase();
        const encTag = encodeURIComponent(normalizedTag);
        await setManualNotNew(encTag, tag);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Portul ${PORT} e deja ocupat — probabil mai rulează încă o instanță veche a serverului.`);
  } else {
    console.error('❌ Eroare server:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`✅ Clan Manager pornit pe portul ${PORT}!`);
});
