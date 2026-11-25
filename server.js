// awesome-hub: server tanpa dependensi (hanya modul bawaan Node)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0'; // ubah ke 0.0.0.0 bila ingin diakses dari perangkat lain
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
const DB = path.join(DATA, 'apps.json');
const EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico'];
const PAGE_TARGET = /^\/pages\/[a-f0-9-]+\.html$/i;
const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon'
};

fs.mkdirSync(UP, { recursive: true });
if (!fs.existsSync(DB)) {
  fs.writeFileSync(DB, JSON.stringify([
    { id: crypto.randomUUID(), title: '9Router', target: '20128', icon: '', newTab: true },
    { id: crypto.randomUUID(), title: 'VS Code', target: '3000', icon: '', newTab: true },
    { id: crypto.randomUUID(), title: 'Google', target: 'https://google.com', icon: '', newTab: true }
  ], null, 2));
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
function clean(list) {
  if (!Array.isArray(list) || list.length > 500) throw Object.assign(new Error('Invalid app list'), { status: 400 });
  return list.map(a => {
    a = a || {};
    return { id: str(a.id, 40) || crypto.randomUUID(), title: str(a.title, 60),
      target: str(a.target, 500), icon: str(a.icon, 500), newTab: a.newTab !== false, fill: a.fill === true };
  }).filter(a => /^\d{1,5}$/.test(a.target) || /^https?:\/\//i.test(a.target) || PAGE_TARGET.test(a.target));
}

function readBody(req, limit) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', d => {
      n += d.length;
      if (n > limit) { no(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const query = new URL(req.url, 'http://x').searchParams;

    if (p === '/api/apps') {
      if (req.method === 'GET') return send(res, 200, fs.readFileSync(DB), { 'Cache-Control': 'no-store' });
      if (req.method === 'PUT') {
        const list = clean(JSON.parse((await readBody(req, 1e6)).toString()));
        fs.writeFileSync(DB + '.tmp', JSON.stringify(list, null, 2));
        fs.renameSync(DB + '.tmp', DB);
        return send(res, 200, JSON.stringify(list));
      }
      return send(res, 405, '{"error":"Method not allowed"}');
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const ext = (query.get('ext') || '').toLowerCase();
      if (!EXT.includes(ext)) return send(res, 400, JSON.stringify({ error: 'Allowed formats: ' + EXT.join(', ') }));
      const buf = await readBody(req, 5e6);
      if (!buf.length) return send(res, 400, '{"error":"Empty file"}');
      const name = crypto.randomUUID() + '.' + ext;
      fs.writeFileSync(path.join(UP, name), buf);
      return send(res, 200, JSON.stringify({ url: '/uploads/' + name }));
    }

    if (p === '/api/upload-page' && req.method === 'POST') {
      const buf = await readBody(req, 5e6);
      if (!buf.length) return send(res, 400, '{"error":"Empty file"}');
      const name = crypto.randomUUID() + '.html';
      fs.writeFileSync(path.join(UP, name), buf);
      return send(res, 200, JSON.stringify({ url: '/pages/' + name }));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"Method not allowed"}');

    const isUp = p.startsWith('/uploads/');
    const isPage = PAGE_TARGET.test(p);
    const file = isUp || isPage ? path.join(UP, path.basename(p)) : path.join(PUB, p === '/' ? 'index.html' : p);
    if (!isUp && !isPage && !file.startsWith(PUB + path.sep)) return send(res, 403, '{"error":"Forbidden"}');
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, '{"error":"Not found"}'); }
    if (!st.isFile()) return send(res, 404, '{"error":"Not found"}');

    const h = { 'Content-Type': isPage ? MIME.html : MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache' };
    if (isUp) h['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (isPage) h['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`AWSOME HUB running at http://${HOST}:${PORT}`));
