// awesome-hub: lightweight server
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const yauzl = require('yauzl');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0'; // ubah ke 0.0.0.0 bila ingin diakses dari perangkat lain
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
const SITES = path.join(DATA, 'sites');
const SITE_PORTS_FILE = path.join(DATA, 'site-ports.json');
const DB = path.join(DATA, 'apps.json');
const EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico'];
const PAGE_TARGET = /^\/pages\/[a-f0-9-]+\.html$/i;
const SITE_TARGET = /^\/sites\/[a-f0-9-]+\/?$/i;
const SITE_URL_TARGET = /^https?:\/\/[^/]+\/sites\/[a-f0-9-]+\/?$/i;
const SITE_PATH = /^\/sites\/([a-f0-9-]+)(?:\/(.*))?$/i;
const ZIP_LIMIT = 100 * 1024 * 1024;
const SITE_LIMIT = 150 * 1024 * 1024;
const SITE_ENTRY_LIMIT = 1000;
const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  htm: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', map: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm'
};

fs.mkdirSync(UP, { recursive: true });
fs.mkdirSync(SITES, { recursive: true });
const siteServers = new Map();
let sitePorts = {};
let appWriteQueue = Promise.resolve();
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
      target: str(a.target, 500), icon: str(a.icon, 500), lockedFavicon: str(a.lockedFavicon, 500),
      newTab: a.newTab !== false, fill: a.fill === true };
  }).filter(a => /^\d{1,5}$/.test(a.target) || /^https?:\/\//i.test(a.target) ||
    PAGE_TARGET.test(a.target) || SITE_TARGET.test(a.target) || SITE_URL_TARGET.test(a.target));
}

function collectAssetRefs(list) {
  const refs = { pages: new Set(), sites: new Set(), uploads: new Set() };
  for (const app of Array.isArray(list) ? list : []) {
    if (!app || typeof app !== 'object') continue;
    const target = typeof app.target === 'string' ? app.target : '';
    const page = PAGE_TARGET.exec(target);
    if (page) refs.pages.add(page[0]);
    const relativeSite = SITE_TARGET.exec(target);
    if (relativeSite) refs.sites.add(relativeSite[0].split('/')[2]);
    else if (SITE_URL_TARGET.test(target)) {
      try {
        const url = new URL(target);
        const site = SITE_PATH.exec(url.pathname);
        const hosted = site && siteServers.get(site[1]);
        if (hosted && Number(url.port) === hosted.port) refs.sites.add(site[1]);
      } catch {
        console.warn('Ignoring malformed hosted site target while collecting asset references.');
      }
    }
    const icon = /^\/uploads\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|gif|svg|ico))$/i.exec(
      typeof app.icon === 'string' ? app.icon : ''
    );
    if (icon) refs.uploads.add(icon[1]);
  }
  return refs;
}

async function cleanupUnusedAssets(previous, next) {
  const before = collectAssetRefs(previous), after = collectAssetRefs(next);
  let warning = false;
  const reportFailure = (kind, name, error) => {
    warning = true;
    console.error(`Could not remove unused uploaded ${kind} ${name}:`, error.message);
  };
  for (const page of before.pages) {
    if (after.pages.has(page)) continue;
    try { await fs.promises.rm(path.join(UP, path.basename(page)), { force: true }); }
    catch (error) { reportFailure('HTML page', page, error); }
  }
  for (const upload of before.uploads) {
    if (after.uploads.has(upload)) continue;
    try { await fs.promises.rm(path.join(UP, upload), { force: true }); }
    catch (error) { reportFailure('logo', upload, error); }
  }
  for (const id of before.sites) {
    if (after.sites.has(id)) continue;
    const hosted = siteServers.get(id);
    if (hosted) {
      try {
        await new Promise((resolve, reject) => {
          hosted.server.close(error => error ? reject(error) : resolve());
          hosted.server.closeAllConnections();
        });
      } catch (error) { reportFailure('site server', id, error); }
      siteServers.delete(id);
    }
    delete sitePorts[id];
    try { persistSitePorts(); }
    catch (error) { reportFailure('site port record', id, error); }
    try { await fs.promises.rm(path.join(SITES, id), { recursive: true, force: true }); }
    catch (error) { reportFailure('ZIP site', id, error); }
  }
  return warning;
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

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zip) => error ? reject(httpError('Invalid ZIP archive', 400)) : resolve(zip));
  });
}

function entryPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name))
    throw httpError('ZIP contains an unsafe path', 400);
  const isDirectory = name.endsWith('/');
  const relative = isDirectory ? name.slice(0, -1) : name;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '..'))
    throw httpError('ZIP contains an unsafe path', 400);
  const normalized = parts.filter(part => part !== '.');
  if (!normalized.length && !isDirectory) throw httpError('ZIP contains an unsafe path', 400);
  return { relative: normalized.join(path.sep), isDirectory };
}

function rewriteSiteHtml(content, base) {
  return content.replace(/(\b(?:href|src|action|poster|formaction)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
    (_, attr, quote, url) => `${attr}${quote}${base}${url}${quote}`);
}

function rewriteSiteCss(content, base) {
  return content
    .replace(/url\(\s*(["']?)\/(?!\/)([^)"']*)\1\s*\)/gi, (_, quote, url) => `url(${quote}${base}${url}${quote})`)
    .replace(/(@import\s+)(["'])\/(?!\/)([^"']+)\2/gi, (_, prefix, quote, url) => `${prefix}${quote}${base}${url}${quote}`);
}

function serveSiteFile(id, req, res) {
  const parsed = new URL(req.url, 'http://site');
  const match = SITE_PATH.exec(decodeURIComponent(parsed.pathname));
  if (!match || match[1] !== id) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const siteDirectory = path.join(SITES, id);
  const siteRoot = fs.existsSync(path.join(siteDirectory, 'index.html'))
    ? siteDirectory : path.join(siteDirectory, 'public');
  const requested = match[2] || 'index.html';
  if (requested.split('/').some(part => !part || part === '.' || part === '..')) {
    res.writeHead(400);
    return res.end('Invalid site path');
  }
  const file = path.resolve(siteRoot, requested);
  let st;
  try {
    const rootReal = fs.realpathSync(siteRoot);
    const fileReal = fs.realpathSync(file);
    if (!fileReal.startsWith(rootReal + path.sep)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    st = fs.statSync(fileReal);
    if (!st.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
  } catch {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = ['html', 'htm'].includes(ext) ? MIME.html : MIME[ext] || 'application/octet-stream';
  let body;
  if (['html', 'htm', 'css'].includes(ext)) {
    const content = fs.readFileSync(file, 'utf8');
    const base = `/sites/${id}/`;
    body = Buffer.from(ext === 'css' ? rewriteSiteCss(content, base) : rewriteSiteHtml(content, base));
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body ? body.length : st.size,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; sandbox allow-scripts allow-same-origin allow-downloads"
  });
  if (req.method === 'HEAD') return res.end();
  if (body) return res.end(body);
  fs.createReadStream(file).pipe(res);
}

function hostedSiteUrl(req, id, port) {
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; }
  catch { throw httpError('Could not determine host for the hosted site URL', 400); }
  return `http://${hostname}:${port}/sites/${id}/`;
}

function persistSitePorts() {
  const tempFile = SITE_PORTS_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(sitePorts, null, 2));
  fs.renameSync(tempFile, SITE_PORTS_FILE);
}

async function listenSite(id, port) {
  const createServer = () => http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }
    try { serveSiteFile(id, req, res); }
    catch (error) {
      console.error(`Site ${id} request failed:`, error.message);
      if (!res.headersSent) { res.writeHead(500); res.end('Internal server error'); }
    }
  });
  let server = createServer();
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.removeListener('listening', resolve); reject(error); };
      server.once('error', onError);
      server.once('listening', resolve);
      server.listen(port, HOST);
    });
  } catch (error) {
    if (!port) throw error;
    console.warn(`Could not restore site ${id} on port ${port}; assigning another port.`);
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
      server.listen(0, HOST);
    });
  }
  server.on('error', error => console.error(`Site server ${id} failed:`, error.message));
  const assignedPort = server.address().port;
  siteServers.set(id, { server, port: assignedPort });
  sitePorts[id] = assignedPort;
  persistSitePorts();
  return assignedPort;
}

