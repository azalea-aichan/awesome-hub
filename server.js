// awesome-hub: lightweight server
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const yauzl = require('yauzl');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const net = require('net');
const { spawn } = require('child_process');

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
const APPS = path.join(DATA, 'apps');
const APP_PORTS_FILE = path.join(DATA, 'app-ports.json');
const APP_ENV_FILE = path.join(DATA, 'app-env.json');
const APP_TARGET = /^\/apps\/[a-f0-9-]+\/?$/i;
const APP_PATH = /^\/apps\/([a-f0-9-]+)(?:\/(.*))?$/i;
const ZIP_LIMIT = 100 * 1024 * 1024;
const SITE_LIMIT = 150 * 1024 * 1024;
const SITE_ENTRY_LIMIT = 1000;
const SITE_API_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SITE_CONNECT_SOURCES = (process.env.SITE_CONNECT_SRC || '').split(',').map(source => {
  const value = source.trim();
  if (!value) return '';
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid SITE_CONNECT_SRC origin: ${value}`); }
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || !['http:', 'https:'].includes(url.protocol) ||
      url.hostname.includes('*') || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid SITE_CONNECT_SRC origin: ${value}; use an HTTP(S) origin without a path`);
  }
  return url.origin;
}).filter(Boolean);
const SITE_API_PROXY = (() => {
  const hostValue = (process.env.SITE_API_PROXY_HOST || '').trim();
  const originValue = (process.env.SITE_API_PROXY_ORIGIN || '').trim();
  if (hostValue && originValue) {
    throw new Error('Set only one of SITE_API_PROXY_HOST or SITE_API_PROXY_ORIGIN');
  }
  const value = hostValue || originValue;
  if (!value) return null;
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid ${hostValue ? 'SITE_API_PROXY_HOST' : 'SITE_API_PROXY_ORIGIN'}: ${value}`); }
  const isValid = /^https?:\/\/[^/?#]+\/?$/i.test(value) &&
    ['http:', 'https:'].includes(url.protocol) && !url.hostname.includes('*') &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
    (hostValue ? !url.port : true);
  if (!isValid) {
    const setting = hostValue ? 'SITE_API_PROXY_HOST' : 'SITE_API_PROXY_ORIGIN';
    const expected = hostValue ? 'an HTTP(S) scheme and hostname without a port or path' : 'an HTTP(S) origin without a path';
    throw new Error(`Invalid ${setting}: ${value}; use ${expected}`);
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    origin: url.origin,
    dynamicPort: Boolean(hostValue)
  };
})();

/* ---------- per-card API hosts (allowlist, configured from the card's edit form) ---------- */
const API_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const API_HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade'];

function parseApiHosts(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    let item = String(raw || '').trim();
    if (!item) continue;
    try { item = new URL(/^[a-z]+:\/\//i.test(item) ? item : 'http://' + item).hostname.toLowerCase(); }
    catch { continue; }
    if (API_HOST_RE.test(item) && !out.includes(item)) out.push(item);
  }
  return out.slice(0, 20);
}

function cardApiHosts(kind, id) {
  if (!/^[a-f0-9-]+$/i.test(id)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const hosts = new Set();
    for (const app of Array.isArray(list) ? list : []) {
      const target = app && typeof app.target === 'string' ? app.target.replace(/^https?:\/\/[^/]+/i, '') : '';
      const match = kind === 'page'
        ? target.toLowerCase() === `/pages/${id}.html`.toLowerCase()
        : new RegExp(`^/sites/${id}/?$`, 'i').test(target);
      if (match) parseApiHosts(app.apiHosts).forEach(host => hosts.add(host));
    }
    return [...hosts];
  } catch { return []; }
}

// Rewrites absolute URLs of allowed hosts found in served text (any port) to the hub's proxy.
function rewriteApiHosts(content, hosts, prefix) {
  for (const host of hosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<!\\bhref\\s*=\\s*["'])\\b(https?):\\/\\/${escaped}(?::(\\d{1,5}))?(?=[\\/?#"'\`\\s)]|$)`, 'gi');
    content = content.replace(pattern, (_, scheme, port) => {
      scheme = scheme.toLowerCase();
      return `${prefix}/${scheme}/${host}/${port || (scheme === 'https' ? 443 : 80)}`;
    });
  }
  return content;
}

