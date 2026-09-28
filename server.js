const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000; // Render folosește porturi dinamice, adăugat suport nativ
const DATA_FILE = path.join(__dirname, 'members-data.json');


function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}


function toCrDateFormat(isoString) {
  return isoString.replace(/[-:]/g, '').replace(/\.\d{3}Z\$/, '.000Z');
}

function applyFirstSeen(clanTag, members) {
  const store = loadStore();

  
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

  if (changed) saveStore(store);
}

function setManualNew(clanTag, tag) {
  const store = loadStore();
  if (!store[clanTag]) store[clanTag] = {};
  store[clanTag][tag] = new Date().toISOString();
  saveStore(store);
}

// Scoate membrul din lista de "noi": punem null (= "există deja, dată
// necunoscută"), NU ștergem cheia — dacă am șterge-o complet, la
// următoarea rulare applyFirstSeen l-ar considera intrat chiar acum
// (isFirstRunEver e false) și l-ar marca din nou ca nou.
function setManualNotNew(clanTag, tag) {
  const store = loadStore();
  if (!store[clanTag]) store[clanTag] = {};
  store[clanTag][tag] = null;
  saveStore(store);
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

        applyFirstSeen(tag, clan.memberList || []);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clan, warLog, currentWar }));
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
    req.on('end', () => {
      try {
        const { clanTag, tag } = JSON.parse(body);
        const normalizedTag = (clanTag.startsWith('#') ? clanTag : '#' + clanTag).toUpperCase();
        const encTag = encodeURIComponent(normalizedTag);
        setManualNew(encTag, tag);
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
    req.on('end', () => {
      try {
        const { clanTag, tag } = JSON.parse(body);
        const normalizedTag = (clanTag.startsWith('#') ? clanTag : '#' + clanTag).toUpperCase();
        const encTag = encodeURIComponent(normalizedTag);
        setManualNotNew(encTag, tag);
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