async function restoreSiteServers() {
  if (fs.existsSync(SITE_PORTS_FILE)) {
    try {
      sitePorts = JSON.parse(fs.readFileSync(SITE_PORTS_FILE, 'utf8'));
      if (!sitePorts || typeof sitePorts !== 'object' || Array.isArray(sitePorts)) throw new Error('Invalid site port map');
    } catch (error) {
      throw new Error(`Could not read ${SITE_PORTS_FILE}: ${error.message}`);
    }
  }
  const ids = fs.readdirSync(SITES, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9-]+$/i.test(entry.name))
    .map(entry => entry.name);
  for (const id of ids) {
    const savedPort = Number(sitePorts[id]);
    const port = Number.isInteger(savedPort) && savedPort > 0 && savedPort <= 65535 && savedPort !== PORT ? savedPort : 0;
    try { await listenSite(id, port); }
    catch (error) { console.error(`Could not start hosted site ${id}:`, error.message); }
  }
}

async function extractSite(buffer, destination) {
  const zip = await openZip(buffer);
  let count = 0, total = 0, failed = false;
  const names = new Set();
  const publicIndexes = [];
  let hasRootIndex = false;
  return new Promise((resolve, reject) => {
    const fail = error => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(error);
    };
    zip.on('error', () => fail(httpError('Invalid ZIP archive', 400)));
    zip.on('entry', entry => {
      (async () => {
        if (entry.generalPurposeBitFlag & 1) throw httpError('Encrypted ZIP files are not supported', 400);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000) throw httpError('Symbolic links are not allowed in ZIP files', 400);
        const { relative, isDirectory } = entryPath(entry.fileName);
        if (relative.split(path.sep).some(part => part.toLowerCase() === 'node_modules')) {
          zip.readEntry();
          return;
        }
        count++;
        if (count > SITE_ENTRY_LIMIT) throw httpError(`ZIP may contain at most ${SITE_ENTRY_LIMIT} entries`, 413);
        if (!relative && isDirectory) {
          zip.readEntry();
          return;
        }
        const key = relative.toLowerCase();
        if (names.has(key)) throw httpError('ZIP contains duplicate paths', 400);
        names.add(key);
        if (!isDirectory && key === 'index.html') hasRootIndex = true;
        if (!isDirectory && (key === 'public/index.html' || key.endsWith('/public/index.html')))
          publicIndexes.push(path.dirname(relative));
        if (entry.uncompressedSize > SITE_LIMIT || total + entry.uncompressedSize > SITE_LIMIT)
          throw httpError(`Extracted site size may not exceed ${SITE_LIMIT / 1024 / 1024} MB`, 413);
        const file = path.join(destination, relative);
        if (isDirectory) {
          await fs.promises.mkdir(file, { recursive: true });
        } else {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          const input = await new Promise((ok, no) => zip.openReadStream(entry, (error, stream) => error ? no(error) : ok(stream)));
          let entrySize = 0;
          const meter = new Transform({
            transform(chunk, encoding, callback) {
              entrySize += chunk.length;
              total += chunk.length;
              if (entrySize > SITE_LIMIT || total > SITE_LIMIT) {
                callback(httpError(`Extracted site size may not exceed ${SITE_LIMIT / 1024 / 1024} MB`, 413));
              } else callback(null, chunk);
            }
          });
          await pipeline(input, meter, fs.createWriteStream(file, { flags: 'wx' }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => {
      if (failed) return;
      if (hasRootIndex) return resolve('');
      const directPublicIndex = publicIndexes.find(dir => dir.toLowerCase() === 'public');
      if (directPublicIndex) return resolve(directPublicIndex);
      const nestedIndexes = [...new Set(publicIndexes)];
      if (nestedIndexes.length === 1) return resolve(nestedIndexes[0]);
      if (nestedIndexes.length > 1)
        return fail(httpError('ZIP contains multiple public/index.html files; keep only one site folder', 400));
      fail(httpError('ZIP must contain index.html at its root or in a public/ folder', 400));
    });
    zip.readEntry();
  });
}

const hubServer = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const query = new URL(req.url, 'http://x').searchParams;

    if (p === '/api/apps') {
      if (req.method === 'GET') return send(res, 200, fs.readFileSync(DB), { 'Cache-Control': 'no-store' });
      if (req.method === 'PUT') {
        const list = clean(JSON.parse((await readBody(req, 1e6)).toString()));
        const update = appWriteQueue.then(async () => {
          const previous = JSON.parse(fs.readFileSync(DB, 'utf8'));
          fs.writeFileSync(DB + '.tmp', JSON.stringify(list, null, 2));
          fs.renameSync(DB + '.tmp', DB);
          const cleanupWarning = await cleanupUnusedAssets(previous, list);
          return { cleanupWarning };
        });
        appWriteQueue = update.catch(error => console.error('App list update failed:', error.message));
        const { cleanupWarning } = await update;
        return send(res, 200, JSON.stringify(list), cleanupWarning ? {
          'X-Cleanup-Warning': 'Some unused uploaded files could not be removed; check the server log.'
        } : {});
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

    if (p === '/api/upload-site' && req.method === 'POST') {
      const buf = await readBody(req, ZIP_LIMIT);
      if (!buf.length) return send(res, 400, '{"error":"Empty file"}');
      const id = crypto.randomUUID();
      const temp = path.join(SITES, '.' + id + '.tmp');
      const siteTemp = path.join(SITES, '.' + id + '.site.tmp');
      const destination = path.join(SITES, id);
      await fs.promises.mkdir(temp);
      try {
        const siteRoot = await extractSite(buf, temp);
        if (siteRoot) {
          await fs.promises.rename(path.join(temp, siteRoot), siteTemp);
          await fs.promises.rm(temp, { recursive: true, force: true });
          await fs.promises.rename(siteTemp, destination);
        } else await fs.promises.rename(temp, destination);
        await listenSite(id, 0);
        return send(res, 200, JSON.stringify({ url: '/sites/' + id + '/' }));
      } catch (error) {
        const hosted = siteServers.get(id);
        if (hosted) {
          hosted.server.close();
          siteServers.delete(id);
          delete sitePorts[id];
          persistSitePorts();
        }
        await fs.promises.rm(temp, { recursive: true, force: true });
        await fs.promises.rm(siteTemp, { recursive: true, force: true });
        await fs.promises.rm(destination, { recursive: true, force: true });
        throw error;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"Method not allowed"}');

    const siteMatch = SITE_PATH.exec(p);
    if (siteMatch) {
      const hosted = siteServers.get(siteMatch[1]);
      if (!hosted) return send(res, 503, '{"error":"Hosted site is unavailable; check the server logs"}');
      const location = new URL(req.url, 'http://hub');
      const destination = new URL(location.pathname + location.search, hostedSiteUrl(req, siteMatch[1], hosted.port));
      return res.writeHead(302, { Location: destination.toString() }).end();
    }

    const isUp = p.startsWith('/uploads/');
    const isPage = PAGE_TARGET.test(p);
    const file = isUp || isPage ? path.join(UP, path.basename(p)) : path.join(PUB, p === '/' ? 'index.html' : p);
    if (!isUp && !isPage && !file.startsWith(PUB + path.sep)) return send(res, 403, '{"error":"Forbidden"}');
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, '{"error":"Not found"}'); }
    if (!st.isFile()) return send(res, 404, '{"error":"Not found"}');

    const ext = path.extname(file).slice(1).toLowerCase();
    const h = { 'Content-Type': isPage ? MIME.html : MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache' };
    if (isUp) h['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (isPage) h['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, JSON.stringify({ error: e.message }));
  }
});

restoreSiteServers().then(() => {
  hubServer.listen(PORT, HOST, () => console.log(`AWSOME HUB running at http://${HOST}:${PORT}`));
}).catch(error => {
  console.error('Could not restore hosted sites:', error.message);
  process.exitCode = 1;
});