// Runtime safety net for URLs built dynamically (host + port, user-typed API URL, etc.).
function injectApiShim(html, hosts, prefix) {
  const shim = '<script>(function(){var H=' + JSON.stringify(hosts) + ',P=' + JSON.stringify(prefix) + ';' +
    'function rw(u){try{var a=new URL(u,location.href);if((a.protocol==="http:"||a.protocol==="https:")&&a.host!==location.host&&H.indexOf(a.hostname.toLowerCase())>-1){' +
    'return P+"/"+a.protocol.slice(0,-1)+"/"+a.hostname+"/"+(a.port||(a.protocol==="https:"?"443":"80"))+a.pathname+a.search;}}catch(e){}return u;}' +
    'var f=window.fetch;if(f)window.fetch=function(i,o){try{if(typeof i==="string"||i instanceof URL)i=rw(String(i));' +
    'else if(i&&i.url){var n=rw(i.url);if(n!==i.url)i=new Request(n,i);}}catch(e){}return f.call(this,i,o);};' +
    'var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=rw(String(u));return x.apply(this,arguments);};' +
    '})();</script>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + shim) : shim + html;
}

function proxyAllowedApi(req, res, parsed, prefix, hosts, cors) {
  const corsHeaders = cors ? {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Max-Age': '600'
  } : {};
  if (cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
  if (!SITE_API_PROXY_METHODS.has(req.method)) { res.writeHead(405, corsHeaders); return res.end('Method not allowed'); }
  const rest = parsed.pathname.slice(prefix.length);
  const m = /^\/(https?)\/([^/]+)\/(\d{1,5})(\/.*)?$/i.exec(rest);
  const host = m && m[2].toLowerCase(), port = m && Number(m[3]);
  if (!m || !port || port > 65535 || !hosts.includes(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
    return res.end(`API host is not allowed for this card${host ? ': ' + host : ''}. Add it to "API hosts" in the card's edit form.`);
  }
  const target = new URL(`${m[1].toLowerCase()}://${host}:${port}`);
  target.pathname = m[4] || '/';
  target.search = parsed.search;
  const transport = target.protocol === 'https:' ? require('https') : http;
  const headers = { ...req.headers };
  for (const name of ['connection', 'cookie', 'host', 'origin', 'referer', 'transfer-encoding',
    'access-control-request-headers', 'access-control-request-method']) delete headers[name];
  for (const name of Object.keys(headers)) if (name.startsWith('sec-fetch-')) delete headers[name];
  const upstream = transport.request(target, { method: req.method, headers }, response => {
    const responseHeaders = { ...response.headers };
    for (const name of API_HOP_HEADERS) delete responseHeaders[name];
    if (cors) for (const name of Object.keys(responseHeaders)) if (name.startsWith('access-control-')) delete responseHeaders[name];
    res.writeHead(response.statusCode || 502, { ...responseHeaders, ...corsHeaders });
    response.pipe(res);
  });
  upstream.setTimeout(300000, () => upstream.destroy(new Error('API proxy request timed out')));
  upstream.on('error', error => {
    console.error(`API proxy request to ${target.origin} failed:`, error.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
    if (!res.writableEnded) res.end('API proxy request failed: ' + error.message);
  });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}
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
fs.mkdirSync(APPS, { recursive: true });
const siteServers = new Map();
const nodeApps = new Map();
let appPorts = {};
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
      newTab: a.newTab !== false, fill: a.fill === true, apiHosts: parseApiHosts(a.apiHosts) };
  }).filter(a => /^\d{1,5}$/.test(a.target) || /^https?:\/\//i.test(a.target) ||
    PAGE_TARGET.test(a.target) || SITE_TARGET.test(a.target) || SITE_URL_TARGET.test(a.target) || APP_TARGET.test(a.target));
}

