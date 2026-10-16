/* ============================================================
   Estimora — Project Cost Estimator (Vanilla JS, LocalStorage)
   Tanggung jawab terpisah:
   - Util & format      : formatIDR, parseMoney, parsePct
   - Kalkulasi murni    : calcItem, calcTotals, calcMarginSuggest
   - Penyimpanan        : store (baca/tulis/validasi LocalStorage)
   - Tampilan           : render*, buildQuoteDoc (DOM aman)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Konstanta ---------- */
  var LS_EST = 'estimora.estimates.v1';
  var LS_SET = 'estimora.settings.v1';
  var LS_SEQ = 'estimora.seq.v1';
  var MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  var CATEGORIES = ['Website', 'Aplikasi', 'UI/UX Design', 'Maintenance', 'Digital Marketing', 'Lainnya'];
  var UNITS = ['jam', 'hari', 'unit', 'halaman', 'paket', 'fitur', 'lembar', 'proyek'];
  var STATUS = {
    draft: 'Draft',
    ready: 'Siap Ditawarkan',
    accepted: 'Diterima',
    rejected: 'Ditolak'
  };
  var PAGE_META = {
    dashboard: { title: 'Dashboard', sub: 'Ringkasan seluruh estimasi proyek Anda.' },
    estimator: { title: 'Buat Estimasi', sub: 'Susun rincian pekerjaan dan hitung biaya otomatis.' },
    projects: { title: 'Semua Proyek', sub: 'Kelola, cari, dan tindak lanjuti estimasi tersimpan.' },
    settings: { title: 'Pengaturan', sub: 'Profil, default dokumen, dan manajemen data.' }
  };

  /* ---------- State ---------- */
  var state = {
    page: 'dashboard',
    editingId: null,
    formNumber: '',
    items: [], // draft item pekerjaan di form
    storageOK: true,
    memFallback: { estimates: [], settings: null, seq: 0 }
  };

  /* ============================================================
     UTIL & FORMAT (terpusat)
     ============================================================ */
  function uid(prefix) {
    return (prefix || 'est_') + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clampNum(n, min, max) { return Math.min(max, Math.max(min, n)); }

  var idrFmt = null;
  try { idrFmt = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: 0 }); } catch (e) { idrFmt = null; }
  var numFmt = null;
  try { numFmt = new Intl.NumberFormat('id-ID'); } catch (e) { numFmt = null; }

  /** Format Rupiah penuh: "Rp 1.500.000" */
  function formatIDR(n) {
    var v = Math.round(Number(n) || 0);
    if (idrFmt) return idrFmt.format(v);
    return 'Rp ' + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  /** Format angka ID untuk input: 1500000 -> "1.500.000" */
  function formatNumID(n) {
    var v = Math.round(Number(n) || 0);
    if (numFmt) return numFmt.format(v);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  /**
   * Parse input uang Indonesia secara aman.
   * Titik = pemisah ribuan, koma = desimal. "1.500.000" -> 1500000.
   */
  function parseMoney(raw) {
    if (raw === null || raw === undefined) return 0;
    var s = String(raw).trim();
    if (!s) return 0;
    var neg = s.charAt(0) === '-';
    s = s.replace(/[^0-9.,]/g, '');
    if (!s) return 0;
    s = s.replace(/\./g, '').replace(/,/g, '.');
    var v = parseFloat(s);
    if (!isFinite(v)) return NaN;
    v = Math.round(v);
    return neg ? -v : v;
  }
  /** Parse persen Indonesia: "12,5" -> 12.5 */
  function parsePct(raw) {
    if (raw === null || raw === undefined) return 0;
    var s = String(raw).trim();
    if (!s) return 0;
    s = s.replace(/[^0-9.,-]/g, '').replace(/\./g, '').replace(/,/g, '.');
    // Hati-hati: "11" tanpa koma ikut terhapus titiknya — tidak masalah karena tidak ada titik.
    // Kembalikan titik ribuan yang salah terhapus untuk bilangan bulat kecil? Tidak perlu.
    // Perbaikan: jika input asli tidak mengandung koma, jangan hapus titik desimal Inggris.
    var orig = String(raw).trim();
    if (orig.indexOf(',') === -1 && /^\d+(\.\d+)?$/.test(orig)) {
      var v0 = parseFloat(orig);
      return isFinite(v0) ? v0 : NaN;
    }
    var v = parseFloat(s);
    return isFinite(v) ? v : NaN;
  }
  function parseQty(raw) {
    if (raw === null || raw === undefined) return NaN;
    var s = String(raw).trim().replace(/[^0-9.,-]/g, '').replace(/\./g, '').replace(/,/g, '.');
    var orig = String(raw).trim();
    if (orig.indexOf(',') === -1 && /^\d+(\.\d+)?$/.test(orig)) return parseFloat(orig);
    var v = parseFloat(s);
    return isFinite(v) ? v : NaN;
  }
  function formatDateID(iso) {
    if (!iso) return '—';
    var d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d.getTime())) return iso;
    try { return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return iso; }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function refreshIcons() {
    try { if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons(); } catch (e) { /* abaikan */ }
  }

  /* ============================================================
     KALKULASI MURNI (terpusat, tanpa DOM)
     ============================================================ */
  function calcItem(qty, price) {
    var q = Number(qty) || 0, p = Number(price) || 0;
    if (!(q > 0)) q = 0;
    if (!(p >= 0)) p = 0;
    return Math.round(q * p);
  }
  /**
   * Rumus konsisten sesuai spesifikasi:
   * discountAmount: nominal langsung / persen dari (subtotal+extra)
   * taxBase = max(0, beforeTax - discount)
   * tax = taxBase * rate / 100
   * total = max(0, beforeTax - discount + tax)
   */
  function calcTotals(o) {
    var itemsSubtotal = 0;
    (o.items || []).forEach(function (it) {
      itemsSubtotal += calcItem(it.qty, it.price);
    });
    var extraTotal = Math.max(0, Math.round(Number(o.labor) || 0)) +
      Math.max(0, Math.round(Number(o.operational) || 0)) +
      Math.max(0, Math.round(Number(o.other) || 0));
    var beforeTax = itemsSubtotal + extraTotal;
    var discountAmount = 0;
    if (o.discountType === 'percent') {
      var pct = clampNum(Number(o.discountValue) || 0, 0, 100);
      discountAmount = Math.round(beforeTax * pct / 100);
    } else {
      discountAmount = Math.max(0, Math.round(Number(o.discountValue) || 0));
      discountAmount = Math.min(discountAmount, beforeTax);
    }
    var taxBase = Math.max(0, beforeTax - discountAmount);
    var taxAmount = 0;
    if (o.taxEnabled) {
      var rate = clampNum(Number(o.taxRate) || 0, 0, 100);
      taxAmount = Math.round(taxBase * rate / 100);
    }
    var grandTotal = Math.max(0, beforeTax - discountAmount + taxAmount);
    return {
      itemsSubtotal: itemsSubtotal,
      extraTotal: extraTotal,
      beforeTax: beforeTax,
      discountAmount: discountAmount,
      taxBase: taxBase,
      taxAmount: taxAmount,
      grandTotal: grandTotal
    };
  }
  /**
   * Margin terhadap harga jual: price = cost / (1 - m/100)
   * Markup terhadap biaya:      price = cost * (1 + m/100)
   */
  function calcMarginSuggest(cost, pct, method) {
    cost = Math.max(0, Math.round(Number(cost) || 0));
    pct = Number(pct) || 0;
    if (!(pct >= 0) || pct >= 100) return { price: 0, profit: 0, valid: false };
    var price = method === 'markup'
      ? Math.round(cost * (1 + pct / 100))
      : Math.round(cost / (1 - pct / 100));
    return { price: price, profit: price - cost, valid: true };
  }

  /* ============================================================
     PENYIMPANAN (terpusat, LocalStorage + validasi)
     ============================================================ */
  var store = {
    available: function () {
      try {
        var k = '__estimora_probe__';
        window.localStorage.setItem(k, '1');
        window.localStorage.removeItem(k);
        return true;
      } catch (e) { return false; }
    },
    readRaw: function (key, fallback) {
      try {
        var v = window.localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) { return fallback; }
    },
    writeRaw: function (key, val) {
      try { window.localStorage.setItem(key, val); return true; }
      catch (e) { return false; }
    },
    loadEstimates: function () {
      var raw = this.readRaw(LS_EST, null);
      if (raw === null) {
        if (!state.storageOK) return state.memFallback.estimates.slice();
        return [];
      }
      var arr;
      try { arr = JSON.parse(raw); } catch (e) { return { error: 'corrupt' }; }
      if (!Array.isArray(arr)) return { error: 'corrupt' };
      var clean = [];
      for (var i = 0; i < arr.length; i++) {
        var v = validateEstimate(arr[i]);
        if (v) clean.push(v);
      }
      return clean;
    },
    saveEstimates: function (list) {
      var s = JSON.stringify(list);
      if (!state.storageOK) { state.memFallback.estimates = list.slice(); return true; }
      return this.writeRaw(LS_EST, s);
    },
    loadSettings: function () {
      var d = { vendor: '', contact: '', defaultTax: 11, showContact: true, showNotes: true, showTerms: true };
      var raw = this.readRaw(LS_SET, null);
      if (raw === null) {
        if (!state.storageOK && state.memFallback.settings) return state.memFallback.settings;
        return d;
      }
      try {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          if (typeof o.vendor === 'string') d.vendor = o.vendor.slice(0, 120);
          if (typeof o.contact === 'string') d.contact = o.contact.slice(0, 200);
          var t = parsePct(o.defaultTax);
          if (isFinite(t)) d.defaultTax = clampNum(t, 0, 100);
          d.showContact = o.showContact !== false;
          d.showNotes = o.showNotes !== false;
          d.showTerms = o.showTerms !== false;
        }
      } catch (e) { /* pakai default */ }
      return d;
    },
    saveSettings: function (s) {
      if (!state.storageOK) { state.memFallback.settings = s; return true; }
      return this.writeRaw(LS_SET, JSON.stringify(s));
    },
    nextSeq: function () {
      var n = parseInt(this.readRaw(LS_SEQ, '0'), 10);
      if (!isFinite(n) || n < 0) n = 0;
      n += 1;
      if (!state.storageOK) state.memFallback.seq = n;
      else this.writeRaw(LS_SEQ, String(n));
      return n;
    }
  };

  function validateEstimate(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.id !== 'string' || !o.id) return null;
    if (typeof o.number !== 'string' || !o.number) return null;
    var e = {
      id: String(o.id),
      number: String(o.number),
      project: String(o.project || '').slice(0, 120),
      client: String(o.client || '').slice(0, 120),
      category: String(o.category || 'Lainnya').slice(0, 60),
      description: String(o.description || '').slice(0, 2000),
      date: typeof o.date === 'string' ? o.date : todayISO(),
      deadline: typeof o.deadline === 'string' ? o.deadline : '',
      vendor: String(o.vendor || '').slice(0, 120),
      status: STATUS[o.status] ? o.status : 'draft',
      items: [],
      labor: Math.max(0, Math.round(Number(o.labor) || 0)),
      operational: Math.max(0, Math.round(Number(o.operational) || 0)),
      otherCost: Math.max(0, Math.round(Number(o.otherCost) || 0)),
      otherDesc: String(o.otherDesc || '').slice(0, 200),
      discountType: o.discountType === 'percent' ? 'percent' : 'nominal',
      discountValue: Math.max(0, Number(o.discountValue) || 0),
      taxEnabled: !!o.taxEnabled,
      taxRate: clampNum(Number(o.taxRate) || 0, 0, 100),
      marginEnabled: !!o.marginEnabled,
      marginBase: Math.max(0, Math.round(Number(o.marginBase) || 0)),
      marginPct: clampNum(Number(o.marginPct) || 0, 0, 99.99),
      marginMethod: o.marginMethod === 'markup' ? 'markup' : 'margin',
      notes: String(o.notes || '').slice(0, 2000),
      terms: String(o.terms || '').slice(0, 2000),
      totals: null,
      createdAt: o.createdAt || Date.now(),
      updatedAt: o.updatedAt || Date.now()
    };
    if (!e.project) return null;
    if (Array.isArray(o.items)) {
      for (var i = 0; i < o.items.length; i++) {
        var it = o.items[i];
        if (!it || typeof it !== 'object') continue;
        var qty = Number(it.qty), price = Number(it.price);
        if (typeof it.name !== 'string' || !it.name.trim()) continue;
        if (!(qty > 0) || !(price >= 0)) continue;
        e.items.push({
          name: String(it.name).slice(0, 120),
          desc: String(it.desc || '').slice(0, 300),
          qty: qty,
          unit: String(it.unit || 'unit').slice(0, 20),
          price: Math.round(price)
        });
      }
    }
    e.totals = calcTotals({
      items: e.items.map(function (it) { return { qty: it.qty, price: it.price }; }),
      labor: e.labor, operational: e.operational, other: e.otherCost,
      discountType: e.discountType, discountValue: e.discountValue,
      taxEnabled: e.taxEnabled, taxRate: e.taxRate
    });
    return e;
  }

  /** Nomor estimasi unik & konsisten: EST-YYYYMMDD-NNN */
  function generateNumber(existing) {
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    var seq = store.nextSeq();
    var num = 'EST-' + stamp + '-' + String(seq).padStart(3, '0');
    var guard = 0;
    while (existing.indexOf(num) !== -1 && guard < 50) {
      seq = store.nextSeq();
      num = 'EST-' + stamp + '-' + String(seq).padStart(3, '0');
      guard++;
    }
    return num;
  }
  function numberExists(list, num, exceptId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].number === num && list[i].id !== exceptId) return true;
    }
    return false;
  }

  /* ============================================================
     TOAST & DIALOG (tanpa alert browser)
     ============================================================ */
  function toast(msg, type, sub) {
    var root = document.getElementById('toast-root');
    var t = el('div', 'toast ' + (type || 'info'));
    var ic = el('span');
    var iconName = type === 'success' ? 'check-circle-2' : type === 'error' ? 'alert-circle' : 'info';
    var i = document.createElement('i'); i.setAttribute('data-lucide', iconName);
    ic.appendChild(i);
    var body = el('div');
    var m = el('div', null, msg); body.appendChild(m);
    if (sub) body.appendChild(el('small', null, sub));
    t.appendChild(ic); t.appendChild(body);
    root.appendChild(t);
    refreshIcons();
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, 3400);
  }

  var confirmCb = null;
  /** Kembalikan footer modal konfirmasi ke bentuk default (Batal + Ya). */
  function restoreConfirmFoot() {
    var modal = document.getElementById('confirm-modal');
    var foot = modal.querySelector('.modal-foot');
    foot.textContent = '';
    var cancel = el('button', 'btn btn-ghost', 'Batal');
    cancel.type = 'button';
    cancel.setAttribute('data-close', '');
    cancel.addEventListener('click', function () { closeModal('confirm-modal'); });
    var yes = el('button', 'btn btn-danger', 'Ya, lanjutkan');
    yes.type = 'button';
    yes.id = 'confirm-yes';
    yes.addEventListener('click', onConfirmYes);
    foot.appendChild(cancel); foot.appendChild(yes);
  }
  function onConfirmYes() {
    var cb = confirmCb; confirmCb = null;
    closeModal('confirm-modal');
    if (cb) cb('yes');
  }
  function askConfirm(title, msg, yesLabel, cb, extraHTML) {
    // Alur impor mengubah footer menjadi 3 tombol; kembalikan dulu agar
    // dialog konfirmasi berikutnya (hapus, reset, dsb) selalu valid.
    if (!document.getElementById('confirm-yes')) restoreConfirmFoot();
    document.getElementById('confirm-title').textContent = title;
    var m = document.getElementById('confirm-msg');
    m.textContent = msg;
    var extra = document.getElementById('confirm-extra');
    extra.textContent = '';
    if (extraHTML) {
      extra.appendChild(el('p', 'muted small', extraHTML));
    }
    document.getElementById('confirm-yes').textContent = yesLabel || 'Ya, lanjutkan';
    confirmCb = cb;
    openModal('confirm-modal');
  }

  function openModal(id) {
    var mb = document.getElementById(id);
    mb.hidden = false;
    var f = mb.querySelector('.modal');
    var btn = mb.querySelector('[data-close]');
    if (btn) btn.focus();
    refreshIcons();
  }
  function closeModal(mb) {
    if (typeof mb === 'string') mb = document.getElementById(mb);
    if (mb) mb.hidden = true;
  }

  /* ============================================================
     NAVIGASI
     ============================================================ */
  function openApp(page) {
    document.getElementById('view-landing').hidden = true;
    document.getElementById('view-app').hidden = false;
    try { window.scrollTo(0, 0); } catch (e) {}
    showPage(page || 'dashboard');
  }
  function openLanding() {
    document.getElementById('view-app').hidden = true;
    document.getElementById('view-landing').hidden = false;
    try { window.scrollTo(0, 0); } catch (e) {}
    refreshIcons();
  }
  function showPage(page) {
    if (!PAGE_META[page]) page = 'dashboard';
    state.page = page;
    ['dashboard', 'estimator', 'projects', 'settings'].forEach(function (p) {
      document.getElementById('page-' + p).hidden = (p !== page);
    });
    document.getElementById('page-title').textContent = PAGE_META[page].title;
    document.getElementById('page-subtitle').textContent = PAGE_META[page].sub;
    var links = document.querySelectorAll('#side-nav .side-link, #app-mobile-nav .side-link, .bottom-nav button');
    links.forEach(function (b) {
      if (b.dataset && b.dataset.page) b.classList.toggle('active', b.dataset.page === page);
    });
    if (page === 'dashboard') renderDashboard();
    if (page === 'projects') renderProjects();
    if (page === 'settings') renderSettings();
    if (page === 'estimator' && !state.editingId && !state.formNumber) startNewForm();
    try { document.getElementById('main-content').scrollIntoView(); } catch (e) {}
    refreshIcons();
  }

  /* ============================================================
     DASHBOARD
     ============================================================ */
  function getEstimates() {
    var r = store.loadEstimates();
    if (r && r.error === 'corrupt') {
      toast('Data tersimpan rusak dan tidak dapat dibaca.', 'error', 'Gunakan impor cadangan atau hapus data di Pengaturan.');
      return [];
    }
    return r || [];
  }

  function renderDashboard() {
    var list = getEstimates();
    var total = list.length;
    var value = list.reduce(function (a, e) { return a + (e.totals ? e.totals.grandTotal : 0); }, 0);
    var drafts = list.filter(function (e) { return e.status === 'draft'; }).length;
    var offers = list.filter(function (e) { return e.status !== 'draft'; }).length;
    document.getElementById('stat-total').textContent = String(total);
    document.getElementById('stat-value').textContent = formatIDR(value);
    document.getElementById('stat-draft').textContent = String(drafts);
    document.getElementById('stat-offers').textContent = String(offers);
    var badge = document.getElementById('nav-project-count');
    badge.hidden = total === 0;
    badge.textContent = String(total);

    document.getElementById('dash-empty').hidden = total !== 0;

    // Terbaru
    var recent = el('div');
    var sorted = list.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 5);
    var box = document.getElementById('recent-list');
    box.textContent = '';
    if (!sorted.length) {
      box.appendChild(el('p', 'muted small', 'Belum ada data. Buat estimasi pertama untuk melihat ringkasan di sini.'));
    } else {
      sorted.forEach(function (e) {
        var row = el('div', 'recent-item');
        var ic = el('span', 'ri'); var ii = document.createElement('i'); ii.setAttribute('data-lucide', 'file-text'); ic.appendChild(ii);
        var mid = el('div');
        mid.appendChild(el('strong', null, e.project));
        mid.appendChild(el('small', null, e.number + ' • ' + (STATUS[e.status] || e.status)));
        var amt = el('span', 'amt', formatIDR(e.totals.grandTotal));
        var go = el('button', 'mini-btn'); go.setAttribute('aria-label', 'Lihat ' + e.project);
        var gi = document.createElement('i'); gi.setAttribute('data-lucide', 'arrow-right'); go.appendChild(gi);
        go.addEventListener('click', function () { openDetail(e.id); });
        row.appendChild(ic); row.appendChild(mid); row.appendChild(amt); row.appendChild(go);
        box.appendChild(row);
      });
    }

    // Distribusi per kategori
    var bars = document.getElementById('category-bars');
    bars.textContent = '';
    var byCat = {};
    list.forEach(function (e) {
      var c = e.category || 'Lainnya';
      byCat[c] = (byCat[c] || 0) + (e.totals ? e.totals.grandTotal : 0);
    });
    var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
    if (!cats.length) {
      bars.appendChild(el('p', 'muted small', 'Visualisasi muncul setelah ada estimasi tersimpan.'));
      document.getElementById('dist-note').textContent = '';
    } else {
      var max = byCat[cats[0]] || 1;
      cats.slice(0, 6).forEach(function (c) {
        var row = el('div', 'bar-row');
        row.appendChild(el('span', null, c));
        var track = el('div', 'bar-track');
        var fill = el('div', 'bar-fill');
        fill.style.width = Math.max(3, Math.round(byCat[c] / max * 100)) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('strong', null, formatIDR(byCat[c])));
        bars.appendChild(row);
      });
      document.getElementById('dist-note').textContent = 'Total ' + formatIDR(value) + ' dari ' + total + ' estimasi.';
    }
    refreshIcons();
  }

  /* ============================================================
     FORM ESTIMATOR
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };

  function fillCategorySelects() {
    var sel = $('f-category');
    var keepForm = sel.value;
    sel.textContent = '';
    CATEGORIES.forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o);
    });
    if (keepForm && CATEGORIES.indexOf(keepForm) !== -1) sel.value = keepForm;
    var q = $('q-category');
    q.textContent = '';
    var all = document.createElement('option'); all.value = ''; all.textContent = 'Semua Kategori'; q.appendChild(all);
    var known = {};
    getEstimates().forEach(function (e) { known[e.category] = true; });
    CATEGORIES.concat(Object.keys(known)).filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; q.appendChild(o);
    });
  }

  function startNewForm() {
    var list = getEstimates();
    state.editingId = null;
    state.formNumber = generateNumber(list.map(function (e) { return e.number; }));
    state.items = [];
    $('estimate-form').reset();
    $('f-date').value = todayISO();
    $('f-tax-enabled').checked = false;
    $('f-margin-enabled').checked = false;
    $('margin-body').hidden = true;
    var settings = store.loadSettings();
    $('f-vendor').value = settings.vendor || '';
    if (settings.defaultTax) $('f-tax-rate').value = String(settings.defaultTax).replace('.', ',');
    $('est-number-label').textContent = state.formNumber;
    fillCategorySelects();
    renderItems();
    recalcLive();
    setErr('f-project');
  }

  function loadIntoForm(id) {
    var list = getEstimates();
    var found = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) found = list[i];
    if (!found) { toast('Estimasi tidak ditemukan.', 'error'); return; }
    state.editingId = found.id;
    state.formNumber = found.number;
    $('f-project').value = found.project;
    $('f-client').value = found.client || '';
    fillCategorySelects();
    var catSel = $('f-category');
    if (CATEGORIES.indexOf(found.category) !== -1) { catSel.value = found.category; $('f-custom-category').value = ''; }
    else { catSel.value = 'Lainnya'; $('f-custom-category').value = found.category; }
    $('f-desc').value = found.description || '';
    $('f-date').value = found.date || todayISO();
    $('f-deadline').value = found.deadline || '';
    $('f-vendor').value = found.vendor || '';
    $('f-status').value = found.status || 'draft';
    $('f-labor').value = found.labor ? formatNumID(found.labor) : '';
    $('f-operational').value = found.operational ? formatNumID(found.operational) : '';
    $('f-other').value = found.otherCost ? formatNumID(found.otherCost) : '';
    $('f-other-desc').value = found.otherDesc || '';
    $('f-disc-type').value = found.discountType || 'nominal';
    $('f-disc-value').value = found.discountType === 'percent'
      ? String(found.discountValue).replace('.', ',')
      : (found.discountValue ? formatNumID(found.discountValue) : '');
    $('f-tax-enabled').checked = !!found.taxEnabled;
    $('f-tax-rate').value = (found.taxRate !== undefined && found.taxRate !== null && found.taxRate !== '') ? String(found.taxRate).replace('.', ',') : '';
    $('f-margin-enabled').checked = !!found.marginEnabled;
    $('margin-body').hidden = !found.marginEnabled;
    $('f-margin-base').value = found.marginBase ? formatNumID(found.marginBase) : '';
    $('f-margin-pct').value = found.marginPct ? String(found.marginPct).replace('.', ',') : '';
    $('f-margin-method').value = found.marginMethod || 'margin';
    $('f-notes').value = found.notes || '';
    $('f-terms').value = found.terms || '';
    $('est-number-label').textContent = found.number;
    state.items = found.items.map(function (it) {
      return { key: uid('it_'), name: it.name, desc: it.desc || '', qty: it.qty, unit: it.unit || 'unit', price: it.price };
    });
    if (!state.items.length) state.items.push(blankItem());
    renderItems();
    recalcLive();
    showPage('estimator');
  }

  function blankItem() {
    return { key: uid('it_'), name: '', desc: '', qty: 1, unit: 'jam', price: 0 };
  }

  function renderItems() {
    var wrap = $('items-list');
    wrap.textContent = '';
    $('items-empty').hidden = state.items.length !== 0;
    state.items.forEach(function (it, idx) {
      var card = el('div', 'item-card');
      card.dataset.key = it.key;
      var head = el('div', 'item-head');
      head.appendChild(el('span', 'item-num', 'Item ' + (idx + 1)));
      head.appendChild(el('strong', null, it.name || 'Item baru'));
      var acts = el('div', 'item-actions');
      var up = el('button', 'mini-btn'); up.type = 'button'; up.title = 'Pindah ke atas'; up.setAttribute('aria-label', 'Pindah item ke atas');
      var upI = document.createElement('i'); upI.setAttribute('data-lucide', 'chevron-up'); up.appendChild(upI);
      var dn = el('button', 'mini-btn'); dn.type = 'button'; dn.title = 'Pindah ke bawah'; dn.setAttribute('aria-label', 'Pindah item ke bawah');
      var dnI = document.createElement('i'); dnI.setAttribute('data-lucide', 'chevron-down'); dn.appendChild(dnI);
      var del = el('button', 'mini-btn danger'); del.type = 'button'; del.title = 'Hapus item'; del.setAttribute('aria-label', 'Hapus item');
      var delI = document.createElement('i'); delI.setAttribute('data-lucide', 'trash-2'); del.appendChild(delI);
      up.addEventListener('click', function () { moveItem(it.key, -1); });
      dn.addEventListener('click', function () { moveItem(it.key, 1); });
      del.addEventListener('click', function () { removeItem(it.key); });
      acts.appendChild(up); acts.appendChild(dn); acts.appendChild(del);
      head.appendChild(acts);
      card.appendChild(head);

      var grid = el('div', 'item-grid');
      // Nama
      var fN = el('div', 'field full-m');
      var lN = document.createElement('label'); lN.textContent = 'Nama pekerjaan *';
      var iN = document.createElement('input'); iN.type = 'text'; iN.placeholder = 'cth: Desain homepage'; iN.maxLength = 120; iN.value = it.name || '';
      iN.setAttribute('aria-label', 'Nama pekerjaan item ' + (idx + 1));
      iN.addEventListener('input', function () { it.name = iN.value; head.querySelector('strong').textContent = iN.value || 'Item baru'; });
      fN.appendChild(lN); fN.appendChild(iN);
      // Deskripsi
      var fD = el('div', 'field full-m');
      var lD = document.createElement('label'); lD.textContent = 'Deskripsi (opsional)';
      var iD = document.createElement('input'); iD.type = 'text'; iD.placeholder = 'Rincian singkat'; iD.maxLength = 300; iD.value = it.desc || '';
      iD.addEventListener('input', function () { it.desc = iD.value; });
      fD.appendChild(lD); fD.appendChild(iD);
      // Qty
      var fQ = el('div', 'field');
      var lQ = document.createElement('label'); lQ.textContent = 'Kuantitas *';
      var iQ = document.createElement('input'); iQ.type = 'text'; iQ.inputMode = 'decimal'; iQ.placeholder = '1'; iQ.value = String(it.qty !== undefined ? it.qty : 1).replace('.', ',');
      iQ.addEventListener('input', function () {
        var v = parseQty(iQ.value);
        it.qty = isFinite(v) ? v : NaN;
        iQ.classList.toggle('invalid', !(it.qty > 0));
        recalcLive();
      });
      fQ.appendChild(lQ); fQ.appendChild(iQ);
      // Satuan
      var fU = el('div', 'field');
      var lU = document.createElement('label'); lU.textContent = 'Satuan';
      var iU = document.createElement('select');
      var units = UNITS.slice();
      if (it.unit && units.indexOf(it.unit) === -1) units.push(it.unit);
      units.forEach(function (u) {
        var o = document.createElement('option'); o.value = u; o.textContent = u;
        if (u === it.unit) o.selected = true;
        iU.appendChild(o);
      });
      iU.addEventListener('change', function () { it.unit = iU.value; });
      fU.appendChild(lU); fU.appendChild(iU);
      // Harga
      var fP = el('div', 'field');
      var lP = document.createElement('label'); lP.textContent = 'Harga satuan (Rp) *';
      var iP = document.createElement('input'); iP.type = 'text'; iP.inputMode = 'numeric'; iP.placeholder = '0';
      iP.value = it.price ? formatNumID(it.price) : '';
      iP.addEventListener('input', function () {
        var v = parseMoney(iP.value);
        it.price = isFinite(v) ? v : NaN;
        recalcLive();
      });
      iP.addEventListener('blur', function () {
        if (isFinite(it.price) && it.price >= 0) iP.value = it.price ? formatNumID(it.price) : '';
      });
      fP.appendChild(lP); fP.appendChild(iP);
      // Subtotal
      var fS = el('div', 'field');
      var lS = document.createElement('label'); lS.textContent = 'Subtotal';
      var sBox = el('div', 'subtotal', formatIDR(calcItem(it.qty, it.price)));
      sBox.id = 'sub-' + it.key;
      fS.appendChild(lS); fS.appendChild(sBox);

      grid.appendChild(fN); grid.appendChild(fD);
      grid.appendChild(fQ); grid.appendChild(fU); grid.appendChild(fP); grid.appendChild(fS);
      card.appendChild(grid);
      wrap.appendChild(card);
    });
    refreshIcons();
  }

  function moveItem(key, dir) {
    var i = -1;
    for (var k = 0; k < state.items.length; k++) if (state.items[k].key === key) i = k;
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j >= state.items.length) return;
    var tmp = state.items[i]; state.items[i] = state.items[j]; state.items[j] = tmp;
    renderItems();
  }
  function removeItem(key) {
    if (state.items.length <= 1) {
      state.items = [blankItem()];
    } else {
      state.items = state.items.filter(function (it) { return it.key !== key; });
    }
    renderItems();
    recalcLive();
  }

  function setErr(inputId, msg) {
    var p = document.querySelector('[data-err="' + inputId + '"]');
    if (!p) return;
    if (!msg) { p.hidden = true; p.textContent = ''; }
    else { p.hidden = false; p.textContent = msg; }
  }

  /** Baca seluruh form + validasi. Kembalikan {ok, data, errors} */
  function collectForm() {
    var errors = [];
    var project = $('f-project').value.trim();
    if (!project) { errors.push('Nama proyek wajib diisi.'); setErr('f-project', 'Nama proyek wajib diisi.'); }
    else setErr('f-project');

    var customCat = $('f-custom-category').value.trim();
    var category = customCat || $('f-category').value || 'Lainnya';

    // Item
    var items = [];
    var itemErr = null;
    if (!state.items.length) itemErr = 'Tambahkan minimal satu item pekerjaan.';
    state.items.forEach(function (it, idx) {
      var name = (it.name || '').trim();
      var qty = Number(it.qty);
      var price = Number(it.price);
      if (!name && !(qty > 0) && !(price > 0) && state.items.length > 1) return; // baris kosong diabaikan bila ada item lain
      if (!name) itemErr = 'Nama pekerjaan item ' + (idx + 1) + ' wajib diisi.';
      else if (!(qty > 0)) itemErr = 'Kuantitas item "' + name + '" harus lebih besar dari nol.';
      else if (!(price >= 0) || !isFinite(price)) itemErr = 'Harga satuan item "' + name + '" tidak boleh negatif.';
      else items.push({ name: name.slice(0, 120), desc: (it.desc || '').slice(0, 300), qty: qty, unit: (it.unit || 'unit').slice(0, 20), price: Math.round(price) });
    });
    if (!items.length && !itemErr) itemErr = 'Tambahkan minimal satu item pekerjaan yang valid.';
    if (itemErr) errors.push(itemErr);

    var labor = parseMoney($('f-labor').value);
    var operational = parseMoney($('f-operational').value);
    var other = parseMoney($('f-other').value);
    if (!isFinite(labor) || labor < 0) errors.push('Biaya tenaga kerja tidak boleh negatif.');
    if (!isFinite(operational) || operational < 0) errors.push('Biaya operasional tidak boleh negatif.');
    if (!isFinite(other) || other < 0) errors.push('Biaya lain tidak boleh negatif.');
    labor = Math.max(0, labor || 0); operational = Math.max(0, operational || 0); other = Math.max(0, other || 0);

    var discType = $('f-disc-type').value === 'percent' ? 'percent' : 'nominal';
    var discRaw = $('f-disc-value').value;
    var discVal = discType === 'percent' ? parsePct(discRaw) : parseMoney(discRaw);
    if (!isFinite(discVal) || discVal < 0) { errors.push('Nilai diskon tidak valid.'); setErr('f-disc-value', 'Nilai diskon tidak valid. Gunakan angka ≥ 0.'); }
    else if (discType === 'percent' && discVal > 100) { errors.push('Diskon persentase maksimal 100%.'); setErr('f-disc-value', 'Diskon persentase harus antara 0–100%.'); }
    else setErr('f-disc-value');

    var taxEnabled = $('f-tax-enabled').checked;
    var taxRate = parsePct($('f-tax-rate').value || '0');
    if (taxEnabled) {
      if (!isFinite(taxRate) || taxRate < 0 || taxRate > 100) { errors.push('Tarif pajak harus antara 0–100%.'); setErr('f-tax-rate', 'Tarif pajak harus antara 0–100%.'); }
      else setErr('f-tax-rate');
    } else { setErr('f-tax-rate'); taxRate = isFinite(taxRate) ? clampNum(taxRate, 0, 100) : 0; }

    var marginEnabled = $('f-margin-enabled').checked;
    var marginBase = parseMoney($('f-margin-base').value || '0');
    var marginPct = parsePct($('f-margin-pct').value || '0');
    var marginMethod = $('f-margin-method').value === 'markup' ? 'markup' : 'margin';
    if (marginEnabled) {
      if (!isFinite(marginBase) || marginBase < 0) errors.push('Biaya dasar margin tidak boleh negatif.');
      if (!isFinite(marginPct) || marginPct < 0 || marginPct >= 100) { errors.push('Target margin harus ≥ 0 dan kurang dari 100%.'); setErr('f-margin-pct', 'Margin harus berada pada rentang 0 hingga di bawah 100%.'); }
      else setErr('f-margin-pct');
      marginBase = Math.max(0, marginBase || 0);
    } else setErr('f-margin-pct');

    var totals = calcTotals({
      items: items.map(function (x) { return { qty: x.qty, price: x.price }; }),
      labor: labor, operational: operational, other: other,
      discountType: discType, discountValue: isFinite(discVal) ? discVal : 0,
      taxEnabled: taxEnabled, taxRate: isFinite(taxRate) ? taxRate : 0
    });

    var data = {
      project: project.slice(0, 120),
      client: $('f-client').value.trim().slice(0, 120),
      category: category.slice(0, 60),
      description: $('f-desc').value.trim().slice(0, 2000),
      date: $('f-date').value || todayISO(),
      deadline: $('f-deadline').value || '',
      vendor: $('f-vendor').value.trim().slice(0, 120),
      status: STATUS[$('f-status').value] ? $('f-status').value : 'draft',
      items: items,
      labor: labor, operational: operational,
      otherCost: other, otherDesc: $('f-other-desc').value.trim().slice(0, 200),
      discountType: discType, discountValue: isFinite(discVal) ? discVal : 0,
      taxEnabled: taxEnabled, taxRate: isFinite(taxRate) ? taxRate : 0,
      marginEnabled: marginEnabled, marginBase: marginBase || 0,
      marginPct: isFinite(marginPct) ? marginPct : 0, marginMethod: marginMethod,
      notes: $('f-notes').value.trim().slice(0, 2000),
      terms: $('f-terms').value.trim().slice(0, 2000),
      totals: totals
    };
    return { ok: errors.length === 0, data: data, errors: errors };
  }

  function currentTotalsForPreview() {
    var r = collectFormSilent();
    return r;
  }
  function collectFormSilent() {
    // Versi tanpa menampilkan error nama proyek (untuk live preview/ringkasan)
    var project = $('f-project').value.trim() || 'Tanpa Nama Proyek';
    var customCat = $('f-custom-category').value.trim();
    var items = state.items.map(function (it) {
      return { name: (it.name || '').trim() || 'Item', desc: it.desc || '', qty: Number(it.qty) || 0, unit: it.unit || 'unit', price: Number(it.price) || 0 };
    });
    var discType = $('f-disc-type').value === 'percent' ? 'percent' : 'nominal';
    var discVal = discType === 'percent' ? parsePct($('f-disc-value').value) : parseMoney($('f-disc-value').value);
    var totals = calcTotals({
      items: items, labor: parseMoney($('f-labor').value) || 0,
      operational: parseMoney($('f-operational').value) || 0, other: parseMoney($('f-other').value) || 0,
      discountType: discType, discountValue: isFinite(discVal) ? discVal : 0,
      taxEnabled: $('f-tax-enabled').checked, taxRate: parsePct($('f-tax-rate').value) || 0
    });
    var mBase = parseMoney($('f-margin-base').value) || 0;
    var mPct = parsePct($('f-margin-pct').value) || 0;
    var m = calcMarginSuggest(mBase, mPct, $('f-margin-method').value);
    return {
      project: project, client: $('f-client').value.trim(), category: customCat || $('f-category').value || 'Lainnya',
      description: $('f-desc').value.trim(), date: $('f-date').value || todayISO(), deadline: $('f-deadline').value || '',
      vendor: $('f-vendor').value.trim(), number: state.formNumber, status: $('f-status').value,
      items: items, labor: parseMoney($('f-labor').value) || 0, operational: parseMoney($('f-operational').value) || 0,
      otherCost: parseMoney($('f-other').value) || 0, otherDesc: $('f-other-desc').value.trim(),
      discountType: discType, discountValue: isFinite(discVal) ? discVal : 0,
      taxEnabled: $('f-tax-enabled').checked, taxRate: parsePct($('f-tax-rate').value) || 0,
      marginEnabled: $('f-margin-enabled').checked, marginBase: mBase, marginPct: mPct,
      marginMethod: $('f-margin-method').value, marginSuggest: m,
      notes: $('f-notes').value.trim(), terms: $('f-terms').value.trim(), totals: totals
    };
  }

  function recalcLive() {
    var d = collectFormSilent();
    // Update subtotal per item
    state.items.forEach(function (it) {
      var n = document.getElementById('sub-' + it.key);
      if (n) n.textContent = formatIDR(calcItem(Number(it.qty) || 0, Number(it.price) || 0));
    });
    $('s-subtotal').textContent = formatIDR(d.totals.itemsSubtotal);
    $('s-extra').textContent = formatIDR(d.totals.extraTotal);
    $('s-before').textContent = formatIDR(d.totals.beforeTax);
    $('s-discount').textContent = '− ' + formatIDR(d.totals.discountAmount);
    $('s-taxbase').textContent = formatIDR(d.totals.taxBase);
    $('s-tax').textContent = formatIDR(d.totals.taxAmount);
    $('s-total').textContent = formatIDR(d.totals.grandTotal);
    if (d.marginEnabled && d.marginSuggest.valid) {
      $('s-margin-row').hidden = false;
      $('s-margin').textContent = formatIDR(d.marginSuggest.profit) + ' (' + String(d.marginPct).replace('.', ',') + '%)';
      $('margin-suggest').textContent = formatIDR(d.marginSuggest.price);
      $('margin-profit').textContent = 'Keuntungan: ' + formatIDR(d.marginSuggest.profit) + ' • Harga jual saran sebelum pajak: ' + formatIDR(d.marginSuggest.price);
    } else {
      $('s-margin-row').hidden = true;
      if (d.marginEnabled) {
        $('margin-suggest').textContent = 'Rp 0';
        $('margin-profit').textContent = 'Target margin harus ≥ 0 dan kurang dari 100%.';
      }
    }
  }

  function saveEstimate(statusOverride, btn) {
    if (btn) { btn.disabled = true; setTimeout(function () { btn.disabled = false; }, 900); }
    var r = collectForm();
    if (!r.ok) {
      toast('Periksa kembali isian formulir.', 'error', r.errors[0]);
      var bad = document.getElementById('f-project');
      if (bad && !r.data.project) bad.focus();
      showPage('estimator');
      return false;
    }
    var list = getEstimates();
    var now = Date.now();
    if (state.editingId) {
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === state.editingId) idx = i;
      if (idx === -1) { toast('Data yang diedit tidak ditemukan.', 'error'); return false; }
      if (numberExists(list, state.formNumber, state.editingId)) {
        toast('Nomor estimasi ganda terdeteksi.', 'error', 'Nomor dibuat ulang otomatis.');
        state.formNumber = generateNumber(list.map(function (e) { return e.number; }));
        $('est-number-label').textContent = state.formNumber;
      }
      var prev = list[idx];
      list[idx] = Object.assign({}, r.data, {
        id: prev.id, number: state.formNumber,
        createdAt: prev.createdAt, updatedAt: now,
        status: statusOverride || r.data.status
      });
      list[idx].totals = calcTotals({
        items: list[idx].items, labor: list[idx].labor, operational: list[idx].operational, other: list[idx].otherCost,
        discountType: list[idx].discountType, discountValue: list[idx].discountValue,
        taxEnabled: list[idx].taxEnabled, taxRate: list[idx].taxRate
      });
      if (!store.saveEstimates(list)) toast('Gagal menyimpan ke LocalStorage.', 'error', 'Ruang penyimpanan mungkin penuh.');
      else toast('Perubahan estimasi disimpan.', 'success', state.formNumber);
    } else {
      if (numberExists(list, state.formNumber, null)) {
        state.formNumber = generateNumber(list.map(function (e) { return e.number; }));
        $('est-number-label').textContent = state.formNumber;
      }
      var rec = Object.assign({}, r.data, {
        id: uid('est_'), number: state.formNumber,
        createdAt: now, updatedAt: now,
        status: statusOverride || r.data.status
      });
      list.push(rec);
      if (!store.saveEstimates(list)) toast('Gagal menyimpan ke LocalStorage.', 'error', 'Ruang penyimpanan mungkin penuh.');
      else toast(statusOverride === 'draft' ? 'Draft estimasi disimpan.' : 'Estimasi disimpan.', 'success', rec.number);
      state.editingId = rec.id;
    }
    fillCategorySelects();
    renderDashboard();
    return true;
  }

  /* ============================================================
     DOKUMEN PENAWARAN (dibangun dengan DOM aman)
     ============================================================ */
  function buildQuoteDoc(mount, d, settings) {
    mount.textContent = '';
    var s = settings || store.loadSettings();
    var head = el('div', 'qd-head');
    var left = el('div');
    var vendorName = d.vendor || s.vendor || 'Freelancer / Perusahaan';
    left.appendChild(el('h2', null, vendorName));
    if (s.showContact && s.contact) left.appendChild(el('small', null, s.contact));
    left.appendChild(el('small', null, 'PENAWARAN HARGA PROYEK'));
    var right = el('div', 'qd-num');
    right.appendChild(el('strong', null, d.number || '—'));
    right.appendChild(el('small', null, 'Tanggal: ' + formatDateID(d.date)));
    if (d.deadline) right.appendChild(el('small', null, 'Tenggat: ' + formatDateID(d.deadline)));
    head.appendChild(left); head.appendChild(right);
    mount.appendChild(head);

    var body = el('div', 'qd-body');
    var meta = el('div', 'qd-meta');
    var cBox = el('div');
    cBox.appendChild(el('h4', null, 'Disiapkan Untuk'));
    cBox.appendChild(el('div', null, d.client || '—'));
    var pBox = el('div');
    pBox.appendChild(el('h4', null, 'Informasi Proyek'));
    pBox.appendChild(el('div', null, (d.project || '—') + ' • ' + (d.category || 'Lainnya')));
    if (d.description) { var desc = el('p', 'muted small', d.description); pBox.appendChild(desc); }
    meta.appendChild(cBox); meta.appendChild(pBox);
    body.appendChild(meta);

    var table = document.createElement('table');
    table.className = 'qd-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['No', 'Pekerjaan', 'Qty', 'Harga Satuan', 'Subtotal'].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = document.createElement('tbody');
    if (!d.items || !d.items.length) {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td'); td0.colSpan = 5; td0.textContent = 'Tidak ada rincian pekerjaan.'; tr0.appendChild(td0); tb.appendChild(tr0);
    } else {
      d.items.forEach(function (it, i) {
        var tr = document.createElement('tr');
        var tdN = document.createElement('td'); tdN.textContent = String(i + 1);
        var tdJ = document.createElement('td');
        var b = el('strong', null, it.name);
        tdJ.appendChild(b);
        if (it.desc) { tdJ.appendChild(document.createElement('br')); var sm = el('small', 'muted', it.desc); tdJ.appendChild(sm); }
        var tdQ = document.createElement('td'); tdQ.textContent = String(it.qty).replace('.', ',') + ' ' + (it.unit || '');
        var tdH = document.createElement('td'); tdH.textContent = formatIDR(it.price);
        var tdS = document.createElement('td'); tdS.textContent = formatIDR(calcItem(it.qty, it.price));
        tr.appendChild(tdN); tr.appendChild(tdJ); tr.appendChild(tdQ); tr.appendChild(tdH); tr.appendChild(tdS);
        tb.appendChild(tr);
      });
    }
    table.appendChild(tb);
    body.appendChild(table);

    var totals = el('div', 'qd-totals');
    function row(label, val, grand) {
      var dv = el('div', grand ? 'grand' : null);
      dv.appendChild(el('span', null, label));
      dv.appendChild(el('strong', null, val));
      totals.appendChild(dv);
    }
    row('Subtotal pekerjaan', formatIDR(d.totals.itemsSubtotal));
    if (d.totals.extraTotal > 0) row('Biaya tambahan', formatIDR(d.totals.extraTotal));
    if (d.totals.discountAmount > 0) row('Diskon', '− ' + formatIDR(d.totals.discountAmount));
    if (d.taxEnabled) row('Pajak (' + String(d.taxRate).replace('.', ',') + '%)', formatIDR(d.totals.taxAmount));
    row('Total Estimasi', formatIDR(d.totals.grandTotal), true);
    body.appendChild(totals);

    if (d.marginEnabled && d.marginSuggest && d.marginSuggest.valid) {
      var mp = el('p', 'muted small', 'Estimasi biaya dasar ' + formatIDR(d.marginBase) + ' • Target ' +
        (d.marginMethod === 'markup' ? 'markup' : 'margin') + ' ' + String(d.marginPct).replace('.', ',') +
        '% • Keuntungan ' + formatIDR(d.marginSuggest.profit) + '.');
      body.appendChild(mp);
    }
    if (s.showNotes && d.notes) {
      body.appendChild(el('h4', null, 'Catatan'));
      body.appendChild(el('p', null, d.notes));
    }
    if (s.showTerms && d.terms) {
      body.appendChild(el('h4', null, 'Ketentuan Pembayaran'));
      body.appendChild(el('p', null, d.terms));
    }
    var foot = el('p', 'muted small', 'Dokumen ini adalah estimasi biaya, bukan harga final yang pasti. Berlaku sesuai kesepakatan dengan klien.');
    body.appendChild(foot);
    mount.appendChild(body);
  }

  function openPreview() {
    var r = collectForm();
    var d;
    if (!r.ok) {
      // Tetap izinkan pratinjau? Tidak — minta perbaiki dulu agar nilai benar.
      toast('Lengkapi isian sebelum pratinjau.', 'error', r.errors[0]);
      return;
    }
    d = Object.assign({}, r.data, { number: state.formNumber, marginSuggest: calcMarginSuggest(r.data.marginBase, r.data.marginPct, r.data.marginMethod) });
    buildQuoteDoc($('quote-doc'), d, store.loadSettings());
    state._previewData = d;
    openModal('preview-modal');
  }

  function doPrint(data) {
    var pa = $('print-area');
    pa.textContent = '';
    pa.hidden = false;
    var doc = el('div', 'quote-doc');
    buildQuoteDoc(doc, data, store.loadSettings());
    pa.appendChild(doc);
    // Beri waktu render sebelum dialog print browser terbuka
    setTimeout(function () {
      window.print();
      // Jangan klaim PDF terunduh — hanya dialog print browser yang dibuka.
      toast('Dialog cetak browser dibuka.', 'info', 'Pilih "Simpan sebagai PDF" untuk menyimpan PDF.');
    }, 60);
  }

  /* ============================================================
     DETAIL / DUPLIKAT / HAPUS / STATUS
     ============================================================ */
  function openDetail(id) {
    var list = getEstimates();
    var found = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) found = list[i];
    if (!found) { toast('Estimasi tidak ditemukan.', 'error'); return; }
    var b = $('detail-body');
    b.textContent = '';
    var kv = el('dl', 'kv');
    function add(k, v) {
      var dt = document.createElement('dt'); dt.textContent = k;
      var dd = document.createElement('dd'); dd.textContent = v;
      kv.appendChild(dt); kv.appendChild(dd);
    }
    add('Nomor', found.number);
    add('Proyek', found.project);
    add('Klien', found.client || '—');
    add('Kategori', found.category || '—');
    add('Status', STATUS[found.status] || found.status);
    add('Tanggal', formatDateID(found.date));
    add('Total estimasi', formatIDR(found.totals.grandTotal));
    b.appendChild(kv);
    var h = el('h4', null, 'Rincian (' + found.items.length + ' item)');
    b.appendChild(h);
    var ul = el('div');
    found.items.forEach(function (it, i) {
      var row = el('p', 'small', (i + 1) + '. ' + it.name + ' — ' + String(it.qty).replace('.', ',') + ' ' + it.unit + ' × ' + formatIDR(it.price) + ' = ' + formatIDR(calcItem(it.qty, it.price)));
      ul.appendChild(row);
    });
    b.appendChild(ul);
    $('detail-edit').onclick = function () { closeModal('detail-modal'); loadIntoForm(found.id); };
    $('detail-print').onclick = function () {
      closeModal('detail-modal');
      var dd = Object.assign({}, found, { marginSuggest: calcMarginSuggest(found.marginBase, found.marginPct, found.marginMethod) });
      doPrint(dd);
    };
    openModal('detail-modal');
  }

  function duplicateEstimate(id) {
    var list = getEstimates();
    var src = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) src = list[i];
    if (!src) { toast('Data sumber tidak ditemukan.', 'error'); return; }
    var copy = JSON.parse(JSON.stringify(src));
    copy.id = uid('est_');
    copy.number = generateNumber(list.map(function (e) { return e.number; }));
    copy.project = (src.project + ' (Salinan)').slice(0, 120);
    copy.status = 'draft';
    var now = Date.now();
    copy.createdAt = now; copy.updatedAt = now;
    list.push(copy);
    if (store.saveEstimates(list)) {
      toast('Estimasi diduplikasi.', 'success', copy.number);
      renderProjects(); renderDashboard(); fillCategorySelects();
    } else toast('Gagal menyimpan duplikat.', 'error');
  }

  function deleteEstimate(id) {
    var list = getEstimates();
    var found = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) found = list[i];
    if (!found) return;
    askConfirm('Hapus estimasi?', 'Hapus "' + found.project + '" (' + found.number + ')? Tindakan ini tidak dapat dibatalkan.', 'Ya, hapus', function () {
      var l2 = getEstimates().filter(function (e) { return e.id !== id; });
      if (store.saveEstimates(l2)) {
        toast('Estimasi dihapus.', 'success');
        renderProjects(); renderDashboard(); fillCategorySelects();
      } else toast('Gagal menghapus data.', 'error');
    });
  }

  /* ============================================================
     DAFTAR PROYEK (cari / filter / urut)
     ============================================================ */
  function filteredProjects() {
    var list = getEstimates();
    var q = ($('q-search').value || '').toLowerCase().trim();
    var cat = $('q-category').value;
    var st = $('q-status').value;
    var sort = $('q-sort').value;
    var out = list.filter(function (e) {
      if (cat && e.category !== cat) return false;
      if (st && e.status !== st) return false;
      if (q) {
        var hay = (e.project + ' ' + e.client + ' ' + e.number).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      if (sort === 'oldest') return (a.createdAt || 0) - (b.createdAt || 0);
      if (sort === 'highest') return (b.totals.grandTotal || 0) - (a.totals.grandTotal || 0);
      if (sort === 'lowest') return (a.totals.grandTotal || 0) - (b.totals.grandTotal || 0);
      if (sort === 'name') return String(a.project).localeCompare(String(b.project), 'id');
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return { all: list.length, rows: out };
  }

  function statusBadge(st) {
    var s = el('span', 'badge-status st-' + st, STATUS[st] || st);
    return s;
  }

  function renderProjects() {
    fillCategorySelectsPreserve();
    var res = filteredProjects();
    $('projects-count').textContent = 'Menampilkan ' + res.rows.length + ' dari ' + res.all + ' estimasi.';
    var tb = $('projects-tbody');
    tb.textContent = '';
    var cards = $('projects-cards');
    cards.textContent = '';
    $('projects-empty').hidden = res.rows.length !== 0;

    res.rows.forEach(function (e) {
      // Baris tabel desktop
      var tr = document.createElement('tr');
      var tdN = document.createElement('td');
      var code = el('span', 't-num', e.number); tdN.appendChild(code);
      var tdP = document.createElement('td'); tdP.className = 't-proj';
      tdP.appendChild(el('strong', null, e.project));
      tdP.appendChild(el('small', null, (e.client || 'Tanpa klien') + ' • ' + formatDateID(e.date)));
      var tdC = document.createElement('td'); tdC.appendChild(el('span', null, e.category || '—'));
      var tdA = document.createElement('td'); tdA.className = 't-amt'; tdA.textContent = formatIDR(e.totals.grandTotal);
      var tdS = document.createElement('td');
      var sel = document.createElement('select');
      sel.className = 'status-select';
      sel.setAttribute('aria-label', 'Ubah status ' + e.project);
      Object.keys(STATUS).forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = STATUS[k];
        if (k === e.status) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { changeStatus(e.id, sel.value); });
      tdS.appendChild(sel);
      var tdU = document.createElement('td'); tdU.textContent = formatDateID((new Date(e.updatedAt)).toISOString().slice(0, 10));
      var tdA2 = document.createElement('td');
      tdA2.appendChild(actionButtons(e));
      tr.appendChild(tdN); tr.appendChild(tdP); tr.appendChild(tdC); tr.appendChild(tdA); tr.appendChild(tdS); tr.appendChild(tdU); tr.appendChild(tdA2);
      tb.appendChild(tr);

      // Kartu mobile
      var card = el('div', 'proj-card');
      var hrow = el('div', 'card-head');
      hrow.appendChild(el('h4', null, e.project));
      hrow.appendChild(statusBadge(e.status));
      card.appendChild(hrow);
      card.appendChild(el('p', 'muted small', e.number + ' • ' + (e.client || 'Tanpa klien')));
      var amtRow = el('div', 'card-head');
      amtRow.appendChild(el('strong', null, formatIDR(e.totals.grandTotal)));
      amtRow.appendChild(el('small', 'muted', e.category + ' • ' + formatDateID(e.date)));
      card.appendChild(amtRow);
      card.appendChild(actionButtons(e));
      cards.appendChild(card);
    });
    refreshIcons();
  }

  function fillCategorySelectsPreserve() {
    var cur = $('q-category').value;
    fillCategorySelects();
    var q = $('q-category');
    var has = false;
    for (var i = 0; i < q.options.length; i++) if (q.options[i].value === cur) has = true;
    q.value = has ? cur : '';
  }

  function actionButtons(e) {
    var wrap = el('div', 'row-actions');
    function mk(icon, label, fn, danger) {
      var b = el('button', 'mini-btn' + (danger ? ' danger' : ''));
      b.type = 'button'; b.title = label; b.setAttribute('aria-label', label + ': ' + e.project);
      var i = document.createElement('i'); i.setAttribute('data-lucide', icon); b.appendChild(i);
      b.addEventListener('click', fn);
      return b;
    }
    wrap.appendChild(mk('eye', 'Lihat detail', function () { openDetail(e.id); }));
    wrap.appendChild(mk('pencil', 'Edit estimasi', function () { loadIntoForm(e.id); }));
    wrap.appendChild(mk('copy', 'Duplikasi estimasi', function () { duplicateEstimate(e.id); }));
    wrap.appendChild(mk('printer', 'Cetak ulang penawaran', function () {
      var d = Object.assign({}, e, { marginSuggest: calcMarginSuggest(e.marginBase, e.marginPct, e.marginMethod) });
      doPrint(d);
    }));
    wrap.appendChild(mk('trash-2', 'Hapus estimasi', function () { deleteEstimate(e.id); }, true));
    return wrap;
  }

  function changeStatus(id, st) {
    if (!STATUS[st]) return;
    var list = getEstimates();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list[i].status = st;
        list[i].updatedAt = Date.now();
      }
    }
    if (store.saveEstimates(list)) {
      toast('Status diperbarui.', 'success', STATUS[st]);
      renderProjects(); renderDashboard();
    } else toast('Gagal memperbarui status.', 'error');
  }

  /* ============================================================
     PENGATURAN + EKSPOR/IMPOR
     ============================================================ */
  function renderSettings() {
    var s = store.loadSettings();
    $('s-vendor').value = s.vendor || '';
    $('s-contact').value = s.contact || '';
    $('s-tax').value = String(s.defaultTax).replace('.', ',');
    $('s-show-contact').checked = s.showContact !== false;
    $('s-show-notes').checked = s.showNotes !== false;
    $('s-show-terms').checked = s.showTerms !== false;
    var n = getEstimates().length;
    var bytes = (store.readRaw(LS_EST, '') || '').length;
    $('storage-info').textContent = n + ' estimasi tersimpan • ±' + (bytes / 1024).toFixed(1) + ' KB di LocalStorage perangkat ini.';
  }

  function saveSettings() {
    var tax = parsePct($('s-tax').value || '0');
    if (!isFinite(tax) || tax < 0 || tax > 100) { toast('Tarif pajak default tidak valid.', 'error', 'Gunakan angka 0–100.'); return; }
    var s = {
      vendor: $('s-vendor').value.trim().slice(0, 120),
      contact: $('s-contact').value.trim().slice(0, 200),
      defaultTax: tax,
      showContact: $('s-show-contact').checked,
      showNotes: $('s-show-notes').checked,
      showTerms: $('s-show-terms').checked
    };
    if (store.saveSettings(s)) toast('Pengaturan disimpan.', 'success');
    else toast('Gagal menyimpan pengaturan.', 'error');
  }

  function exportJSON() {
    var list = getEstimates();
    var payload = { app: 'estimora', version: 1, exportedAt: new Date().toISOString(), estimates: list, settings: store.loadSettings() };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'estimora-backup-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('File cadangan diunduh.', 'success', list.length + ' estimasi diekspor.');
  }

  function importJSON(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { toast('File terlalu besar.', 'error', 'Maksimal 5 MB.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try { obj = JSON.parse(String(reader.result)); }
      catch (e) { toast('File JSON tidak valid.', 'error', 'Pastikan file berasal dari ekspor Estimora.'); return; }
      var arr = Array.isArray(obj) ? obj : obj.estimates;
      if (!Array.isArray(arr)) { toast('Struktur file tidak dikenali.', 'error', 'Harus berisi daftar estimasi.'); return; }
      if (arr.length > 2000) { toast('Jumlah data melebihi batas wajar.', 'error', 'Maksimal 2000 estimasi per impor.'); return; }
      var valid = [], rejected = 0;
      arr.forEach(function (o) { var v = validateEstimate(o); if (v) valid.push(v); else rejected++; });
      if (!valid.length) { toast('Tidak ada data valid untuk diimpor.', 'error', rejected + ' baris ditolak.'); return; }
      askConfirm('Impor ' + valid.length + ' estimasi?',
        (rejected ? rejected + ' baris tidak valid dan akan dilewati. ' : '') + 'Pilih "Gabung" untuk menambah tanpa menghapus data lama, atau "Ganti" untuk menimpa seluruh data.',
        'Gabung data', function (mode) {
          var cur = getEstimates();
          var nums = {};
          cur.forEach(function (e) { nums[e.number] = true; nums[e.id] = true; });
          valid.forEach(function (v) {
            if (nums[v.id] || nums[v.number]) { v.id = uid('est_'); v.number = generateNumber(cur.concat(valid).map(function (e) { return e.number; })); }
            nums[v.id] = true; nums[v.number] = true;
          });
          var next = mode === 'replace' ? valid : cur.concat(valid);
          if (store.saveEstimates(next)) {
            toast('Impor berhasil.', 'success', valid.length + ' estimasi ' + (mode === 'replace' ? 'menggantikan' : 'ditambahkan') + '.');
            renderProjects(); renderDashboard(); $('file-import').value = '';
          } else toast('Gagal menyimpan hasil impor.', 'error');
        }, null);
      // Ubah tombol konfirmasi menjadi dua pilihan Gabung/Ganti
      var yesBtn = $('confirm-yes');
      var foot = yesBtn.parentElement;
      foot.textContent = '';
      var cancel = el('button', 'btn btn-ghost', 'Batal');
      cancel.addEventListener('click', function () { closeModal('confirm-modal'); });
      var replace = el('button', 'btn btn-outline', 'Ganti semua');
      var merge = el('button', 'btn btn-danger', 'Gabung data');
      var cb = confirmCb;
      merge.addEventListener('click', function () { closeModal('confirm-modal'); confirmCb = null; cb('merge'); });
      replace.addEventListener('click', function () { closeModal('confirm-modal'); confirmCb = null; cb('replace'); });
      foot.appendChild(cancel); foot.appendChild(replace); foot.appendChild(merge);
    };
    reader.readAsText(file);
  }

  /* ============================================================
     INIT & EVENT BINDING
     ============================================================ */
  function bindEvents() {
    // Landing
    document.querySelectorAll('[data-action="open-app"]').forEach(function (b) {
      b.addEventListener('click', function () { openApp(b.dataset.page || 'dashboard'); });
    });
    var ham = $('hamburger'), mm = $('mobile-menu');
    ham.addEventListener('click', function () {
      var open = mm.hidden;
      mm.hidden = !open;
      ham.setAttribute('aria-expanded', String(open));
    });
    mm.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { mm.hidden = true; }); });
    $('brand-home').addEventListener('click', function (e) { e.preventDefault(); try { window.scrollTo(0, 0); } catch (x) {} });
    $('btn-back-landing').addEventListener('click', openLanding);

    // Navigasi app (delegasi)
    document.querySelectorAll('#side-nav .side-link[data-page], #app-mobile-nav .side-link, .bottom-nav button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.page === 'estimator' && state.page !== 'estimator' && !state.editingId && !state.formNumber) startNewForm();
        showPage(b.dataset.page);
        $('app-mobile-nav').hidden = true;
      });
    });
    $('mobile-nav-btn').addEventListener('click', function () {
      var m = $('app-mobile-nav');
      m.hidden = !m.hidden;
    });
    document.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.goto === 'estimator' && !state.editingId && !state.formNumber) startNewForm();
        showPage(b.dataset.goto);
      });
    });
    $('header-cta').addEventListener('click', function () { startNewForm(); showPage('estimator'); });

    // Estimator
    $('btn-add-item').addEventListener('click', function () {
      state.items.push(blankItem());
      renderItems();
      recalcLive();
    });
    ['f-project', 'f-client', 'f-category', 'f-custom-category', 'f-desc', 'f-date', 'f-deadline', 'f-vendor', 'f-status',
     'f-labor', 'f-operational', 'f-other', 'f-other-desc', 'f-disc-type', 'f-disc-value',
     'f-tax-enabled', 'f-tax-rate', 'f-margin-enabled', 'f-margin-base', 'f-margin-pct', 'f-margin-method',
     'f-notes', 'f-terms'].forEach(function (id) {
      var n = $(id);
      if (!n) return;
      n.addEventListener('input', function () {
        if (id === 'f-margin-enabled') $('margin-body').hidden = !$('f-margin-enabled').checked;
        recalcLive();
      });
      n.addEventListener('change', recalcLive);
    });
    $('f-margin-enabled').addEventListener('change', function () { $('margin-body').hidden = !$('f-margin-enabled').checked; });
    ['f-labor', 'f-operational', 'f-other', 'f-margin-base'].forEach(function (id) {
      $(id).addEventListener('blur', function () {
        var v = parseMoney($(id).value);
        if (isFinite(v) && v >= 0) $(id).value = v ? formatNumID(v) : '';
      });
    });
    $('btn-fill-base').addEventListener('click', function () {
      var d = collectFormSilent();
      var base = Math.max(0, d.totals.beforeTax - d.totals.discountAmount);
      $('f-margin-base').value = base ? formatNumID(base) : '';
      recalcLive();
    });
    $('btn-save-draft').addEventListener('click', function (e) { saveEstimate('draft', e.currentTarget); });
    $('btn-save-final').addEventListener('click', function (e) {
      var keep = $('f-status').value;
      saveEstimate(keep === 'draft' ? 'ready' : keep, e.currentTarget);
    });
    $('btn-preview').addEventListener('click', openPreview);
    $('btn-reset-form').addEventListener('click', function () {
      askConfirm('Atur ulang formulir?', 'Seluruh isian yang belum disimpan akan hilang.', 'Ya, atur ulang', function () {
        state.editingId = null; state.formNumber = '';
        startNewForm();
        toast('Formulir dikosongkan.', 'info');
      });
    });

    // Modal umum
    document.querySelectorAll('.modal-backdrop').forEach(function (mb) {
      mb.addEventListener('click', function (e) {
        if (e.target === mb) closeModal(mb);
      });
      mb.querySelectorAll('[data-close]').forEach(function (b) {
        b.addEventListener('click', function () { closeModal(mb); });
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(closeModal);
    });
    $('confirm-yes').addEventListener('click', onConfirmYes);
    $('btn-modal-save').addEventListener('click', function (e) {
      if (saveEstimate(null, e.currentTarget)) closeModal('preview-modal');
    });
    $('btn-print').addEventListener('click', function () {
      if (state._previewData) doPrint(state._previewData);
      else { var d = collectFormSilent(); doPrint(d); }
    });

    // Projects filter
    ['q-search', 'q-category', 'q-status', 'q-sort'].forEach(function (id) {
      $(id).addEventListener('input', renderProjects);
      $(id).addEventListener('change', renderProjects);
    });

    // Settings
    $('btn-save-settings').addEventListener('click', saveSettings);
    $('btn-export').addEventListener('click', exportJSON);
    $('file-import').addEventListener('change', function () { importJSON($('file-import').files[0]); });
    $('btn-wipe').addEventListener('click', function () {
      askConfirm('Hapus seluruh data?', 'Semua estimasi dan pengaturan akan dihapus permanen dari browser ini. Ekspor cadangan terlebih dahulu jika masih dibutuhkan.', 'Ya, hapus semua', function () {
        var ok = store.saveEstimates([]);
        try { window.localStorage.removeItem(LS_SEQ); } catch (e) {}
        if (ok) {
          state.editingId = null; state.formNumber = '';
          renderProjects(); renderDashboard(); renderSettings();
          toast('Seluruh data dihapus.', 'info');
        } else toast('Gagal menghapus data.', 'error');
      });
    });

    // Cegah submit reload
    $('estimate-form').addEventListener('submit', function (e) { e.preventDefault(); });

    // Sembunyikan area cetak lagi setelah dialog print ditutup
    window.addEventListener('afterprint', function () {
      var pa = $('print-area');
      pa.textContent = '';
      pa.hidden = true;
    });
  }

  function init() {
    state.storageOK = store.available();
    bindEvents();
    try {
      $('today-label').textContent = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { $('today-label').textContent = todayISO(); }
    if (!state.storageOK) {
      toast('LocalStorage tidak tersedia.', 'error', 'Data hanya tersimpan sementara selama sesi ini.');
    }
    var chk = store.loadEstimates();
    if (chk && chk.error === 'corrupt') {
      toast('Data tersimpan rusak.', 'error', 'Hapus atau impor ulang data di Pengaturan.');
    }
    fillCategorySelects();
    renderDashboard();
    refreshIcons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* Ekspor fungsi murni untuk pengujian (tidak mengubah perilaku app) */
  try {
    window.EstimoraCalc = { calcTotals: calcTotals, calcItem: calcItem, calcMarginSuggest: calcMarginSuggest, parseMoney: parseMoney, parsePct: parsePct, formatIDR: formatIDR, validateEstimate: validateEstimate };
  } catch (e) {}
})();
