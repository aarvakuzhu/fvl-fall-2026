/* Reusable Champions & Awards component. Data comes from GET /api/tournament/standings
 * (`awards`, `isTd`). Used by standings.html (full section) and index.html (hub preview).
 *   FVLAwards.render(el, awards, { isTd, onPick(award, teamId|null) })
 *   FVLAwards.preview(el, awards)  -> compact summary that fits a hub card
 * Relies only on the shared theme CSS variables (--gold, --text, --surface*, --border2). */
(function () {
  var CSS = '.award-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:6px;}' +
    '.award{border:1px solid var(--border2);border-radius:10px;padding:12px;background:var(--surface2);}' +
    '.award.won{border-color:var(--gold);}' +
    '.award .a-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-family:var(--fu);font-size:0.62rem;letter-spacing:1px;text-transform:uppercase;color:var(--gold);}' +
    '.award .a-team{font-size:1.05rem;font-weight:700;margin:6px 0 8px;color:var(--text);}' +
    '.award .a-pending{color:var(--text2);font-size:0.85rem;margin:6px 0 2px;}' +
    '.award .a-players{display:flex;flex-wrap:wrap;gap:6px;}' +
    '.award .a-pl{display:flex;align-items:center;gap:5px;font-size:0.75rem;background:var(--surface3);border-radius:999px;padding:2px 8px 2px 2px;color:var(--text);}' +
    '.award .a-pl img,.award .a-pl .ph{width:22px;height:22px;border-radius:50%;object-fit:cover;background:var(--border2);display:inline-block;}' +
    '.award select{width:100%;margin-top:6px;padding:6px;background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--fu);}';
  function injectCss() {
    if (document.getElementById('fvl-awards-css')) return;
    var st = document.createElement('style'); st.id = 'fvl-awards-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function icon(t) { return /trophy/i.test(t) ? '🏆' : '🏅'; }

  function render(el, awards, opts) {
    injectCss();
    opts = opts || {};
    if (!awards || !awards.list || !awards.list.length) { el.innerHTML = ''; return false; }
    el.innerHTML = '<div class="award-grid">' + awards.list.map(function (a) {
      var head = '<div class="a-head"><span>' + icon(a.type) + ' ' + esc(a.award) + '</span><span>' + esc(a.type) + '</span></div>';
      var canPick = a.kind === 'manual' && opts.isTd && opts.onPick;
      if (!a.team) {
        var pick = canPick ? '<select data-award="' + esc(a.award) + '"><option value="">Pick winner…</option>' +
          (awards.teams || []).map(function (t) { return '<option value="' + t.teamId + '">' + esc(t.name) + '</option>'; }).join('') + '</select>' : '';
        return '<div class="award">' + head + '<div class="a-pending">' + (a.kind === 'manual' ? 'To be announced' : 'Awaiting final result') + '</div>' + pick + '</div>';
      }
      var players = a.team.players.map(function (p) {
        var img = p.pic ? '<img src="' + esc(p.pic) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;ph&quot;></span>\'">' : '<span class="ph"></span>';
        return '<span class="a-pl">' + img + esc(p.name) + (p.isCaptain ? ' ⭐' : '') + '</span>';
      }).join('');
      var clear = canPick ? '<button class="pill muted" style="border:0;cursor:pointer;margin-top:8px;" data-award-clear="' + esc(a.award) + '">Change</button>' : '';
      return '<div class="award won">' + head + '<div class="a-team">' + esc(a.team.name) + '</div><div class="a-players">' + players + '</div>' + clear + '</div>';
    }).join('') + '</div>';
    if (opts.onPick) {
      el.querySelectorAll('[data-award]').forEach(function (s) { s.addEventListener('change', function () { if (s.value) opts.onPick(s.dataset.award, Number(s.value)); }); });
      el.querySelectorAll('[data-award-clear]').forEach(function (b) { b.addEventListener('click', function () { opts.onPick(b.dataset.awardClear, null); }); });
    }
    return true;
  }

  // Compact preview for a hub card: decided awards (up to 4) + progress.
  function preview(el, awards) {
    var list = (awards && awards.list) || [];
    if (!list.length) { el.textContent = 'Not started yet'; return; }
    var done = list.filter(function (a) { return a.team; });
    if (!done.length) { el.innerHTML = '<span style="color:var(--text2);">' + list.length + ' awards up for grabs — winners appear as finals are played</span>'; el.classList.remove('muted'); return; }
    el.innerHTML = done.slice(0, 4).map(function (a) {
      return '<div>' + icon(a.type) + ' ' + esc(a.award) + ': <b>' + esc(a.team.name) + '</b></div>';
    }).join('') + '<div style="color:var(--text2);margin-top:4px;">' + done.length + ' of ' + list.length + ' decided' + (done.length > 4 ? ' · see all' : '') + '</div>';
    el.classList.remove('muted');
  }

  window.FVLAwards = { render: render, preview: preview };
})();
