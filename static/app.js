(() => {
  'use strict';

  /* ---------- утилиты ---------- */
  const $ = (s) => document.querySelector(s);
  const DAY = 864e5;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtD = (t) => { const d = new Date(t); return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1); };
  const fmtFull = (t) => fmtD(t) + '.' + new Date(t).getUTCFullYear();
  const iso = (t) => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };

  /* ---------- состояние ---------- */
  const emptyFilters = () => ({ q: '', city: '', source: '', ticket: '', paid: '', from: '', to: '' });
  const state = {
    all: [],
    sourceName: '',
    filters: emptyFilters(),
    sort: { key: 'registered', dir: 'desc' },
    limit: 25,
    version: '',
    localName: '',
  };

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((v) => v.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((v) => v.trim() !== '')) rows.push(row);
    return rows;
  }

  const ALIASES = {
    name: ['name', 'имя', 'фио', 'участник'],
    city: ['city', 'город'],
    registered: ['registered', 'date', 'дата', 'дата регистрации'],
    source: ['source', 'источник'],
    ticket: ['ticket', 'билет', 'тип билета'],
    paid: ['paid', 'оплата', 'оплачено'],
  };
  const YES = new Set(['да', 'yes', 'true', '1', 'y', 'оплачено', 'paid']);

  function parseDate(s) {
    s = (s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return NaN;
  }

  function toRecords(text) {
    const table = parseCSV(text);
    if (table.length < 2) throw new Error('В файле нет данных.');
    const head = table[0].map((h) => h.trim().toLowerCase());
    const idx = {};
    for (const key of Object.keys(ALIASES)) {
      idx[key] = head.findIndex((h) => ALIASES[key].includes(h));
    }
    const missing = Object.keys(idx).filter((k) => idx[k] < 0);
    if (missing.length) throw new Error('Не найдены колонки: ' + missing.join(', '));
    const out = [];
    for (const r of table.slice(1)) {
      const g = (k) => (r[idx[k]] || '').trim();
      out.push({
        name: g('name'), city: g('city'), registered: g('registered'),
        source: g('source'), ticket: g('ticket'), paid: YES.has(g('paid').toLowerCase()),
      });
    }
    return out;
  }

  // запись из файла → запись для дашборда (+ пометки проблем качества данных)
  const FIELDS = ['name', 'city', 'registered', 'source', 'ticket'];
  function mkRec(p) {
    const t = parseDate(p.registered);
    const blank = FIELDS.filter((k) => !String(p[k] || '').trim());
    return {
      id: p.id, name: p.name || '—', city: p.city || '—', registered: p.registered || '',
      t, source: p.source || '—', ticket: p.ticket || '—', paid: !!p.paid,
      blank, badDate: !blank.includes('registered') && isNaN(t),
    };
  }

  /* ---------- API ---------- */
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try { res = await fetch(path, init); } catch (e) { throw new Error('Нет связи с сервером'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) throw new Error((data && data.error) || 'Ошибка сервера (' + res.status + ')');
    return data;
  }

  /* ---------- фильтрация ---------- */
  function matches(r, f, skip) {
    if (skip !== 'q' && f.q && !r.name.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (skip !== 'city' && f.city && r.city !== f.city) return false;
    if (skip !== 'source' && f.source && r.source !== f.source) return false;
    if (skip !== 'ticket' && f.ticket && r.ticket !== f.ticket) return false;
    if (f.paid === 'yes' && !r.paid) return false;
    if (f.paid === 'no' && r.paid) return false;
    if (f.from && !(r.t >= parseDate(f.from))) return false;
    if (f.to && !(r.t <= parseDate(f.to))) return false;
    return true;
  }
  const filtered = (skip) => state.all.filter((r) => matches(r, state.filters, skip));

  function groupBy(rows, key) {
    const m = new Map();
    for (const r of rows) {
      const g = m.get(r[key]) || { label: r[key], paid: 0, unpaid: 0, total: 0 };
      r.paid ? g.paid++ : g.unpaid++;
      g.total++;
      m.set(r[key], g);
    }
    return [...m.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'ru'));
  }

  /* ---------- подсказка ---------- */
  const tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  const tipRows = (title, paid, unpaid) =>
    `<b>${esc(title)}</b>` +
    `<div class="row"><span><i class="sw paid"></i>Оплатили</span><span>${paid}</span></div>` +
    `<div class="row"><span><i class="sw unpaid"></i>Не оплатили</span><span>${unpaid}</span></div>` +
    `<div class="row"><span>Всего</span><span>${paid + unpaid} · ${pct(paid, paid + unpaid)}% оплат</span></div>`;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  /* ---------- KPI ---------- */
  function renderKPIs(rows) {
    const total = rows.length;
    const paid = rows.filter((r) => r.paid).length;
    const unpaid = total - paid;
    const vip = rows.filter((r) => r.ticket === 'VIP');
    const vipPaid = vip.filter((r) => r.paid).length;
    const cities = groupBy(rows, 'city');
    const sources = groupBy(rows, 'source');
    const times = rows.map((r) => r.t).filter((t) => !isNaN(t));
    const maxT = times.length ? Math.max(...times) : NaN;
    const last7 = rows.filter((r) => r.t > maxT - 7 * DAY).length;
    const topSrc = sources[0];

    const tiles = [
      ['Регистраций', total, total ? `${last7} за последние 7 дней` : '—'],
      ['Оплатили', paid, `${pct(paid, total)}% от всех`],
      ['Ждут оплаты', unpaid, `${unpaid ? vip.length - vipPaid : 0} из них VIP`],
      ['Билетов VIP', vip.length, `${vipPaid} оплачено`],
      ['Городов', cities.length, cities[0] ? `больше всего — ${cities[0].label}` : '—'],
    ];
    let html = tiles.map(([l, v, n]) =>
      `<div class="kpi"><div class="k-label">${l}</div><div class="k-value">${v}</div><div class="k-note">${esc(n)}</div></div>`).join('');
    html += `<div class="kpi"><div class="k-label">Главный источник</div><div class="k-value sm">${topSrc ? esc(topSrc.label) : '—'}</div><div class="k-note">${topSrc ? `${topSrc.total} · ${pct(topSrc.paid, topSrc.total)}% оплатили` : '—'}</div></div>`;
    $('#kpis').innerHTML = html;
  }

  /* ---------- выводы ---------- */
  function renderInsights(rows) {
    const ul = $('#insights');
    const att = $('#attention');
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">Нет данных по выбранным фильтрам.</li>';
      att.innerHTML = '';
      return;
    }
    const total = rows.length;
    const paid = rows.filter((r) => r.paid).length;
    const items = [];
    items.push(`Зарегистрировались <b>${total}</b> ${plural(total, 'участник', 'участника', 'участников')}, оплатили <b>${paid}</b> (${pct(paid, total)}%).`);

    const sources = groupBy(rows, 'source');
    const s0 = sources[0];
    items.push(`Больше всего регистраций даёт <b>${esc(s0.label)}</b> — ${s0.total} (${pct(s0.total, total)}% всех).`);
    const solid = sources.filter((s) => s.total >= 3);
    if (solid.length >= 2) {
      const byConv = [...solid].sort((a, b) => b.paid / b.total - a.paid / a.total);
      const best = byConv[0], worst = byConv[byConv.length - 1];
      items.push(`Лучшая конверсия в оплату у источника <b>${esc(best.label)}</b> — ${pct(best.paid, best.total)}%, самая низкая у <b>${esc(worst.label)}</b> — ${pct(worst.paid, worst.total)}%.`);
    }
    const cities = groupBy(rows, 'city');
    items.push(`Лидер по городам — <b>${esc(cities[0].label)}</b>: ${cities[0].total} (${pct(cities[0].total, total)}%).` +
      (cities.length > 1 ? ` Следом ${esc(cities[1].label)} — ${cities[1].total}.` : ''));

    const days = new Map();
    rows.forEach((r) => { if (!isNaN(r.t)) days.set(r.t, (days.get(r.t) || 0) + 1); });
    if (days.size) {
      const [pt, pn] = [...days.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      items.push(`Пик регистраций — <b>${fmtFull(pt)}</b> (${WD[new Date(pt).getUTCDay()]}): ${pn} ${plural(pn, 'человек', 'человека', 'человек')}.`);
    }
    const vipUnpaid = rows.filter((r) => r.ticket === 'VIP' && !r.paid).length;
    if (vipUnpaid) items.push(`<b>${vipUnpaid}</b> VIP-${plural(vipUnpaid, 'участник', 'участника', 'участников')} не оплатили — самые ценные для напоминания.`);
    ul.innerHTML = items.map((i) => `<li>${i}</li>`).join('');

    const allT = state.all.map((r) => r.t).filter((t) => !isNaN(t));
    const ref = Math.max(Date.now(), ...allT);
    const unpaidRows = rows.filter((r) => !r.paid)
      .sort((a, b) => (b.ticket === 'VIP') - (a.ticket === 'VIP') || a.t - b.t);
    if (!unpaidRows.length) {
      att.innerHTML = '<li class="empty">Все участники оплатили 🎉</li>';
    } else {
      att.innerHTML = unpaidRows.slice(0, 8).map((r) => {
        const d = isNaN(r.t) ? '' : Math.max(0, Math.floor((ref - r.t) / DAY)) + ' дн.';
        return `<li><span>${esc(r.name)} <span class="meta">· ${esc(r.city)}</span></span><span class="meta">${esc(r.ticket)}${d ? ' · ' + d : ''}</span></li>`;
      }).join('') + (unpaidRows.length > 8 ? `<li class="meta">и ещё ${unpaidRows.length - 8}…</li>` : '');
    }
  }

  /* ---------- графики по времени ---------- */
  function niceScale(max) {
    max = Math.max(max, 1);
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const step = steps.find((s) => max / s <= 5) || 1000;
    return { step, max: Math.ceil(max / step) * step };
  }
  const roundedTop = (x, y, w, h, r) => {
    if (h <= 0) return '';
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  };

  function buildDays(rows) {
    const times = rows.map((r) => r.t).filter((t) => !isNaN(t));
    if (!times.length) return [];
    const min = Math.min(...times), max = Math.max(...times);
    const days = [];
    for (let t = min; t <= max; t += DAY) days.push({ t, paid: 0, unpaid: 0 });
    rows.forEach((r) => {
      if (isNaN(r.t)) return;
      const d = days[Math.round((r.t - min) / DAY)];
      r.paid ? d.paid++ : d.unpaid++;
    });
    let cum = 0;
    days.forEach((d) => { cum += d.paid + d.unpaid; d.cum = cum; });
    return days;
  }

  const GEO = { l: 30, r: 8, t: 12, b: 26 };
  function axisX(days, W, H, band) {
    const iw = W - GEO.l - GEO.r;
    const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(iw / 46))));
    return days.map((d, i) => (i % every === 0 || i === days.length - 1 && every === 1)
      ? `<text x="${GEO.l + i * band + band / 2}" y="${H - 8}" text-anchor="middle">${fmtD(d.t)}</text>` : '').join('');
  }
  function axisY(scale, W, H) {
    const ih = H - GEO.t - GEO.b;
    let s = '';
    for (let v = 0; v <= scale.max; v += scale.step) {
      const y = GEO.t + ih - (v / scale.max) * ih;
      s += `<line class="${v === 0 ? 'axis-line' : 'grid-line'}" x1="${GEO.l}" x2="${W - GEO.r}" y1="${y}" y2="${y}"/>` +
        `<text x="${GEO.l - 6}" y="${y + 4}" text-anchor="end">${v}</text>`;
    }
    return s;
  }

  function renderDaily(rows) {
    const box = $('#chart-daily');
    const days = buildDays(rows);
    if (!days.length) { box.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    const W = Math.max(280, box.clientWidth), H = 260;
    const iw = W - GEO.l - GEO.r, ih = H - GEO.t - GEO.b;
    const scale = niceScale(Math.max(...days.map((d) => d.paid + d.unpaid)));
    const band = iw / days.length;
    const bw = Math.max(3, Math.min(band * 0.7, 28));
    const base = GEO.t + ih;
    let bars = '';
    days.forEach((d, i) => {
      const x = GEO.l + i * band + (band - bw) / 2;
      const hp = (d.paid / scale.max) * ih, hu = (d.unpaid / scale.max) * ih;
      if (d.paid) bars += d.unpaid
        ? `<rect class="seg-paid" x="${x}" y="${base - hp}" width="${bw}" height="${hp}"/>`
        : `<path class="seg-paid" d="${roundedTop(x, base - hp, bw, hp, 4)}"/>`;
      if (d.unpaid) {
        const gap = d.paid ? 2 : 0;
        bars += `<path class="seg-unpaid" d="${roundedTop(x, base - hp - hu, bw, Math.max(1, hu - gap), 4)}"/>`;
      }
    });
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Регистрации по дням: ${days.length} дней, всего ${rows.length}">
      ${axisY(scale, W, H)}<rect class="band" id="d-band" width="${band}" y="${GEO.t}" height="${ih}" visibility="hidden"/>${bars}${axisX(days, W, H, band)}</svg>`;
    const svg = box.firstChild, bandEl = svg.querySelector('#d-band');
    svg.addEventListener('pointermove', (e) => {
      const x = e.clientX - svg.getBoundingClientRect().left - GEO.l;
      const i = Math.floor(x / band);
      if (i < 0 || i >= days.length) { bandEl.setAttribute('visibility', 'hidden'); hideTip(); return; }
      const d = days[i];
      bandEl.setAttribute('x', GEO.l + i * band);
      bandEl.setAttribute('visibility', 'visible');
      showTip(tipRows(`${fmtFull(d.t)}, ${WD[new Date(d.t).getUTCDay()]}`, d.paid, d.unpaid), e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', () => { bandEl.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  function renderCum(rows) {
    const box = $('#chart-cum');
    const days = buildDays(rows);
    if (!days.length) { box.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    const W = Math.max(240, box.clientWidth), H = 260;
    const iw = W - GEO.l - GEO.r, ih = H - GEO.t - GEO.b;
    const scale = niceScale(days[days.length - 1].cum);
    const band = iw / days.length;
    const px = (i) => GEO.l + i * band + band / 2;
    const py = (v) => GEO.t + ih - (v / scale.max) * ih;
    const pts = days.map((d, i) => `${px(i)},${py(d.cum)}`);
    const last = days[days.length - 1];
    const area = `M${px(0)},${GEO.t + ih}L${pts.join('L')}L${px(days.length - 1)},${GEO.t + ih}Z`;
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Нарастающий итог регистраций: ${last.cum}">
      ${axisY(scale, W, H)}<path class="area" d="${area}"/><polyline class="line" points="${pts.join(' ')}"/>
      <text class="end-label" x="${px(days.length - 1)}" y="${py(last.cum) - 8}" text-anchor="end">${last.cum}</text>
      <line class="cross" id="c-line" y1="${GEO.t}" y2="${GEO.t + ih}" visibility="hidden"/><circle class="dot" id="c-dot" r="5" visibility="hidden"/>
      ${axisX(days, W, H, band)}</svg>`;
    const svg = box.firstChild, line = svg.querySelector('#c-line'), dot = svg.querySelector('#c-dot');
    const off = () => { line.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
    svg.addEventListener('pointermove', (e) => {
      const i = Math.floor((e.clientX - svg.getBoundingClientRect().left - GEO.l) / band);
      if (i < 0 || i >= days.length) return off();
      const d = days[i];
      line.setAttribute('x1', px(i)); line.setAttribute('x2', px(i)); line.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px(i)); dot.setAttribute('cy', py(d.cum)); dot.setAttribute('visibility', 'visible');
      const n = d.paid + d.unpaid;
      showTip(`<b>${fmtFull(d.t)}</b><div class="row"><span>Всего к этому дню</span><span>${d.cum}</span></div><div class="row"><span>За день</span><span>+${n}</span></div>`, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', off);
  }

  /* ---------- горизонтальные столбики ---------- */
  function renderBars(sel, rows, dim) {
    const box = $(sel);
    const groups = groupBy(rows, dim);
    const active = state.filters[dim];
    // выбранное значение остаётся видимым, даже если по другим фильтрам у него 0
    if (active && !groups.find((g) => g.label === active)) groups.push({ label: active, paid: 0, unpaid: 0, total: 0 });
    if (!groups.length) { box.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    const max = Math.max(...groups.map((g) => g.total), 1);
    box.innerHTML = groups.map((g, i) => {
      const segs = (g.paid ? `<span class="seg paid" style="width:${(g.paid / max) * 100}%"></span>` : '') +
        (g.unpaid ? `<span class="seg unpaid" style="width:${(g.unpaid / max) * 100}%"></span>` : '');
      return `<button type="button" class="bar-row" data-i="${i}" aria-pressed="${g.label === active}" aria-label="${esc(g.label)}: ${g.total}, оплатили ${g.paid}">
        <span class="bar-label" title="${esc(g.label)}">${esc(g.label)}</span>
        <span class="bar-track">${segs}</span>
        <span class="bar-val">${g.total}<small>${pct(g.paid, g.total)}%</small></span></button>`;
    }).join('');
    box.querySelectorAll('.bar-row').forEach((btn) => {
      const g = groups[+btn.dataset.i];
      btn.addEventListener('pointermove', (e) => showTip(tipRows(g.label, g.paid, g.unpaid), e.clientX, e.clientY));
      btn.addEventListener('pointerleave', hideTip);
      btn.addEventListener('click', () => {
        state.filters[dim] = state.filters[dim] === g.label ? '' : g.label;
        $('#f-' + dim).value = state.filters[dim];
        hideTip();
        render();
      });
    });
  }

  /* ---------- матрица город × источник ---------- */
  function renderMatrix(rows) {
    const box = $('#matrix');
    if (!rows.length) { box.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    const cities = groupBy(rows, 'city').map((g) => g.label);
    const sources = groupBy(rows, 'source').map((g) => g.label);
    const cell = new Map();
    rows.forEach((r) => {
      const k = r.city + '\u0000' + r.source;
      const c = cell.get(k) || { paid: 0, unpaid: 0 };
      r.paid ? c.paid++ : c.unpaid++;
      cell.set(k, c);
    });
    const maxV = Math.max(...[...cell.values()].map((c) => c.paid + c.unpaid), 1);
    const colTot = sources.map((s) => rows.filter((r) => r.source === s).length);
    let html = '<table class="matrix"><thead><tr><th></th>' + sources.map((s) => `<th>${esc(s)}</th>`).join('') + '<th class="total">Всего</th></tr></thead><tbody>';
    cities.forEach((c) => {
      let rowTot = 0;
      let tds = '';
      sources.forEach((s) => {
        const v = cell.get(c + '\u0000' + s);
        const n = v ? v.paid + v.unpaid : 0;
        rowTot += n;
        if (!n) { tds += '<td class="zero">·</td>'; return; }
        const t = n / maxV;
        tds += `<td data-c="${esc(c)}" data-s="${esc(s)}" style="background:color-mix(in srgb, var(--paid) ${Math.round(14 + t * 86)}%, var(--surface));color:${t > 0.6 ? '#fff' : 'var(--ink)'}">${n}</td>`;
      });
      html += `<tr><th class="row-h">${esc(c)}</th>${tds}<td class="total">${rowTot}</td></tr>`;
    });
    html += '<tr><th class="row-h total">Всего</th>' + colTot.map((n) => `<td class="total">${n}</td>`).join('') + `<td class="total">${rows.length}</td></tr></tbody></table>`;
    box.innerHTML = html;
    box.querySelectorAll('td[data-c]').forEach((td) => {
      const v = cell.get(td.dataset.c + '\u0000' + td.dataset.s);
      td.addEventListener('pointermove', (e) => showTip(tipRows(`${td.dataset.c} · ${td.dataset.s}`, v.paid, v.unpaid), e.clientX, e.clientY));
      td.addEventListener('pointerleave', hideTip);
    });
  }

  /* ---------- таблица ---------- */
  const COLUMNS = [
    ['name', 'Имя'], ['city', 'Город'], ['registered', 'Дата'], ['source', 'Источник'], ['ticket', 'Билет'], ['paid', 'Оплата'],
  ];
  function sortRows(rows) {
    const { key, dir } = state.sort;
    const k = { registered: 't' }[key] || key;
    const m = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let x = a[k], y = b[k];
      if (typeof x === 'string') return m * x.localeCompare(y, 'ru') || a.t - b.t;
      if (typeof x === 'boolean') { x = +x; y = +y; }
      return m * ((isNaN(x) ? -Infinity : x) - (isNaN(y) ? -Infinity : y)) || a.name.localeCompare(b.name, 'ru');
    });
  }
  function renderTable(rows) {
    const { key, dir } = state.sort;
    $('#table thead').innerHTML = '<tr>' + COLUMNS.map(([k, label]) =>
      `<th aria-sort="${k === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-k="${k}">${label}${k === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`).join('') + '</tr>';
    $('#table thead').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
      renderTable(rows);
    }));
    const sorted = sortRows(rows);
    const shown = sorted.slice(0, state.limit);
    $('#table-count').textContent = `· ${rows.length} из ${state.all.length}`;
    $('#table tbody').innerHTML = shown.length ? shown.map((r) =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.city)}</td><td class="num">${isNaN(r.t) ? '—' : fmtFull(r.t)}</td><td>${esc(r.source)}</td>` +
      `<td><span class="pill${r.ticket === 'VIP' ? ' vip' : ''}">${esc(r.ticket)}</span></td>` +
      `<td><span class="pay ${r.paid ? 'yes' : 'no'}">${r.paid ? 'Оплачено' : 'Не оплачено'}</span></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Ничего не найдено.</td></tr>';
    const more = $('#more-btn');
    more.hidden = sorted.length <= state.limit;
    more.textContent = `Показать ещё (${sorted.length - state.limit})`;
  }

  /* ---------- главный рендер ---------- */
  function renderSelect(id, dim, label) {
    const sel = $(id);
    const cur = state.filters[dim];
    const opts = groupBy(state.all, dim).map((g) => g.label);
    sel.innerHTML = `<option value="">${label}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    sel.value = opts.includes(cur) ? cur : '';
    state.filters[dim] = sel.value;
  }

  function render() {
    const rows = filtered();
    renderKPIs(rows);
    renderInsights(rows);
    renderDaily(rows);
    renderCum(rows);
    renderBars('#bars-city', filtered('city'), 'city');
    renderBars('#bars-source', filtered('source'), 'source');
    renderBars('#bars-ticket', filtered('ticket'), 'ticket');
    renderMatrix(rows);
    renderTable(rows);
  }

  // Проверка качества данных: пустые значения, неверные даты, повторы
  function dataQuality(records) {
    const issues = [];
    const blank = records.filter((r) => r.blank.length);
    if (blank.length) issues.push(`пустые значения в ${blank.length} ${plural(blank.length, 'строке', 'строках', 'строках')} (строки файла: ${blank.slice(0, 5).map((r) => r.id).join(', ')}${blank.length > 5 ? '…' : ''})`);
    const bad = records.filter((r) => r.badDate);
    if (bad.length) issues.push(`не распознана дата в ${bad.length} ${plural(bad.length, 'строке', 'строках', 'строках')} (строки файла: ${bad.slice(0, 5).map((r) => r.id).join(', ')}${bad.length > 5 ? '…' : ''})`);
    const seen = new Map();
    records.forEach((r) => { const k = (r.name + '|' + r.city).toLowerCase(); seen.set(k, (seen.get(k) || []).concat(r)); });
    const dups = [...seen.values()].filter((g) => g.length > 1);
    if (dups.length) issues.push(`возможные дубликаты (имя + город): ${dups.slice(0, 3).map((g) => `${g[0].name} (${g.length})`).join(', ')}${dups.length > 3 ? '…' : ''}`);
    return issues;
  }

  // Применяет данные, сохраняя выбранные фильтры и сортировку
  function applyData(records, label, modified) {
    state.all = records;
    renderSelect('#f-city', 'city', 'Все города');
    renderSelect('#f-source', 'source', 'Все источники');
    renderSelect('#f-ticket', 'ticket', 'Все билеты');
    const times = records.map((r) => r.t).filter((t) => !isNaN(t));
    if (times.length) {
      ['#f-from', '#f-to'].forEach((s) => { $(s).min = iso(Math.min(...times)); $(s).max = iso(Math.max(...times)); });
    }
    const range = times.length ? ` · период ${fmtFull(Math.min(...times))} — ${fmtFull(Math.max(...times))}` : '';
    const when = modified ? ` · файл изменён ${new Date(modified * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : '';
    $('#source-info').textContent = `${label} · ${records.length} ${plural(records.length, 'запись', 'записи', 'записей')}${range}${when}`;
    const q = $('#quality');
    const issues = dataQuality(records);
    q.className = 'quality ' + (issues.length ? 'warn' : 'ok');
    q.textContent = issues.length ? 'Проверка данных: ' + issues.join('; ') + '.' : 'Проверка данных: проблем не найдено.';
    render();
  }

  // Читает registrations.csv через сервер. Перерисовывает только если файл изменился.
  async function load(silent, force) {
    try {
      const d = await api('/api/data');
      const version = d.modified + ':' + d.rows.length;
      if (!force && version === state.version) return;
      state.version = version;
      state.localName = '';
      applyData(d.rows.map((p, i) => mkRec({ ...p, id: i + 2 })), d.file, d.modified);
    } catch (err) {
      if (!silent) {
        $('#source-info').textContent = 'Не удалось загрузить данные: ' + err.message;
        toast(err.message);
      }
    }
  }

  /* ---------- события ---------- */
  function bindFilter(id, key, ev) {
    $(id).addEventListener(ev || 'change', (e) => { state.filters[key] = e.target.value; state.limit = 25; render(); });
  }
  bindFilter('#f-q', 'q', 'input');
  bindFilter('#f-city', 'city');
  bindFilter('#f-source', 'source');
  bindFilter('#f-ticket', 'ticket');
  bindFilter('#f-paid', 'paid');
  bindFilter('#f-from', 'from');
  bindFilter('#f-to', 'to');

  $('#reset-btn').addEventListener('click', () => {
    state.filters = emptyFilters();
    ['#f-q', '#f-city', '#f-source', '#f-ticket', '#f-paid', '#f-from', '#f-to'].forEach((s) => { $(s).value = ''; });
    render();
  });
  $('#show-unpaid').addEventListener('click', () => {
    state.filters.paid = 'no';
    $('#f-paid').value = 'no';
    render();
    $('#table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#more-btn').addEventListener('click', () => { state.limit += 50; renderTable(filtered()); });

  $('#export-btn').addEventListener('click', () => {
    const rows = sortRows(filtered());
    // защита от «формул» в Excel: значения, начинающиеся с = + - @, экранируем апострофом
    const q = (v) => {
      v = String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const csv = ['name,city,registered,source,ticket,paid',
      ...rows.map((r) => [r.name, r.city, r.registered, r.source, r.ticket, r.paid ? 'да' : 'нет'].map(q).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'registrations-filtered.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Экспортировано строк: ${rows.length}`);
  });

  /* ---------- открыть другой CSV (только просмотр, файл на сервере не меняется) ---------- */
  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = toRecords(String(reader.result));
        if (!rows.length) throw new Error('В файле нет строк с данными.');
        state.localName = file.name;
        state.version = '';
        state.filters = emptyFilters();
        ['#f-q', '#f-paid', '#f-from', '#f-to'].forEach((s) => { $(s).value = ''; });
        applyData(rows.map((p, i) => mkRec({ ...p, id: i + 2 })), file.name + ' (открыт локально)');
        toast('Открыт файл: ' + file.name);
      } catch (err) { toast('Не удалось прочитать файл: ' + err.message); }
    };
    reader.readAsText(file, 'utf-8');
  }

  $('#refresh-btn').addEventListener('click', () => load(false, true));
  // автообновление: подхватывает правки в registrations.csv (не трогает локально открытый файл)
  setInterval(() => {
    if (document.hidden || state.localName) return;
    load(true);
  }, 10000);
  $('#file-input').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; loadFile(e.dataTransfer.files[0]); });

  /* тема: авто → светлая → тёмная */
  const themes = ['auto', 'light', 'dark'];
  const themeLabel = { auto: 'авто', light: 'светлая', dark: 'тёмная' };
  let theme = 'auto';
  try { theme = localStorage.getItem('dash-theme') || 'auto'; } catch (e) { /* без хранилища */ }
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    $('#theme-btn').textContent = 'Тема: ' + themeLabel[theme];
  }
  $('#theme-btn').addEventListener('click', () => {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length];
    try { localStorage.setItem('dash-theme', theme); } catch (e) { /* ignore */ }
    applyTheme();
  });
  applyTheme();

  /* перерисовка графиков при изменении ширины */
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = document.querySelector('.wrap').clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (state.all.length) { const r = filtered(); renderDaily(r); renderCum(r); } });
  }).observe(document.querySelector('.wrap'));

  /* старт */
  load();
})();