function collectAssetRefs(list) {
  const refs = { pages: new Set(), sites: new Set(), uploads: new Set(), apps: new Set() };
  for (const app of Array.isArray(list) ? list : []) {
    if (!app || typeof app !== 'object') continue;
    const target = typeof app.target === 'string' ? app.target : '';
    const page = PAGE_TARGET.exec(target);
    if (page) refs.pages.add(page[0]);
    const nodeApp = appId(target);
    if (nodeApp) refs.apps.add(nodeApp);
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
  for (const id of before.apps) {
    if (after.apps.has(id)) continue;
    try { await stopNodeApp(id); }
    catch (error) { reportFailure('Node app process', id, error); }
    delete appPorts[id];
    try { persistAppPorts(); }
    catch (error) { reportFailure('Node app port record', id, error); }
    try { await fs.promises.rm(path.join(APPS, id), { recursive: true, force: true }); }
    catch (error) { reportFailure('Node app', id, error); }
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

function proxySiteApi(id, req, res, parsed) {
  const prefix = `/sites/${id}/__api_proxy`;
  let targetPath = parsed.pathname.slice(prefix.length);
  let origin = SITE_API_PROXY.origin;
  if (SITE_API_PROXY.dynamicPort) {
    const portMatch = /^\/(\d{1,5})(?=\/|$)/.exec(targetPath);
    const port = portMatch && Number(portMatch[1]);
    if (!port || port > 65535) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid API proxy port');
    }
    targetPath = targetPath.slice(portMatch[0].length) || '/';
    origin = `${SITE_API_PROXY.protocol}//${SITE_API_PROXY.hostname}:${port}`;
  }
  const target = new URL(origin);
  target.pathname = targetPath || '/';
  target.search = parsed.search;
  const transport = target.protocol === 'https:' ? require('https') : http;
  const headers = { ...req.headers };
  for (const name of ['connection', 'cookie', 'host', 'origin', 'referer', 'transfer-encoding']) delete headers[name];
  for (const name of Object.keys(headers)) {
    if (name.startsWith('sec-fetch-')) delete headers[name];
  }
  const upstream = transport.request(target, { method: req.method, headers }, response => {
    const responseHeaders = { ...response.headers };
    for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete responseHeaders[name];
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.setTimeout(30000, () => upstream.destroy(new Error('API proxy request timed out')));
  upstream.on('error', error => {
    console.error(`API proxy request failed for site ${id}:`, error.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!res.writableEnded) res.end('API proxy request failed');
  });
  req.pipe(upstream);
}

function serveSiteFile(id, req, res) {
  const parsed = new URL(req.url, 'http://site');
  const match = SITE_PATH.exec(decodeURIComponent(parsed.pathname));
  if (!match || match[1] !== id) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const proxyPrefix = `/sites/${id}/__api_proxy`;
  if (SITE_API_PROXY && (parsed.pathname === proxyPrefix || parsed.pathname.startsWith(proxyPrefix + '/'))) {
    return proxySiteApi(id, req, res, parsed);
  }
  const apiPrefix = `/sites/${id}/__api`;
  if (parsed.pathname.startsWith(apiPrefix + '/')) {
    return proxyAllowedApi(req, res, parsed, apiPrefix, cardApiHosts('site', id), false);
  }
  const apiHosts = cardApiHosts('site', id);
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
  if (['html', 'htm', 'css', 'js', 'json'].includes(ext)) {
    let content = fs.readFileSync(file, 'utf8');
    const base = `/sites/${id}/`;
    if (SITE_API_PROXY?.dynamicPort) {
      const escapedProtocol = SITE_API_PROXY.protocol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedHostname = SITE_API_PROXY.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const apiUrl = new RegExp(`${escapedProtocol}\\/\\/${escapedHostname}:(\\d{1,5})(?=\\/|[?#"'\\s])`, 'gi');
      content = content.replace(apiUrl, `${base}__api_proxy/$1`);
    } else if (SITE_API_PROXY) {
      content = content.split(SITE_API_PROXY.origin).join(`${base}__api_proxy`);
    }
    if (apiHosts.length && ext !== 'css') content = rewriteApiHosts(content, apiHosts, `${base}__api`);
    if (ext === 'css') content = rewriteSiteCss(content, base);
    else if (ext === 'html' || ext === 'htm') {
      content = rewriteSiteHtml(content, base);
      if (apiHosts.length) content = injectApiShim(content, apiHosts, `${base}__api`);
    }
    body = Buffer.from(content);
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body ? body.length : st.size,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': `default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src ${[...(SITE_API_PROXY || apiHosts.length ? ["'self'"] : []), ...SITE_CONNECT_SOURCES].join(' ') || "'none'"}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; sandbox allow-scripts allow-same-origin allow-downloads`
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
    const requestPath = new URL(req.url, 'http://site').pathname;
    const proxyPrefix = `/sites/${id}/__api_proxy`;
    const isApiProxy = (SITE_API_PROXY &&
      (requestPath === proxyPrefix || requestPath.startsWith(proxyPrefix + '/'))) ||
      requestPath.startsWith(`/sites/${id}/__api/`);
    if (isApiProxy ? !SITE_API_PROXY_METHODS.has(req.method) : req.method !== 'GET' && req.method !== 'HEAD') {
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

/* ---------- ZIP Node apps: uploaded projects that the hub runs as child processes ---------- */
const APP_ENV_MASK = '********';
const APP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APP_ENV_RESERVED = new Set(['PORT', 'HOST']);
const APP_START_COOLDOWN = 10000;

function appId(target) {
  const match = /^\/apps\/([a-f0-9-]+)\/?$/i.exec(typeof target === 'string' ? target : '');
  return match ? match[1].toLowerCase() : '';
}

function readAppEnvStore() {
  try {
    const value = JSON.parse(fs.readFileSync(APP_ENV_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeAppEnvStore(store) {
  const temp = APP_ENV_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, APP_ENV_FILE);
}

// Returns a message for the first invalid line (never echoes the line, it may hold a secret), or '' when all is fine.
function appEnvProblem(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) return `line ${i + 1} has no variable name. Write it as NAME=value.`;
    const key = line.slice(0, index).trim();
    if (!APP_ENV_KEY.test(key)) return `line ${i + 1}: the name before "=" is not valid (use letters, digits and _, not starting with a digit).`;
    if (APP_ENV_RESERVED.has(key)) return `line ${i + 1}: ${key} is set by the hub and cannot be overridden.`;
  }
  return '';
}

// "KEY=VALUE" lines -> object. A value equal to the mask keeps the value already stored for that key.
function parseAppEnv(text, base) {
  const out = {};
  for (const line of String(text).split(/\r?\n/).slice(0, 200)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!APP_ENV_KEY.test(key) || APP_ENV_RESERVED.has(key)) continue;
    let value = trimmed.slice(index + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    if (value === APP_ENV_MASK) {
      if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
      continue;
    }
    out[key] = value.slice(0, 4000);
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

// Environment variables live in data/app-env.json (keyed by card id), never in apps.json, so GET /api/apps cannot leak them.
function applyEnvUpdates(list, rawById) {
  const old = readAppEnvStore(), next = {};
  for (const card of list) {
    if (!appId(card.target)) continue;
    const base = old[card.id] && typeof old[card.id] === 'object' ? old[card.id] : {};
    const raw = rawById.get(card.id);
    next[card.id] = raw && typeof raw.env === 'string' ? parseAppEnv(raw.env, base) : base;
  }
  writeAppEnvStore(next);
}

function cardEnvForApp(id) {
  try {
    const list = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const card = list.find(app => app && appId(app.target) === id);
    return card ? readAppEnvStore()[card.id] || {} : {};
  } catch { return {}; }
}

const envSignature = env => crypto.createHash('sha1').update(JSON.stringify(Object.entries(env).sort())).digest('hex');

function persistAppPorts() {
  const temp = APP_PORTS_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(appPorts, null, 2));
  fs.renameSync(temp, APP_PORTS_FILE);
}

function tryListen(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(0));
    probe.listen(port, '0.0.0.0', () => {
      const assigned = probe.address().port;
      probe.close(() => resolve(assigned));
    });
  });
}

async function pickAppPort(preferred) {
  const saved = Number(preferred);
  if (Number.isInteger(saved) && saved > 0 && saved <= 65535 && saved !== PORT) {
    const port = await tryListen(saved);
    if (port) return port;
  }
  const port = await tryListen(0);
  if (!port) throw new Error('No free port available for the app');
  return port;
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitForAppPort(rec, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rec.exited) return false;
    if (await portOpen(rec.port)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !rec.exited && portOpen(rec.port);
}

function appLog(id, rec, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue;
    rec.logs.push(line);
    if (rec.logs.length > 200) rec.logs.shift();
    console.log(`[app ${id.slice(0, 8)}] ${line}`);
  }
}

// A browser script (document/window/addEventListener, no Node APIs) must never be run as a server.
function looksLikeBrowserScript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 200000); } catch { return false; }
  const browser = /\b(?:document|window|localStorage|navigator)\s*[.[]|(?:^|[^.\w])addEventListener\s*\(/m.test(text);
  const node = /\brequire\s*\(|\bfrom\s+['"](?:node:[a-z/]+|http|https|http2|fs|path|os|url|crypto|express|fastify|koa)['"]|\bprocess\.(?:env|argv|exit)|\.listen\s*\(/.test(text);
  return browser && !node;
}

function findAppEntry(dir) {
  const root = path.resolve(dir);
  const candidates = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.main === 'string' && pkg.main) candidates.push(pkg.main);
  } catch {}
  candidates.push('server.js', 'index.js', 'app.js');
  for (const candidate of candidates) {
    const file = path.resolve(root, candidate);
    try {
      if (file.startsWith(root + path.sep) && fs.statSync(file).isFile() && !looksLikeBrowserScript(file)) return file;
    } catch {}
  }
  return null;
}

function hasStaticIndex(dir) {
  const places = [dir, path.join(dir, 'public')];
  try {
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
    if (subs.length === 1) places.push(path.join(dir, subs[0].name), path.join(dir, subs[0].name, 'public'));
  } catch {}
  return places.some(place => fs.existsSync(path.join(place, 'index.html')));
}

function findAppRoot(temp) {
  if (findAppEntry(temp)) return temp;
  const dirs = fs.readdirSync(temp, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX');
  if (dirs.length === 1) {
    const sub = path.join(temp, dirs[0].name);
    if (findAppEntry(sub)) return sub;
  }
  return null;
}

// Like extractSite, but without the index.html requirement; also skips node_modules, .git and __MACOSX.
async function extractArchive(buffer, destination) {
  const zip = await openZip(buffer);
  let count = 0, total = 0, failed = false;
  const names = new Set();
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
        const parts = relative.split(path.sep).map(part => part.toLowerCase());
        if (parts.some(part => part === 'node_modules' || part === '.git' || part === '__macosx')) {
          zip.readEntry();
          return;
        }
        count++;
        if (count > SITE_ENTRY_LIMIT) throw httpError(`ZIP may contain at most ${SITE_ENTRY_LIMIT} entries`, 413);
        if (!relative && isDirectory) { zip.readEntry(); return; }
        const key = relative.toLowerCase();
        if (names.has(key)) throw httpError('ZIP contains duplicate paths', 400);
        names.add(key);
        if (entry.uncompressedSize > SITE_LIMIT || total + entry.uncompressedSize > SITE_LIMIT)
          throw httpError(`Extracted app size may not exceed ${SITE_LIMIT / 1024 / 1024} MB`, 413);
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
                callback(httpError(`Extracted app size may not exceed ${SITE_LIMIT / 1024 / 1024} MB`, 413));
              } else callback(null, chunk);
            }
          });
          await pipeline(input, meter, fs.createWriteStream(file, { flags: 'wx' }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => { if (!failed) resolve(); });
    zip.readEntry();
  });
}

function installAppDependencies(dir) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return Promise.resolve(); }
  if (!pkg || !pkg.dependencies || !Object.keys(pkg.dependencies).length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: dir,
      env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
        HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const collect = data => { output = (output + data).slice(-2000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('error', error => { clearTimeout(timer); reject(httpError('Could not run npm: ' + error.message, 500)); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(httpError('npm install failed:\n' + output.trim().slice(-800), 400));
    });
  });
}

