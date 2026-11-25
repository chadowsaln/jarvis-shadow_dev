// Cards beside the Sidekick while it works, in the card look (glass.js) with the reminders card's header and marks:
//  - trail: the parts of a "do this, then that" request, ticking off as each finishes; a skipped part says why.
// API on agent.cards: trail(e)
(() => {
  const R = window.Roamie;
  const { clamp } = R;
  const G = R.glass;
  const BODY = `400 13px ${G.MONO}`, NOW = `500 13px ${G.MONO}`, SMALL = `400 11px ${G.MONO}`, HEAD = `500 10px ${G.MONO}`;
  const now = () => performance.now() / 1000;

  // ---------- a card beside the Sidekick: placed and sprung beside it, opening from its top-left corner ----------
  class Card {
    constructor() { this.open = false; this.age = 0; this.closing = 0; this.until = Infinity; this.x = { x: 0, v: 0 }; this.y = { x: 0, v: 0 }; this.placed = false; this.geo = null; }
    show(k) { if (!this.open || this.closing) { this.open = true; this.closing = 0; this.age = 0; this.placed = false; k.S('page'); } this.until = Infinity; }
    close(k, after = 0) { this.until = Math.min(this.until, now() + after); }
    fade() { return this.closing ? clamp(1 - this.closing / 0.3, 0, 1) : clamp(this.age / 0.22, 0, 1); }
    update(dt, k, side, slot) {
      if (!this.open) return;
      if (this.closing) { this.closing += dt; if (this.closing > 0.35) { this.open = false; this.closing = 0; } }
      else { this.age += dt; if (now() > this.until) { this.closing = 0.0001; k.S('poof'); } }
      const { w, h } = this.size(k), P = k.P, S = R.safe ?? { left: 0, top: 0, right: 0, bottom: 0 }, m = k.m;
      const l = S.left, t = S.top, r = innerWidth - S.right, b = innerHeight - S.bottom, gap = k.R * 1.35 + P * 3;
      // Beside the body, its bottom kept above the task tag that can open under it.
      let tx = side === 'right' ? m.x + gap : m.x - gap - w, ty = Math.min(m.y - h / 2 + slot, m.y + k.R * 1.2 - h);
      if (tx < l + 8 || tx + w > r - 8) { tx = m.x - w / 2; ty = m.y - k.R * 1.4 - h - P * 4 - Math.abs(slot); if (ty < t + 8) ty = m.y + k.R * 1.4 + P * 4 + Math.abs(slot); }
      tx = clamp(tx, l + 8, Math.max(l + 8, r - w - 8)); ty = clamp(ty, t + 8, Math.max(t + 8, b - h - 8));
      const spring = (s, target) => { s.v += ((target - s.x) * 70 - s.v * 11) * dt; s.x += s.v * dt; };
      if (!this.placed) { this.x.x = tx; this.y.x = ty; this.placed = true; }
      spring(this.x, tx); spring(this.y, ty);
      this.geo = { x: Math.round(this.x.x), y: Math.round(this.y.x), w, h };
    }
  }

  // ---------- trail: the parts of the request ----------
  class Trail extends Card {
    set(e, k) {
      const fresh = !this.open || this.closing;
      this.show(k);
      const before = this.steps ?? [];
      this.steps = (e.steps ?? []).map((s, i) => ({ ...s, at: before[i]?.state === s.state ? before[i].at : now() }));
      for (const [i, s] of this.steps.entries()) if (!fresh && before[i] && before[i].state !== s.state && (s.state === 'ok' || s.state === 'bad')) k.S(s.state === 'ok' ? 'tick' : 'error');
      this.head = String(e.head ?? 'your request').toLowerCase();
      this.lay = null;
      if (e.final) this.close(k, 4.5);
    }
    width() { return Math.round(clamp(innerWidth * 0.22, 260, 320)); }
    // Rows from the card's top-left: each step wraps to two lines; a skipped one says why underneath.
    layout() {
      const w = this.width();
      if (this.lay?.w === w) return this.lay;
      const tw = w - 40 - 16, rows = [];
      let y = 34;
      for (const [i, s] of (this.steps ?? []).entries()) {
        const lines = G.wrapRows(s.text, tw, s.state === 'now' ? NOW : BODY, 2), h = lines.length * 19 + 10;
        rows.push({ i, lines, y, h }); y += h;
        if (s.state === 'bad' && s.why) { const why = G.wrapRows(s.why, tw, SMALL, 3); rows.push({ i, why, y: y - 4, h: why.length * 16 + 4 }); y += why.length * 16 + 4; }
      }
      return (this.lay = { w, h: y + 10, rows });
    }
    size() { const L = this.layout(); return { w: L.w, h: L.h }; }
    box() { return this.open && this.geo ? [this.geo.x, this.geo.y, this.geo.x + this.geo.w, this.geo.y + this.geo.h] : null; }
    draw(ctx) {
      if (!this.open || !this.geo) return;
      const { x, y } = this.geo, L = this.layout(), w = L.w, t = now(), fade = this.fade();
      // Opens from its corner, like the reminders card.
      const e = 1 - (1 - clamp(this.age / 0.3, 0, 1)) ** 3, a = this.age - 0.3;
      ctx.save();
      ctx.globalAlpha *= fade;
      G.chrome(ctx, x, y, Math.max(16, w * e), Math.max(16, L.h * e));
      if (a > 0) {
        ctx.fillStyle = G.rgba(G.ACC, 0.06); ctx.fillRect(x + 2, y + 2, w - 4, 24);
        ctx.fillStyle = G.DEEP; ctx.fillRect(x + 2, y + 26, w - 4, 1);
        [0, 1].forEach((k) => { ctx.fillStyle = k ? G.DEEP : G.ACC; ctx.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
        G.typed(ctx, this.head, x + w / 2, y + 14, HEAD, G.DIM, a / 0.4, { anchor: 'middle' });
        const steps = this.steps ?? [], done = steps.filter((s) => s.state === 'ok' || s.state === 'bad').length;
        G.typed(ctx, `${done} of ${steps.length}`, x + w - 14, y + 14, HEAD, G.DIM, 1, { anchor: 'end' });
        ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 27, w - 4, L.h - 29); ctx.clip();
        L.rows.forEach((r, n) => {
          const s = steps[r.i], ra = a - 0.12 - n * 0.06;
          if (!s || ra <= 0) return;
          const ry = y + r.y;
          if (r.why) { r.why.forEach((ln, j) => G.typed(ctx, ln, x + 40, ry + 8 + j * 16, SMALL, G.NOTE, (ra - 0.1) / 0.4)); return; }
          const since = t - s.at, ink = s.state === 'ok' ? G.MID : s.state === 'bad' ? G.CORAL : s.state === 'now' ? G.ACC : G.DEEP;
          if (s.state === 'now') { ctx.fillStyle = G.rgba(G.ACC, 0.07); ctx.fillRect(x + 4, ry, w - 8, r.h); }
          G.pen(ctx, G.ringPts(x + 24, ry + 12, 7, r.i * 2.3), ink, 2.2, ra / 0.3);
          const font = s.state === 'now' ? NOW : BODY;
          r.lines.forEach((ln, j) => G.typed(ctx, ln, x + 40, ry + 13 + j * 19, font, s.state === 'ok' || !s.state ? G.DIM : G.TEXT, (ra - 0.1) / 0.4));
          // Done: a tick in the ring, then the words struck through.
          if (s.state === 'ok') {
            const u = Math.min(ra, since);
            G.pen(ctx, [[x + 19.5, ry + 12], [x + 22.5, ry + 15.5], [x + 28.5, ry + 8]], G.HOT, 2.2, u / 0.2);
            r.lines.forEach((ln, j) => G.pen(ctx, [[x + 38, ry + 13 + j * 19], [x + 42 + G.textW(ln, font), ry + 12.5 + j * 19]], G.MID, 1.6, (u - 0.15 - j * 0.2) / 0.3));
          }
          if (s.state === 'bad') {
            const u = Math.min(ra, since);
            G.pen(ctx, [[x + 20.5, ry + 8], [x + 27.5, ry + 16]], G.CORAL, 2, u / 0.15);
            G.pen(ctx, [[x + 27.5, ry + 8], [x + 20.5, ry + 16]], G.CORAL, 2, (u - 0.1) / 0.15);
          }
          // The step being done: its ring pulses outward.
          if (s.state === 'now' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            const p = (t % 1.4) / 1.4;
            ctx.save(); ctx.globalAlpha *= 1 - p; ctx.strokeStyle = G.ACC; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + 24, ry + 12, 8 + p * 9, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
          }
        });
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ---------- system status: live resource snapshot (read-only) ----------
  class SystemStatus extends Card {
    set(e, k) {
      const fresh = !this.open || this.closing;
      this.show(k);
      this.data = e || {};
      this.head = 'system status';
      this.lay = null;
      // stays until replaced/closed; auto-close after a while to avoid clutter
      this.close(k, 30);
      if (fresh) k.S('page');
    }
    width() { return Math.round(clamp(innerWidth * 0.26, 300, 380)); }
    lines() {
      const d = this.data || {}, out = [];
      const b = (n) => {
        if (!Number.isFinite(n)) return 'n/a';
        const u = ['B','KB','MB','GB','TB']; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} const dec=i===0?0:v<10?1:0; return v.toFixed(dec)+' '+u[i];
      };
      if (d.cpu) {
        const p = Number.isFinite(d.cpu.percent) ? `${d.cpu.percent}%` : (d.cpu.reason || 'n/a');
        const t = d.cpu.temperature?.celsius != null ? ` · ${d.cpu.temperature.celsius}°C` : (d.cpu.temperature ? '' : '');
        out.push(`CPU: ${p}${t}`);
      }
      if (d.memory?.ram) {
        const r = d.memory.ram; out.push(`RAM: ${b(r.used)} / ${b(r.total)} (${r.percent ?? 'n/a'}%)`);
      } else if (d.memory?.reason) out.push(`RAM: ${d.memory.reason}`);
      if (d.memory?.swap) {
        const s = d.memory.swap;
        out.push(s.total ? `Swap: ${b(s.used)} / ${b(s.total)} (${s.percent ?? 'n/a'}%)` : 'Swap: none configured');
      }
      if (Array.isArray(d.disks) && d.disks.length) {
        for (const x of d.disks.slice(0, 4)) out.push(`Disk ${x.mount}: ${b(x.used)} / ${b(x.total)} (${x.percent ?? 'n/a'}%)`);
      } else out.push(`Disks: ${d.disks?.reason || 'not available'}`);
      if (d.battery) {
        if (d.battery.present) out.push(`Battery: ${d.battery.percent ?? 'n/a'}% · ${d.battery.status || 'unknown'}`);
        else out.push(`Battery: ${d.battery.reason || 'not present'}`);
      }
      if (d.system) {
        const u = Number.isFinite(d.system.uptimeSeconds) ? `${Math.floor(d.system.uptimeSeconds/3600)}h ${Math.floor((d.system.uptimeSeconds%3600)/60)}m` : 'n/a';
        out.push(`Uptime: ${u}${d.system.hostname ? ` · ${d.system.hostname}` : ''}`);
      }
      const procs = Array.isArray(d.processes) ? d.processes.slice(0, 5) : [];
      if (procs.length) {
        out.push('Top processes:');
        for (const p of procs) {
          const cpu = Number.isFinite(p.cpuPercent) ? `${p.cpuPercent}%` : 'n/a';
          const mem = Number.isFinite(p.memPercent) ? `${p.memPercent}%` : 'n/a';
          out.push(`  ${p.name || p.pid}  CPU ${cpu}  MEM ${mem}`);
        }
      } else out.push('Top processes: not available');
      return out.length ? out : ['System status unavailable'];
    }
    layout() {
      const w = this.width();
      if (this.lay?.w === w && this.lay?.n === (this.data?.at || 0)) return this.lay;
      const tw = w - 28, rows = [];
      let y = 34;
      for (const line of this.lines()) {
        const wrapped = G.wrapRows(line, tw, line.startsWith('  ') ? SMALL : BODY, 3);
        const h = wrapped.length * (line.startsWith('  ') ? 16 : 19) + 6;
        rows.push({ lines: wrapped, y, h, small: line.startsWith('  ') }); y += h;
      }
      return (this.lay = { w, h: y + 10, rows, n: this.data?.at || 0 });
    }
    size() { const L = this.layout(); return { w: L.w, h: L.h }; }
    box() { return this.open && this.geo ? [this.geo.x, this.geo.y, this.geo.x + this.geo.w, this.geo.y + this.geo.h] : null; }
    draw(ctx) {
      if (!this.open || !this.geo) return;
      const { x, y } = this.geo, L = this.layout(), w = L.w, fade = this.fade();
      const e = 1 - (1 - clamp(this.age / 0.3, 0, 1)) ** 3, a = this.age - 0.3;
      ctx.save();
      ctx.globalAlpha *= fade;
      G.chrome(ctx, x, y, Math.max(16, w * e), Math.max(16, L.h * e));
      if (a > 0) {
        ctx.fillStyle = G.rgba(G.ACC, 0.06); ctx.fillRect(x + 2, y + 2, w - 4, 24);
        ctx.fillStyle = G.DEEP; ctx.fillRect(x + 2, y + 26, w - 4, 1);
        [0,1].forEach((k) => { ctx.fillStyle = k ? G.DEEP : G.ACC; ctx.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
        G.typed(ctx, this.head, x + w / 2, y + 14, HEAD, G.DIM, a / 0.4, { anchor: 'middle' });
        ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 27, w - 4, L.h - 29); ctx.clip();
        L.rows.forEach((r, n) => {
          const ra = a - 0.08 - n * 0.04; if (ra <= 0) return;
          const font = r.small ? SMALL : BODY, lh = r.small ? 16 : 19;
          r.lines.forEach((ln, j) => G.typed(ctx, ln, x + 14, y + r.y + 12 + j * lh, font, r.small ? G.MID : G.TEXT, (ra - 0.05) / 0.35));
        });
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ---------- screen capture: shows the captured image (portal, no persistence) ----------
  class ScreenCapture extends Card {
    set(e, k) {
      this.show(k);
      this.head = 'screen capture';
      this.data = e || {};
      this.img = null; this.imgSrc = null; this.lay = null;
      const src = e?.image;
      if (src && src !== this.imgSrc) {
        this.imgSrc = src;
        const im = new Image();
        im.onload = () => { this.img = im; this.lay = null; };
        im.onerror = () => { this.img = null; };
        im.src = src;
      }
      this.close(k, 40);
      k.S('page');
    }
    width() { return Math.round(clamp(innerWidth * 0.28, 320, 420)); }
    lines() {
      const out = [];
      const o = this.data?.ocr;
      if (o) {
        if (o.ok) out.push(o.text ? `OCR (${o.lang || 'local'}): text extracted` : `OCR (${o.lang || 'local'}): no text found`);
        else out.push(`OCR: ${String(o.error || 'unavailable').slice(0, 120)}`);
      } else out.push('Captured via desktop portal (not saved).');
      if (this.data?.question) out.push(`Q: ${String(this.data.question).slice(0, 80)}`);
      return out;
    }
    layout() {
      const w = this.width();
      const iw = this.img ? this.img.naturalWidth : 0, ih = this.img ? this.img.naturalHeight : 0;
      const imgH = iw && ih ? Math.min(220, Math.round((w - 20) * (ih / iw))) : 120;
      const key = `${w}:${iw}x${ih}:${this.data?.at || 0}:${(this.data?.ocr?.ok)|0}:${(this.data?.ocr?.text||'').length}`;
      if (this.lay?.key === key) return this.lay;
      const tw = w - 28; let y = 34 + imgH + 8;
      const rows = [];
      for (const line of this.lines()) {
        const wrapped = G.wrapRows(line, tw, SMALL, 3); const h = wrapped.length * 16 + 4; rows.push({ lines: wrapped, y, h }); y += h;
      }
      return (this.lay = { w, h: y + 8, imgH, rows, key });
    }
    size() { const L = this.layout(); return { w: L.w, h: L.h }; }
    box() { return this.open && this.geo ? [this.geo.x, this.geo.y, this.geo.x + this.geo.w, this.geo.y + this.geo.h] : null; }
    draw(ctx) {
      if (!this.open || !this.geo) return;
      const { x, y } = this.geo, L = this.layout(), w = L.w, fade = this.fade();
      const e = 1 - (1 - clamp(this.age / 0.3, 0, 1)) ** 3, a = this.age - 0.3;
      ctx.save(); ctx.globalAlpha *= fade;
      G.chrome(ctx, x, y, Math.max(16, w * e), Math.max(16, L.h * e));
      if (a > 0) {
        ctx.fillStyle = G.rgba(G.ACC, 0.06); ctx.fillRect(x + 2, y + 2, w - 4, 24);
        ctx.fillStyle = G.DEEP; ctx.fillRect(x + 2, y + 26, w - 4, 1);
        [0,1].forEach((k) => { ctx.fillStyle = k ? G.DEEP : G.ACC; ctx.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
        G.typed(ctx, this.head, x + w / 2, y + 14, HEAD, G.DIM, a / 0.4, { anchor: 'middle' });
        const ix = x + 10, iy = y + 34, iw = w - 20, ih = L.imgH;
        ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
        if (this.img) {
          const sw = this.img.naturalWidth, sh = this.img.naturalHeight;
          const scale = Math.min(iw / sw, ih / sh);
          const dw = sw * scale, dh = sh * scale;
          ctx.drawImage(this.img, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
        } else {
          ctx.fillStyle = G.rgba(G.ACC, 0.04); ctx.fillRect(ix, iy, iw, ih);
          G.typed(ctx, 'capturing…', ix + iw / 2, iy + ih / 2, SMALL, G.DIM, 1, { anchor: 'middle' });
        }
        ctx.restore();
        ctx.strokeStyle = G.DEEP; ctx.strokeRect(ix, iy, iw, ih);
        ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 27, w - 4, L.h - 29); ctx.clip();
        L.rows.forEach((r, n) => {
          const ra = a - 0.08 - n * 0.04; if (ra <= 0) return;
          r.lines.forEach((ln, j) => G.typed(ctx, ln, x + 14, r.y + 10 + j * 16, SMALL, G.MID, (ra - 0.05) / 0.35));
        });
        ctx.restore();
      }
      ctx.restore();
    }
  }

  class BrowserActivity {
    constructor() { this.open = false; this.at = 0; this.age = 0; this.geo = null; this.head = 'Browser'; this.lines = []; }
    set(e) {
      const action = e.action || e.type || 'browser';
      const title = { discover: 'Browsers', open: 'Opened', search: 'Web search', read: 'Page', navigate: 'Navigate', error: 'Browser error' }[action] || 'Browser';
      this.head = title;
      const lines = [];
      if (action === 'discover') {
        const inst = (e.installed || []).map((b) => b.name || b.id).filter(Boolean);
        const run = (e.running || []).map((b) => b.name || b.id).filter(Boolean);
        lines.push(inst.length ? ('Installed: ' + inst.slice(0, 6).join(', ') + (inst.length > 6 ? '…' : '')) : 'Installed: none detected');
        lines.push(run.length ? ('Running: ' + run.slice(0, 6).join(', ') + (run.length > 6 ? '…' : '')) : 'Running: none detected');
        if (e.note) lines.push(String(e.note));
      } else if (action === 'search') {
        if (e.provider) lines.push('Source: ' + String(e.provider));
        if (e.query) lines.push('Query: ' + String(e.query).slice(0, 80));
        const res = (e.results || []).slice(0, 4);
        if (res.length) res.forEach((r, i) => {
          const t = String(r.title || r.url || '').slice(0, 56);
          const src = r.source || r.provider || e.provider || '';
          const cite = r.citation?.url || r.url || '';
          lines.push((i + 1) + '. ' + t + (src ? ' [' + src + ']' : ''));
          if (cite) lines.push('   ' + String(cite).slice(0, 72));
        });
        else if (e.count != null) lines.push('Results: ' + e.count);
        const cites = Array.isArray(e.citations) ? e.citations.filter(c => c && c.url).slice(0, 2) : [];
        if (cites.length && !res.length) cites.forEach((c) => lines.push('↳ ' + String(c.title || c.url).slice(0, 70)));
      } else if (action === 'read') {
        if (e.provider) lines.push('Source: ' + String(e.provider));
        if (e.title) lines.push('Title: ' + String(e.title).slice(0, 80));
        if (e.url) lines.push('URL: ' + String(e.url).slice(0, 90));
        if (e.lang && e.lang !== 'unknown') lines.push('Language: ' + e.lang);
        if (e.error) lines.push('Cannot read: ' + String(e.error).slice(0, 120));
        else if (e.text) lines.push(String(e.text).replace(/\s+/g, ' ').slice(0, 140));
        if (e.truncated) lines.push('More content available (truncated).');
      } else if (action === 'open') {
        if (e.url) lines.push('URL: ' + String(e.url).slice(0, 100));
        if (e.with) lines.push('Opened with: ' + e.with);
      } else if (action === 'navigate') {
        if (e.nav) lines.push('Action: ' + e.nav);
        if (e.url) lines.push('URL: ' + String(e.url).slice(0, 100));
        if (e.note) lines.push(String(e.note).slice(0, 140));
      } else if (action === 'exa_status') {
        this.head = 'Exa search';
        lines.push('Provider: Exa');
        lines.push('Status: ' + String(e.status || (e.configured ? 'configured' : 'not_configured')));
        if (e.note) lines.push(String(e.note).slice(0, 140));
      } else if (action === 'error') {
        if (e.provider) lines.push('Source: ' + String(e.provider));
        lines.push(String(e.error || 'Browser action failed.').slice(0, 160));
        if (e.note) lines.push(String(e.note).slice(0, 120));
        if (e.url) lines.push('URL: ' + String(e.url).slice(0, 90));
      } else {
        if (e.url) lines.push(String(e.url).slice(0, 100));
      }
      this.lines = lines.filter(Boolean).slice(0, 10);
      this.open = true; this.at = 0; this.age = 0;
    }
    layout() {
      const w = 320, pad = 14, lh = 16;
      let y = 34;
      const rows = this.lines.map((t) => {
        const lines = wrap(t, w - pad * 2, SMALL); const h = Math.max(lh, lines.length * lh);
        const r = { y, h, lines }; y += h + 4; return r;
      });
      return { w, h: Math.max(70, y + 10), rows };
    }
    fade() { return this.at > 12 ? clamp(1 - (this.at - 12) / 0.45, 0, 1) : 1; }
    update(dt, k, side, slot = 0) {
      this.age += dt; if (!this.open) return;
      this.at += dt; if (this.at > 12.6) { this.open = false; this.geo = null; return; }
      const L = this.layout(), GAP = 18, TOP = 16, BOT = 16;
      const left = { left: 0, right: 0 }, safe = R.safe ?? left;
      const roomR = (innerWidth - safe.right) - (k.pos.x + k.pos.r + GAP);
      const roomL = (k.pos.x - k.pos.r - GAP) - safe.left;
      let s = side === 'right' ? 'right' : 'left';
      if ((s === 'right' ? roomR : roomL) < L.w + 20 && (s === 'right' ? roomL : roomR) > (s === 'right' ? roomR : roomL)) s = s === 'right' ? 'left' : 'right';
      let x = s === 'right' ? k.pos.x + k.pos.r + GAP : k.pos.x - k.pos.r - GAP - L.w;
      x = clamp(x, safe.left + 8, innerWidth - safe.right - L.w - 8);
      let y = clamp(k.pos.y - L.h / 2 + slot, TOP + safe.top, innerHeight - BOT - L.h);
      this.geo = { x, y, w: L.w, h: L.h };
    }
    size() { const L = this.layout(); return { w: L.w, h: L.h }; }
    box() { return this.open && this.geo ? [this.geo.x, this.geo.y, this.geo.x + this.geo.w, this.geo.y + this.geo.h] : null; }
    draw(ctx) {
      if (!this.open || !this.geo) return;
      const { x, y } = this.geo, L = this.layout(), w = L.w, fade = this.fade();
      const e = 1 - (1 - clamp(this.age / 0.3, 0, 1)) ** 3, a = this.age - 0.3;
      ctx.save(); ctx.globalAlpha *= fade;
      G.chrome(ctx, x, y, Math.max(16, w * e), Math.max(16, L.h * e));
      if (a > 0) {
        ctx.fillStyle = G.rgba(G.ACC, 0.06); ctx.fillRect(x + 2, y + 2, w - 4, 24);
        ctx.fillStyle = G.DEEP; ctx.fillRect(x + 2, y + 26, w - 4, 1);
        [0,1].forEach((k) => { ctx.fillStyle = k ? G.DEEP : G.ACC; ctx.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
        G.typed(ctx, this.head, x + w / 2, y + 14, HEAD, G.DIM, a / 0.4, { anchor: 'middle' });
        ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 27, w - 4, L.h - 29); ctx.clip();
        L.rows.forEach((r, n) => {
          const ra = a - 0.04 - n * 0.03; if (ra <= 0) return;
          r.lines.forEach((ln, j) => G.typed(ctx, ln, x + 14, r.y + 10 + j * 16, SMALL, G.MID, (ra - 0.02) / 0.3));
        });
        ctx.restore();
      }
      ctx.restore();
    }
  }

  const orig = R.agentPlugin;
  R.agentPlugin = (k) => {
    const p = orig(k);
    if (!p) return p;
    const trail = new Trail();
    const system = new SystemStatus();
    const screen = new ScreenCapture();
    const browser = new BrowserActivity();
    const shown = () => k.presence === 'shown' || (k.presence === 'in' && k.presU > 0.72);
    const { over, update, quiet, extent } = p;
    p.quiet = () => !!quiet?.() && !trail.open && !system.open && !screen.open && !browser.open;
    p.extent = () => {
      const e = extent?.();
      let box = e ?? null;
      const merge = (b) => { if (!b) return; box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b; };
      if (shown()) { merge(trail.box()); merge(system.box()); merge(screen.box()); merge(browser.box()); }
      return box;
    };
    p.over = (ctx, env) => { over(ctx, env); if (shown()) { trail.draw(ctx); system.draw(ctx); screen.draw(ctx); browser.draw(ctx); } };
    p.update = (dt, env) => {
      update(dt, env);
      // Cards on the roomier side, away from a speech bubble beside it.
      const S = R.safe ?? { left: 0, right: 0 }, mid = (S.left + innerWidth - S.right) / 2;
      let side = k.m.x < mid ? 'right' : 'left';
      const bs = p.api?.bubble && !p.api.bubble.closing ? p.api.bubble.side : null;
      if (bs === side) side = side === 'right' ? 'left' : 'right';
      trail.update(dt, k, side, 0);
      let slot = (trail.open && trail.geo) ? (trail.geo.h + 12) : 0;
      system.update(dt, k, side, slot);
      if (system.open && system.geo) slot += system.geo.h + 12;
      screen.update(dt, k, side, slot);
      if (screen.open && screen.geo) slot += screen.geo.h + 12;
      browser.update(dt, k, side, slot);
    };
    if (p.api) {
      const keep = () => p.api.show?.({ summoned: true });
      p.api.cards = {
        trail: (e) => { keep(); trail.set(e, k); },
        system: (e) => { keep(); system.set(e, k); },
        screen: (e) => { keep(); screen.set(e, k); },
        browser: (e) => { keep(); browser.set(e, k); },
        get open() { return trail.open || system.open || screen.open || browser.open; },
      };
    }
    return p;
  };
})();
