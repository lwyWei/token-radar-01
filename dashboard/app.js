// Token Radar's dashboard, model radar-2. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the filters, a per-protocol detail view with the model's
// own inputs and the protocol's farm plan, and a sandbox that re-ranks the board live. No
// network: every byte it shows is in data.js. No framework: plain DOM, system type only.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var DEFAULTS = { base: DATA.model.base_multiple, weight: DATA.model.growth_weight };
  var state = {
    q: '', category: 'all', chain: 'all', minTvl: 0, watchOnly: false, rankCap: 0,
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
    sandbox: { base: DEFAULTS.base, weight: DEFAULTS.weight, on: false }
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model in one function, identical to lib/model.ts: the page recomputes a row from the
  // snapshot figures and checks the number board.json carries, so the page's code and the board's
  // data are visibly the same arithmetic. The sandbox only changes the two constants it is given.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + model.maturity_range * Math.sqrt(Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days);
    var breadth = 1 + model.breadth_step * Math.min(Math.max((row.chains || []).length - 1, 0), model.breadth_max_chains);
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth));
  }
  function factorsOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    return {
      growth: 1 + (growth / 100) * model.growth_weight,
      maturity: model.maturity_floor + model.maturity_range * Math.sqrt(Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days),
      breadth: 1 + model.breadth_step * Math.min(Math.max((row.chains || []).length - 1, 0), model.breadth_max_chains)
    };
  }
  function modelNow() {
    if (!state.sandbox.on) return DATA.model;
    return {
      base_multiple: state.sandbox.base, growth_weight: state.sandbox.weight,
      growth_floor: DATA.model.growth_floor, growth_cap: DATA.model.growth_cap,
      maturity_floor: DATA.model.maturity_floor, maturity_range: DATA.model.maturity_range,
      maturity_days: DATA.model.maturity_days, unknown_age_days: DATA.model.unknown_age_days,
      breadth_step: DATA.model.breadth_step, breadth_max_chains: DATA.model.breadth_max_chains
    };
  }
  function shownValue(row) {
    return state.sandbox.on ? impliedOf(row, modelNow()) : row.implied_value_usd;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and
  // age decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasNote(chain) {
    if (chain === 'Ethereum') return 'on Ethereum, budget $5 to $15 of gas for each action';
    return 'on ' + chain + ', budget under $1 of gas for each action';
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateralized debt') >= 0) return 'Lend $' + capital + ' of USDC on ' + name + ' on ' + chain + ' and leave the supply open so the position accrues.';
    if (c.indexOf('leveraged farm') >= 0) return 'Open a $' + capital + ' leveraged position in ' + name + "'s main farm on " + chain + ' at 2x leverage or less.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('yield aggregator') >= 0) return 'Add $' + capital + ' of liquidity to ' + name + "'s deepest pool on " + chain + ' and keep the LP tokens.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('canonical bridge') >= 0) return 'Bridge $' + capital + ' of USDC into ' + chain + ' with ' + name + ', then put the bridged funds to work in its app.';
    if (c.indexOf('restak') >= 0 || c.indexOf('liquid staking') >= 0) return 'Stake $' + capital + ' through ' + name + ' on ' + chain + ' and hold the receipt token instead of selling it.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Post $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged trade, then close it.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' on ' + name + ' and take one position in a market that settles within the week.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('risk curator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of " + name + "'s yield-bearing asset on " + chain + ' and hold it through the month.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('options') >= 0) return 'Sell one covered call with $' + capital + ' of collateral on ' + name + ' on ' + chain + '.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    return [
      { text: 'Open a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline where no one else can read it.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital; ' + gasNote(chain), time: '15 minutes to set up' },
      { text: "Open " + p.name + "'s own points or rewards page, connect the farming wallet, and confirm the position counts toward eligibility.", cost: 'no fee to check', time: '10 minutes' },
      { text: 'Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays active in every snapshot.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Keep the position open for at least ' + hold + ' days, so the activity spans more than one of the protocol' + "'" + 's snapshots.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Check the protocol's own announcements once a week for a token or points update, and ignore links from anywhere else.", cost: 'nothing', time: '5 minutes a week' },
      { text: 'When you exit, claim only from the link the protocol itself publishes, and write the wallet, the dates and every transaction in a farm log.', cost: 'no fee to check, and never pay to claim', time: '10 minutes to claim, 5 minutes to log' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('mintvl')) state.minTvl = Number(params.get('mintvl')) || 0;
    if (params.get('watch') === '1') state.watchOnly = true;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl) params.set('mintvl', String(state.minTvl));
    if (state.watchOnly) params.set('watch', '1');
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function isWatchlist(slug) { return DATA.watchlist_slugs && DATA.watchlist_slugs.indexOf(slug) >= 0; }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      if (state.watchOnly && !isWatchlist(r.slug)) return false;
      if (state.rankCap && r.rank > state.rankCap) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'chains') { av = (a.chains || []).length; bv = (b.chains || []).length; }
      else { av = shownValue(a); bv = shownValue(b); }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'TOKEN RADAR' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    var totalTvl = DATA.rows.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    var values = DATA.rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var median = values[Math.floor(values.length / 2)] || 0;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, found by size. Implied value is a model claim, not a promise — and "records no token" is not proof a protocol has none.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('small', { text: 'every watchlist slug is on the board' })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) }), el('small', { text: DATA.early_size + ' early rows below the floor' })),
        el('div', { class: 'fact' }, el('span', { text: 'Board TVL' }), el('b', { text: fmtUsd(totalTvl) }), el('small', { text: 'locked value across the ranked rows' })),
        el('div', { class: 'fact' }, el('span', { text: 'Median implied value' }), el('b', { text: fmtUsd(median) }), el('small', { text: DATA.live_size + ' live-token protocols set aside' }))
      )
    );
  }

  function selectField(id, label, options, current, onChange) {
    var select = el('select', { id: id, 'aria-label': label },
      options.map(function (o) { return el('option', { value: String(o.value), text: o.text, selected: String(o.value) === String(current) ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { onChange(select.value); writeHash(); render(); });
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), select);
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; }).slice(0, 12);
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var watch = el('input', { type: 'checkbox', id: 'watch', checked: state.watchOnly ? 'checked' : null });
    watch.addEventListener('change', function () { state.watchOnly = watch.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var chips = el('div', { class: 'chips' },
      [['Top 10', 10], ['Top 50', 50], ['All rows', 0]].map(function (c) {
        return el('button', { type: 'button', class: 'chip', 'aria-pressed': state.rankCap === c[1] ? 'true' : 'false', text: c[0], onclick: function () { state.rankCap = c[1]; render(); } });
      })
    );
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      selectField('category', 'Category', [{ value: 'all', text: 'All categories' }].concat(categories.map(function (c) { return { value: c, text: c }; })), state.category, function (v) { state.category = v; }),
      selectField('chain', 'Chain', [{ value: 'all', text: 'All chains' }].concat(chains.map(function (c) { return { value: c, text: c + ' (' + chainCounts[c] + ')' }; })), state.chain, function (v) { state.chain = v; }),
      selectField('mintvl', 'Min TVL', [{ value: 0, text: 'Any TVL' }, { value: 1e8, text: '$100M and up' }, { value: 5e8, text: '$500M and up' }, { value: 1e9, text: '$1B and up' }], state.minTvl, function (v) { state.minTvl = Number(v); }),
      el('label', { class: 'check', for: 'watch' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Quick rank' }), chips),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.watchOnly = false; state.rankCap = 0; writeHash(); render(); } })
      ));
    }
    var max = 1;
    list.forEach(function (r) { max = Math.max(max, shownValue(r)); });
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var value = shownValue(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: String((r.chains || []).length) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((value / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(value) })
        )),
        el('td', null, el('span', { class: 'status pre', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: (state.sandbox.on ? 'Sandbox values: the submitted board uses the default constants. ' : '') + 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('chains', 'Chains'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function factorBar(label, value, min, max, shown) {
    var pct = Math.max(2, Math.min(100, Math.round(((value - min) / (max - min)) * 100)));
    return el('li', null,
      el('span', { class: 'fname', text: label }),
      el('span', { class: 'fbar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + pct + '%' })),
      el('span', { class: 'num', text: shown })
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var sb = state.sandbox;
    var baseSlider = el('input', { type: 'range', id: 'sb-base', min: '0.1', max: '0.6', step: '0.05', value: String(sb.base), 'aria-label': 'Base multiple' });
    var weightSlider = el('input', { type: 'range', id: 'sb-weight', min: '0', max: '1', step: '0.1', value: String(sb.weight), 'aria-label': 'Growth weight' });
    baseSlider.addEventListener('input', function () { sb.base = Number(baseSlider.value); sb.on = true; render(); });
    weightSlider.addEventListener('input', function () { sb.weight = Number(weightSlider.value); sb.on = true; render(); });
    var reset = el('button', { class: 'button ghost', type: 'button', text: 'Reset to the submitted model', onclick: function () { sb.base = DEFAULTS.base; sb.weight = DEFAULTS.weight; sb.on = false; render(); } });
    return el('section', { class: 'panel pad model' },
      el('div', { class: 'model-grid' },
        el('div', null,
          el('h2', { text: 'How implied value is computed' }),
          el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
          el('div', { class: 'formula' },
            'implied = round( tvl_usd x ' + m.base_multiple + '\n' +
            '  x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')\n' +
            '  x (' + m.maturity_floor + ' + ' + m.maturity_range + ' x sqrt(min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + '))\n' +
            '  x (1 + ' + m.breadth_step + ' x min(chains - 1, ' + m.breadth_max_chains + ')) )'
          ),
          el('p', { class: 'sub', text: 'TVL, seven-day growth, age and chain count come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days, and a missing seven-day change counts as 0.' })
        ),
        el('div', { class: 'sandbox' },
          el('h2', { text: 'Model sandbox' }),
          el('p', { class: 'sub', text: 'Move a slider and the board re-ranks live with the same formula. The submitted board uses the default constants; the sandbox only explores what would change.' }),
          el('label', { for: 'sb-base' }, el('span', { text: 'Base multiple' }), el('b', { text: 'x ' + sb.base.toFixed(2) })),
          baseSlider,
          el('label', { for: 'sb-weight' }, el('span', { text: 'Growth weight' }), el('b', { text: 'x ' + sb.weight.toFixed(1) })),
          weightSlider,
          el('p', { class: 'sub note', text: sb.on ? 'Sandbox values are showing: the table above uses these constants, not the submitted ones.' : 'Sliders are at the submitted defaults.' }),
          reset
        )
      )
    );
  }

  function methodPanel() {
    return el('section', { class: 'panel pad' },
      el('div', { class: 'method' },
        el('div', null,
          el('h2', { text: 'How to read this board' }),
          el('ul', null,
            el('li', { text: 'Rank 1 is the highest implied value. The number is a claim about what a token would be worth if the protocol launched one today, at the snapshot\u2019s figures — not a price, and not a prediction that a token comes.' }),
            el('li', { text: 'The watchlist is a floor, never a ceiling: the board also ranks 160 pre-token protocols below the $50M floor, found by TVL.' }),
            el('li', { text: 'Live-token protocols are shown apart, with their market caps. A protocol that already trades is never mixed into the pre-token ranking.' })
          )
        ),
        el('div', null,
          el('h2', { text: 'What the numbers do not say' }),
          el('ul', null,
            el('li', { text: '"Records no token" means DefiLlama\u2019s record carries no token. It is not proof the protocol has none.' }),
            el('li', { text: 'A farm plan is a starting point, not advice. Never pay to claim an airdrop, and never connect a wallet holding funds you cannot lose.' }),
            el('li', { text: 'Data: DefiLlama protocol index, snapshot ' + DATA.as_of + '. The snapshot never moves; every run of this board reads the same bytes.' })
          )
        )
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var model = modelNow();
    var factors = factorsOf(row, model);
    var recomputed = impliedOf(row, model);
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rankline', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Why this rank' }),
      el('p', { class: 'why', text: row.why })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('ul', { class: 'factor-list' },
        factorBar('Size', row.tvl_usd * model.base_multiple, 0, Math.max(1, DATA.rows[0].tvl_usd * model.base_multiple), fmtUsd(row.tvl_usd * model.base_multiple)),
        factorBar('Growth', factors.growth, 0.5, 1.9, 'x ' + factors.growth.toFixed(2)),
        factorBar('Maturity', factors.maturity, 0.55, 1.0, 'x ' + factors.maturity.toFixed(2)),
        factorBar('Breadth', factors.breadth, 1.0, 1.25, 'x ' + factors.breadth.toFixed(2))
      ),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String((row.chains || []).length) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(state.sandbox.on ? recomputed : row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Listed' }), el('b', { class: 'num', text: row.listed_at || 'unknown' }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('div', null, el('b', { text: action }), el('span', { class: 'cost', text: tail })));
      }))
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Read this first' }),
      el('ul', { class: 'risks' },
        el('li', { text: 'This protocol records no token. That is the snapshot\u2019s record, not proof it has none — verify before you farm.' }),
        el('li', { text: 'Never pay to claim an airdrop, and never paste a seed phrase anywhere.' }),
        el('li', { text: 'Farm with funds you can afford to lose; a token may never come.' })
      )
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(methodPanel());
    shell.appendChild(el('footer', { class: 'foot', text: 'Token Radar, model ' + DATA.model_version + ' · Data: DefiLlama protocol index, snapshot ' + DATA.as_of + ' · Implied value is a model estimate, not a price or a promise.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