function stopNodeApp(id) {
  const rec = nodeApps.get(id);
  if (!rec) return Promise.resolve();
  nodeApps.delete(id);
  if (rec.exited) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch {} }, 4000);
    rec.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { rec.child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

async function startNodeApp(id) {
  const dir = path.join(APPS, id);
  const entry = findAppEntry(dir);
  if (!entry) throw new Error('No Node server file found (server.js, package.json "main", index.js or app.js). If this is a frontend-only project, edit the card, choose "ZIP static site" and upload the ZIP again.');
  await stopNodeApp(id);
  const port = await pickAppPort(appPorts[id]);
  const userEnv = cardEnvForApp(id);
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8',
    ...userEnv, PORT: String(port), HOST: '0.0.0.0'
  };
  const child = spawn(process.execPath, [entry], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { child, port, sig: envSignature(userEnv), logs: [], startedAt: Date.now(), exited: false, exitCode: null };
  child.stdout.on('data', data => appLog(id, rec, data));
  child.stderr.on('data', data => appLog(id, rec, data));
  child.on('error', error => { rec.exited = true; rec.exitCode = 'spawn error'; appLog(id, rec, 'Could not start: ' + error.message); });
  child.on('exit', (code, signal) => {
    rec.exited = true;
    rec.exitCode = code === null ? signal : code;
    appLog(id, rec, `Process exited (${rec.exitCode})`);
  });
  nodeApps.set(id, rec);
  appPorts[id] = port;
  persistAppPorts();
  return rec;
}

async function syncNodeApps(list) {
  for (const card of Array.isArray(list) ? list : []) {
    const id = appId(card && card.target);
    if (!id || !fs.existsSync(path.join(APPS, id))) continue;
    const rec = nodeApps.get(id);
    if (rec && rec.sig === envSignature(cardEnvForApp(id))) continue;
    try { await startNodeApp(id); }
    catch (error) { console.error(`Could not (re)start Node app ${id}:`, error.message); }
  }
}

// Removes app folders no card points to (e.g. an upload that was never saved). Fresh uploads get a grace period.
async function sweepOrphanApps(list, minAgeMs) {
  const keep = new Set((Array.isArray(list) ? list : []).map(card => appId(card && card.target)).filter(Boolean));
  let entries;
  try { entries = fs.readdirSync(APPS, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(APPS, entry.name);
    if (entry.name.startsWith('.')) {
      if (minAgeMs === 0) await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!/^[a-f0-9-]+$/i.test(entry.name) || keep.has(entry.name.toLowerCase())) continue;
    let age;
    try { age = Date.now() - fs.statSync(full).mtimeMs; } catch { continue; }
    if (age < minAgeMs) continue;
    await stopNodeApp(entry.name);
    delete appPorts[entry.name];
    await fs.promises.rm(full, { recursive: true, force: true }).catch(error => console.error('Could not remove orphan app', entry.name, error.message));
  }
  try { persistAppPorts(); } catch {}
}

async function restoreNodeApps() {
  if (fs.existsSync(APP_PORTS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(APP_PORTS_FILE, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) appPorts = saved;
    } catch { appPorts = {}; }
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
  await sweepOrphanApps(list, 0);
  for (const card of Array.isArray(list) ? list : []) {
    const id = appId(card && card.target);
    if (!id || !fs.existsSync(path.join(APPS, id))) continue;
    try { await startNodeApp(id); }
    catch (error) { console.error(`Could not start Node app ${id}:`, error.message); }
  }
}

function appStatusPage(res, code, title, message, rec) {
  const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const logs = rec && rec.logs.length ? rec.logs.slice(-30).join('\n') : '(no output yet)';
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    '<style>body{font:16px system-ui;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}pre{background:#111;color:#ddd;padding:1rem;border-radius:8px;overflow:auto;white-space:pre-wrap}</style>' +
    `<h1>${esc(title)}</h1><p>${esc(message)}</p>${/\b(?:document|window|navigator|localStorage|addEventListener) is not defined/.test(logs)
      ? '<p><strong>This looks like a browser (frontend) project, not a Node server.</strong> Edit the card, choose <em>ZIP static site</em> and upload the ZIP again.</p>' : ''}<h2>Last output</h2><pre>${esc(logs)}</pre><p>Reload this page to try again.</p>`;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(body);
}

async function openNodeApp(req, res, id, rest, search) {
  id = id.toLowerCase();
  if (!fs.existsSync(path.join(APPS, id))) return send(res, 404, '{"error":"Node app not found"}');
  let rec = nodeApps.get(id);
  if (!rec || (rec.exited && Date.now() - rec.startedAt > APP_START_COOLDOWN)) {
    try { rec = await startNodeApp(id); }
    catch (error) { return appStatusPage(res, 500, 'The app could not start', error.message, rec); }
  }
  const ready = await waitForAppPort(rec, 8000);
  if (!ready) {
    return appStatusPage(res, 503, rec.exited ? 'The app stopped' : 'The app is not responding',
      rec.exited ? `The process exited (${rec.exitCode}).`
        : `The process is running, but nothing is listening on port ${rec.port}. Make sure the app listens on process.env.PORT.`, rec);
  }
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; }
  catch { throw httpError('Could not determine host for the app URL', 400); }
  res.writeHead(302, { Location: `http://${hostname}:${rec.port}/${rest}${search}`, 'Cache-Control': 'no-store' }).end();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const rec of nodeApps.values()) { try { rec.child.kill('SIGTERM'); } catch {} }
    process.exit(0);
  });
}

