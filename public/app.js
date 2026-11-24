(() => {
  const $ = s => document.querySelector(s);
  const grid = $('#grid'), dlg = $('#dlg'), root = document.documentElement;
  const P = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'
  };
  const svg = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;

  let apps = [], edit = false, editId = null, drag = null;
  let ignoreClickUntil = 0;

  /* ---------- tema ---------- */
  const mq = matchMedia('(prefers-color-scheme:dark)');
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches);
  function paint() {
    $('#btnTheme').innerHTML = svg(isDark() ? 'sun' : 'moon');
    document.querySelector('meta[name=theme-color]').content = isDark() ? '#18191b' : '#f3f5fa';
  }
  try { const t = localStorage.getItem('hub-theme'); if (t) root.dataset.theme = t; } catch {}
  $('#btnTheme').onclick = () => {
    const n = isDark() ? 'light' : 'dark';
    root.dataset.theme = n;
    try { localStorage.setItem('hub-theme', n); } catch {}
    paint();
  };
  mq.addEventListener('change', paint);
  $('#btnGear').innerHTML = svg('gear');
  paint();

  /* ---------- util ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const isPort = t => /^\d{1,5}$/.test(t);
  const href = a => (isPort(a.target) ? `${location.protocol}//${location.hostname}:${a.target}` : a.target);
  function norm(t) {
    t = t.trim();
    if (isPort(t) || /^https?:\/\//i.test(t)) return t;
    return (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(t) ? 'http://' : 'https://') + t;
  }

  const isImage = icon => /^(https?:\/\/|\/)/i.test(icon);
  function iconEl(title, icon) {
    const d = document.createElement('div');
    const letter = () => {
      d.className = 'ico'; d.innerHTML = '';
      d.style.background = `hsl(${hue(title)} 55% 42%)`;
      d.textContent = (title.trim()[0] || '?').toUpperCase();
    };
    if (icon) {
      if (isImage(icon)) {
        d.className = 'ico img';
        const i = new Image(); i.alt = ''; i.draggable = false; i.src = icon; i.onerror = letter;
        d.append(i);
      } else {
        d.className = 'ico emoji';
        d.textContent = icon;
      }
    } else letter();
    return d;
  }

  /* ---------- render ---------- */
  function btn(cls, ic, label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tbtn ' + cls; b.innerHTML = svg(ic);
    b.setAttribute('aria-label', label); b.onclick = fn;
    return b;
  }
  function tile(a) {
    const el = document.createElement(edit ? 'div' : 'a');
    el.className = 'tile' + (a.fill ? ' fill' : ''); el.dataset.id = a.id;
    if (!edit) { el.href = href(a); if (a.newTab) { el.target = '_blank'; el.rel = 'noopener'; } }
    else { el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', 'Edit ' + (a.title || 'app')); }
    if (a.fill) el.setAttribute('aria-label', a.title);
    const n = document.createElement('div'); n.className = 'name'; n.textContent = a.title;
    el.append(iconEl(a.title, a.icon));
    if (!a.fill && a.title) el.append(n);
    if (edit) el.append(btn('del', 'x', 'Delete ' + (a.title || 'app'), () => del(a)), btn('edt', 'pen', 'Edit ' + (a.title || 'app'), () => openForm(a.id)));
    return el;
  }
  function render() {
    document.body.classList.toggle('editing', edit);
    $('#btnGear').setAttribute('aria-pressed', edit);
    $('#hint').hidden = !edit;
    $('#empty').hidden = edit || apps.length > 0;
    grid.replaceChildren(...apps.map(tile));
    if (edit) {
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'tile add'; add.textContent = '+';
      add.setAttribute('aria-label', 'Add app'); add.onclick = () => openForm();
      grid.append(add);
    }
  }
  $('#btnGear').onclick = () => { edit = !edit; render(); };
  grid.addEventListener('contextmenu', e => { if (edit) e.preventDefault(); });
  grid.addEventListener('click', e => {
    const t = e.target.closest('.tile[data-id]');
    if (!edit || !t || e.target.closest('button')) return;
    if (performance.now() < ignoreClickUntil) return;
    openForm(t.dataset.id);
  });
  grid.addEventListener('keydown', e => {
    const t = e.target.closest('.tile[data-id]');
    if (!edit || !t || e.target.closest('button') || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    openForm(t.dataset.id);
  });

  /* ---------- simpan ---------- */
  async function save() {
    try {
      const r = await fetch('/api/apps', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apps) });
      if (!r.ok) throw 0;
    } catch { alert('Could not save to the server. Check that AWSOME HUB is still running.'); }
  }
  function del(a) {
    if (!confirm(`Delete "${a.title}"?`)) return;
    apps = apps.filter(x => x.id !== a.id); render(); save();
  }

  /* ---------- form tambah/edit ---------- */
  const prev = () => $('#prev').replaceChildren(iconEl($('#fTitle').value || '?', $('#fIcon').value.trim()));
  function openForm(id) {
    const a = apps.find(x => x.id === id); editId = a ? a.id : null;
    $('#dlgTitle').textContent = a ? 'Edit app' : 'Add app';
    $('#fTitle').value = a ? a.title : '';
    $('#fTarget').value = a ? a.target : '';
    $('#fIcon').value = a ? a.icon : '';
    $('#fFill').checked = a ? a.fill === true : false;
    $('#fTab').checked = a ? a.newTab : true;
    prev(); dlg.showModal();
  }
  $('#fTitle').oninput = $('#fIcon').oninput = prev;
  $('#btnCancel').onclick = () => dlg.close();
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  $('#frm').onsubmit = e => {
    e.preventDefault();
    const o = { id: editId || uid(), title: $('#fTitle').value.trim(), target: norm($('#fTarget').value),
      icon: $('#fIcon').value.trim(), fill: $('#fFill').checked, newTab: $('#fTab').checked };
    if (editId) apps = apps.map(a => (a.id === editId ? o : a)); else apps.push(o);
    dlg.close(); render(); save();
  };
  $('#btnUpload').onclick = () => $('#fFile').click();
  $('#fFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    try {
      const r = await fetch('/api/upload?ext=' + encodeURIComponent(ext), { method: 'POST', body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      $('#fIcon').value = j.url; prev();
    } catch (err) { alert('Upload failed: ' + err.message); }
  };

  /* ---------- drag and drop (mouse + sentuh) ---------- */
  grid.addEventListener('pointerdown', e => {
    if (!edit || e.button > 0 || e.target.closest('button')) return;
    const t = e.target.closest('.tile[data-id]');
    if (t) drag = { t, x: e.clientX, y: e.clientY, ghost: null };
  });
  addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      const r = drag.t.getBoundingClientRect(), g = drag.t.cloneNode(true);
      g.classList.add('ghost');
      g.style.cssText = `width:${r.width}px;height:${r.height}px`;
      drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
      document.body.append(g); drag.ghost = g; drag.t.classList.add('dragging');
    }
    drag.ghost.style.left = e.clientX - drag.dx + 'px';
    drag.ghost.style.top = e.clientY - drag.dy + 'px';
    const over = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.matches && n.matches('.tile[data-id]') && n !== drag.t);
    if (over) {
      const all = [...grid.querySelectorAll('.tile[data-id]')];
      if (all.indexOf(drag.t) < all.indexOf(over)) over.after(drag.t); else over.before(drag.t);
    }
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.ghost) return;
    ignoreClickUntil = performance.now() + 350;
    d.ghost.remove(); d.t.classList.remove('dragging');
    const ids = [...grid.querySelectorAll('.tile[data-id]')].map(t => t.dataset.id);
    apps.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    save();
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);

  /* ---------- mulai ---------- */
  fetch('/api/apps').then(r => r.json()).then(l => { apps = l; render(); }).catch(() => render());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