/* ---------- favicon lookup for hosted cards (HTML page, ZIP static site, ZIP Node app) ---------- */
const ICON_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon' };
const ICON_DATA_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/webp']);
const ICON_LIMIT = 1024 * 1024;
const ICON_FALLBACKS = ['favicon.ico', 'favicon.png', 'favicon.svg', 'apple-touch-icon.png', 'icon.png', 'icon.svg'];

// <link rel="icon"> / "shortcut icon" first, then apple-touch-icon. "mask-icon" is ignored.
function iconHrefsFromHtml(html) {
  const primary = [], secondary = [];
  // Quote-aware, so a '>' inside a quoted href (inline SVG) does not end the tag early.
  for (const tag of String(html).match(/<link\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>/gi) || []) {
    const attrs = {};
    tag.replace(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, (match, name, a, b, c) => {
      attrs[name.toLowerCase()] = a ?? b ?? c ?? '';
      return match;
    });
    const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
    const href = String(attrs.href || '').trim();
    if (!href) continue;
    if (rel.includes('icon')) primary.push(href);
    else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) secondary.push(href);
  }
  return primary.concat(secondary);
}

function dataUriIcon(href) {
  // data:image/svg+xml;utf8,<...>  |  data:image/png;base64,<...>  |  data:image/svg+xml;charset=utf-8;base64,<...>
  const match = /^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9.+=_-]+)*),([\s\S]*)$/i.exec(href);
  if (!match || !ICON_DATA_MIME.has(match[1].toLowerCase())) return null;
  let buffer;
  if (/;base64/i.test(match[2])) buffer = Buffer.from(match[3], 'base64');
  else {
    let text = match[3];
    try { text = decodeURIComponent(text); } catch {}
    buffer = Buffer.from(text);
  }
  return buffer.length && buffer.length <= ICON_LIMIT ? { buffer, mime: match[1].toLowerCase() } : null;
}

function localIcon(root, href) {
  let relative = href.split(/[?#]/)[0];
  try { relative = decodeURIComponent(relative); } catch { return null; }
  const base = path.resolve(root);
  const file = path.resolve(base, relative.replace(/^\/+/, ''));
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!file.startsWith(base + path.sep) || !ICON_MIME[ext]) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= ICON_LIMIT ? { file, mime: ICON_MIME[ext] } : null;
  } catch { return null; }
}

// One href from a page: inline data URI, an absolute URL (the browser loads it itself) or null for anything relative.
function absoluteIcon(href) {
  if (/^data:/i.test(href)) return dataUriIcon(href);
  if (/^https?:\/\//i.test(href)) {
    try { return { redirect: new URL(href).href }; } catch { return null; }
  }
  return null;
}
const isRelativeHref = href => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//');

// One folder: the <link rel="icon"> of its index.html first, then the usual file names.
function iconInDir(root) {
  let html = '';
  try {
    const file = path.join(root, 'index.html');
    if (fs.statSync(file).size <= ICON_LIMIT) html = fs.readFileSync(file, 'utf8');
  } catch {}
  for (const href of iconHrefsFromHtml(html)) {
    const found = isRelativeHref(href) ? localIcon(root, href) : absoluteIcon(href);
    if (found) return found;
  }
  for (const name of ICON_FALLBACKS) {
    const found = localIcon(root, name);
    if (found) return found;
  }
  return null;
}

function fetchLocal(port, pathname, wantHtml) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2500,
      headers: { Accept: wantHtml ? 'text/html' : 'image/*' } }, response => {
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (response.statusCode !== 200 || !(wantHtml ? type === 'text/html' : ICON_DATA_MIME.has(type))) {
        response.resume();
        return resolve(null);
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > ICON_LIMIT) { response.destroy(); resolve(null); } else chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: type }));
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

// For a running Node app: read what the app itself serves (it may build its HTML on the fly).
async function runningAppIcon(port) {
  const page = await fetchLocal(port, '/', true);
  const hrefs = (page ? iconHrefsFromHtml(page.buffer.toString('utf8')) : []).concat('/favicon.ico');
  let requests = 0;
  for (const href of hrefs) {
    if (!isRelativeHref(href)) {
      const found = absoluteIcon(href);
      if (found) return found;
      continue;
    }
    if (++requests > 3) break;
    let pathname;
    try { const url = new URL(href, 'http://127.0.0.1/'); pathname = url.pathname + url.search; } catch { continue; }
    const got = await fetchLocal(port, pathname, false);
    if (got) return got;
  }
  return null;
}

async function hostedFavicon(target) {
  const page = PAGE_TARGET.exec(target);
  if (page) {
    let html = '';
    try { html = fs.readFileSync(path.join(UP, path.basename(page[0])), 'utf8'); } catch { return null; }
    for (const href of iconHrefsFromHtml(html)) {
      const found = absoluteIcon(href);
      if (found) return found;
    }
    return null;
  }
  const site = /\/sites\/([a-f0-9-]+)\/?$/i.exec(target);
  if (site) {
    const directory = path.join(SITES, site[1].toLowerCase());
    return iconInDir(fs.existsSync(path.join(directory, 'index.html')) ? directory : path.join(directory, 'public'));
  }
  const id = appId(target);
  if (id) {
    for (const sub of ['public', 'static', 'dist', 'build', 'www', '.']) {
      const found = iconInDir(path.join(APPS, id, sub));
      if (found) return found;
    }
    const rec = nodeApps.get(id);
    if (rec && !rec.exited) return runningAppIcon(rec.port);
  }
  return null;
}

const hubServer = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const query = new URL(req.url, 'http://x').searchParams;

    if (p.startsWith('/__page_api/')) {
      const parsedUrl = new URL(req.url, 'http://x');
      const pageMatch = /^\/__page_api\/([a-f0-9-]+)(?=\/)/i.exec(parsedUrl.pathname);
      if (!pageMatch) return send(res, 404, '{"error":"Not found"}');
      return proxyAllowedApi(req, res, parsedUrl, `/__page_api/${pageMatch[1]}`, cardApiHosts('page', pageMatch[1]), true);
    }

    if (p === '/api/favicon' && (req.method === 'GET' || req.method === 'HEAD')) {
      const found = await hostedFavicon(String(query.get('target') || '').slice(0, 300));
      if (!found) return send(res, 404, '{"error":"No favicon found"}', { 'Cache-Control': 'no-cache' });
      if (found.redirect) { res.writeHead(302, { Location: found.redirect, 'Cache-Control': 'no-cache' }); return res.end(); }
      const body = found.buffer || fs.readFileSync(found.file);
      res.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (p === '/api/apps') {
      if (req.method === 'GET') {
        const envStore = readAppEnvStore();
        const cards = JSON.parse(fs.readFileSync(DB, 'utf8')).map(card =>
          appId(card && card.target) ? { ...card, envKeys: Object.keys(envStore[card.id] || {}) } : card);
        return send(res, 200, JSON.stringify(cards), { 'Cache-Control': 'no-store' });
      }
      if (req.method === 'PUT') {
        const rawList = JSON.parse((await readBody(req, 1e6)).toString());
        const list = clean(rawList);
        const rawById = new Map((Array.isArray(rawList) ? rawList : [])
          .filter(a => a && typeof a.id === 'string').map(a => [a.id.trim().slice(0, 40), a]));
        for (const card of list) {
          const raw = rawById.get(card.id);
          const problem = appId(card.target) && raw && typeof raw.env === 'string' ? appEnvProblem(raw.env) : '';
          if (problem) throw httpError(`Environment variables, ${problem}`, 400);
        }
        const update = appWriteQueue.then(async () => {
          const previous = JSON.parse(fs.readFileSync(DB, 'utf8'));
          fs.writeFileSync(DB + '.tmp', JSON.stringify(list, null, 2));
          fs.renameSync(DB + '.tmp', DB);
          applyEnvUpdates(list, rawById);
          const cleanupWarning = await cleanupUnusedAssets(previous, list);
          await sweepOrphanApps(list, 60 * 60 * 1000);
          await syncNodeApps(list);
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

    if (p === '/api/upload-app' && req.method === 'POST') {
      const buf = await readBody(req, ZIP_LIMIT);
      if (!buf.length) return send(res, 400, '{"error":"Empty file"}');
      const id = crypto.randomUUID();
      const temp = path.join(APPS, '.' + id + '.tmp');
      const destination = path.join(APPS, id);
      await fs.promises.mkdir(temp);
      try {
        await extractArchive(buf, temp);
        const root = findAppRoot(temp);
        if (!root) throw httpError(hasStaticIndex(temp)
          ? 'This ZIP looks like a static site (it has index.html but no Node server file such as server.js). Choose "ZIP static site" for it.'
          : 'A Node app ZIP needs server.js (or "main" in package.json, index.js or app.js). For a site without a backend, choose "ZIP static site".', 400);
        await fs.promises.rename(root, destination);
        await fs.promises.rm(temp, { recursive: true, force: true });
        await installAppDependencies(destination);
        let warning = '';
        try {
          const rec = await startNodeApp(id);
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (rec.exited) warning = 'the app exited right after starting. ' + rec.logs.slice(-3).join(' | ');
        } catch (error) { warning = error.message; }
        return send(res, 200, JSON.stringify({ url: '/apps/' + id + '/', warning }));
      } catch (error) {
        await stopNodeApp(id);
        delete appPorts[id];
        await fs.promises.rm(temp, { recursive: true, force: true });
        await fs.promises.rm(destination, { recursive: true, force: true });
        throw error;
      }
    }

    if (p === '/api/discard-upload' && req.method === 'POST') {
      let url = '';
      try { url = JSON.parse((await readBody(req, 1e4)).toString()).url; } catch {}
      if (typeof url !== 'string') url = '';
      const subject = [{ target: url, icon: url }];
      const wanted = collectAssetRefs(subject);
      if (!Object.values(wanted).some(set => set.size)) return send(res, 400, '{"error":"Not a removable upload"}');
      // Runs in the same queue as saving the card list, so it cannot race with a save that starts using the upload.
      const job = appWriteQueue.then(async () => {
        const current = JSON.parse(fs.readFileSync(DB, 'utf8'));
        const used = collectAssetRefs(current);
        for (const kind of Object.keys(wanted)) {
          for (const item of wanted[kind]) if (used[kind].has(item)) return { discarded: false };
        }
        await cleanupUnusedAssets(subject, current);
        return { discarded: true };
      });
      appWriteQueue = job.catch(error => console.error('Discarding upload failed:', error.message));
      return send(res, 200, JSON.stringify(await job));
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

    const appMatch = APP_PATH.exec(p);
    if (appMatch) {
      const parsedUrl = new URL(req.url, 'http://x');
      const rest = parsedUrl.pathname.replace(/^\/apps\/[a-f0-9-]+\/?/i, '');
      return await openNodeApp(req, res, appMatch[1], rest, parsedUrl.search);
    }

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
    let pageBody = null;
    if (isPage) {
      const pageId = path.basename(p, '.html');
      const pageHosts = cardApiHosts('page', pageId);
      h['Content-Security-Policy'] = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src ${pageHosts.length ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
      if (pageHosts.length) {
        const prefix = `/__page_api/${pageId}`;
        pageBody = Buffer.from(injectApiShim(rewriteApiHosts(fs.readFileSync(file, 'utf8'), pageHosts, prefix), pageHosts, prefix));
        h['Content-Length'] = pageBody.length;
      }
    }
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    if (pageBody) return res.end(pageBody);
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, JSON.stringify({ error: e.message }));
  }
});

restoreSiteServers().then(() => restoreNodeApps()).then(() => {
  hubServer.listen(PORT, HOST, () => {
    console.log(`AWESOME HUB running at http://${HOST}:${PORT}`);
    console.log(SITE_API_PROXY
      ? `Hosted-site API proxy enabled for ${SITE_API_PROXY.dynamicPort ? `${SITE_API_PROXY.protocol}//${SITE_API_PROXY.hostname} (any port)` : SITE_API_PROXY.origin}`
      : 'Hosted-site API proxy disabled; set SITE_API_PROXY_HOST or SITE_API_PROXY_ORIGIN to enable it.');
  });
}).catch(error => {
  console.error('Could not restore hosted sites:', error.message);
  process.exitCode = 1;
});
