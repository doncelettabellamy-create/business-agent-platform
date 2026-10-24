/* Intake work-item prototype: list and detail.
   Visual prototype only. Reads synthetic data from data.js. No network calls, no storage,
   no frameworks, no build step. Follows docs/blueprint/DESIGN_DIRECTION_2026.md (proposal). */
(function () {
  'use strict';

  var D = window.PROTO_DATA;
  var NS = 'http://www.w3.org/2000/svg';
  var content = document.getElementById('content');
  var banners = document.getElementById('banners');
  var live = document.getElementById('live');

  var state = {
    view: 'normal',      /* prototype control: normal | loading | empty | error | denied | offline | killswitch */
    status: 'all',
    category: 'all',
    q: '',
    page: 1,
    perPage: 8,
    selected: 0,
    kbd: false,          /* row highlight appears only after keyboard navigation starts */
    scrollY: 0,
    route: 'list'
  };
  var searchInput = null;
  var updateResults = function () {};
  var syncControls = function () {};

  /* ---------- helpers ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) { return; }
        if (k === 'class') { el.className = v; }
        else if (k === 'text') { el.textContent = v; }
        else if (k.slice(0, 2) === 'on') { el.addEventListener(k.slice(2), v); }
        else { el.setAttribute(k, v === true ? '' : v); }
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) { return; }
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function announce(msg) {
    live.textContent = '';
    window.setTimeout(function () { live.textContent = msg; }, 30);
  }

  var ICONS = {
    check: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M8 12.5l2.7 2.7L16 9.8' }]],
    flag: [['path', { d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z' }], ['path', { d: 'M4 22v-7' }]],
    alert: [['path', { d: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
    dashed: [['circle', { cx: 12, cy: 12, r: 10, 'stroke-dasharray': '3 3' }]],
    inbox: [['path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }], ['path', { d: 'M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z' }]],
    sliders: [['path', { d: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6' }]],
    shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
    chart: [['path', { d: 'M18 20V10M12 20V4M6 20v-6' }]]
  };
  function icon(name, size) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', size || 16);
    svg.setAttribute('height', size || 16);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (spec) {
      var el = document.createElementNS(NS, spec[0]);
      Object.keys(spec[1]).forEach(function (k) { el.setAttribute(k, spec[1][k]); });
      svg.appendChild(el);
    });
    return svg;
  }

  function statusInfo(item) {
    return item.status === 'ready'
      ? { cls: 'ready', icon: 'check', label: 'Ready' }
      : { cls: 'review', icon: 'flag', label: 'Needs review' };
  }
  function chip(info) { return h('span', { class: 'chip ' + info.cls }, [icon(info.icon, 16), info.label]); }
  function categoryOf(item) { return item.category || 'Unknown'; }
  function missingCount(item) {
    return item.fields.filter(function (f) { return !f.found; }).length;
  }
  function shortReason(item) {
    if (!item.reasons.length) { return ''; }
    var r = item.reasons[0];
    var map = {
      missing_fields: 'Missing ' + missingCount(item) + ' fields',
      low_confidence: 'Low confidence',
      detector_offline: 'Personal-data check offline',
      schema_invalid: 'Result did not validate',
      unknown_category: 'No matching category',
      token_cap: 'Safety limit reached'
    };
    var text = map[r] || 'Needs review';
    if (item.reasons.length > 1) { text += ' (+' + (item.reasons.length - 1) + ' more)'; }
    return text;
  }
  function renderTokens(text) {
    var out = [];
    var re = /\[[A-Z_]+_\d+\]/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) { out.push(text.slice(last, m.index)); }
      out.push(h('span', { class: 'token', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) { out.push(text.slice(last)); }
    return out;
  }
  function sortedItems() {
    return D.items.slice().sort(function (a, b) {
      if (a.status !== b.status) { return a.status === 'needs-human' ? -1 : 1; }
      return a.received < b.received ? 1 : -1;
    });
  }
  function visibleItems() {
    var q = state.q.trim().toLowerCase();
    return sortedItems().filter(function (it) {
      if (state.status !== 'all' && it.status !== state.status) { return false; }
      if (state.category !== 'all' && categoryOf(it) !== state.category) { return false; }
      if (q) {
        /* search covers ids, category, and field names only; never message content */
        var hay = [it.id, categoryOf(it)].concat(it.fields.map(function (f) { return f.name; })).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) { return false; }
      }
      return true;
    });
  }
  function categories() {
    var set = {};
    D.items.forEach(function (it) { set[categoryOf(it)] = true; });
    return Object.keys(set).sort();
  }
  function setTitle(t) { document.title = t + ' (prototype)'; }

  /* ---------- banners ---------- */
  function renderBanners() {
    clear(banners);
    if (state.view === 'offline') {
      banners.appendChild(h('div', { class: 'banner info', role: 'status' }, [
        icon('dashed', 16), "You're offline. Showing the last loaded data (last updated 2026-10-24 09:50, synthetic)."
      ]));
    }
    if (state.view === 'killswitch') {
      banners.appendChild(h('div', { class: 'banner warn', role: 'status' }, [
        icon('flag', 16), 'Processing is paused.'
      ]));
    }
  }

  /* ---------- shared state boxes ---------- */
  function stateBox(message, extra) {
    return h('div', { class: 'state-box' }, [h('p', { text: message })].concat(extra || []));
  }
  function skeletonRows(n) {
    var wrap = h('div', { class: 'table-wrap', role: 'status', 'aria-label': 'Loading' });
    for (var i = 0; i < n; i++) { wrap.appendChild(h('div', { class: 'skeleton skel-row' })); }
    return wrap;
  }

  /* ---------- prototype controls ---------- */
  function protoControls() {
    var options = [
      ['normal', 'Normal'], ['loading', 'Loading'], ['empty', 'Empty (no items yet)'], ['error', 'Error'],
      ['denied', 'Permission denied'], ['offline', 'Offline'], ['killswitch', 'Kill switch on']
    ];
    var select = h('select', { id: 'proto-state', class: 'control' }, options.map(function (o) {
      return h('option', { value: o[0], selected: state.view === o[0] ? true : null, text: o[1] });
    }));
    select.addEventListener('change', function () {
      state.view = select.value;
      render();
      announce('Showing state: ' + select.options[select.selectedIndex].text);
    });
    return h('details', { class: 'proto' }, [
      h('summary', { text: 'Prototype controls (not part of the product)' }),
      h('div', { class: 'row' }, [
        h('div', { class: 'field' }, [h('label', { for: 'proto-state', text: 'Screen state' }), select])
      ]),
      h('p', { text: 'All data on this page is synthetic. No messages, people, or numbers are real. Nothing is sent anywhere.' })
    ]);
  }

  /* ---------- list ---------- */
  function renderList() {
    state.route = 'list';
    setTitle('Work items');
    clear(content);
    content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Work items' }));
    content.appendChild(h('p', { class: 'lede', text: 'Requests received through the connected channel, with personal data hidden.' }));

    if (state.view === 'denied') {
      content.appendChild(stateBox("You don't have access to this workspace."));
    } else if (state.view === 'error') {
      content.appendChild(stateBox("We couldn't load items. Try again.", [
        h('p', { class: 'ref', text: 'Reference: corr-synthetic-0001' }),
        h('button', { class: 'btn primary', type: 'button', text: 'Retry', onclick: function () { state.view = 'normal'; render(); } })
      ]));
    } else if (state.view === 'loading') {
      content.appendChild(skeletonRows(6));
    } else if (state.view === 'empty') {
      content.appendChild(stateBox('No items yet. Messages sent to the connected channel appear here.'));
    } else {
      buildListBody();
    }
    content.appendChild(protoControls());
  }

  function buildListBody() {
    var ready = D.items.filter(function (i) { return i.status === 'ready'; }).length;
    var review = D.items.length - ready;
    content.appendChild(h('ul', { class: 'counts', 'aria-label': 'Counts by status' }, [
      h('li', {}, [h('span', { class: 'n', text: String(ready) }), chip({ cls: 'ready', icon: 'check', label: 'Ready' })]),
      h('li', {}, [h('span', { class: 'n', text: String(review) }), chip({ cls: 'review', icon: 'flag', label: 'Needs review' })])
    ]));

    /* autocomplete="off": stop the browser from restoring old filter values into the controls on reload or Back */
    var statusSel = h('select', { id: 'f-status', class: 'control', autocomplete: 'off' }, [
      h('option', { value: 'all', text: 'All' }),
      h('option', { value: 'ready', text: 'Ready' }),
      h('option', { value: 'needs-human', text: 'Needs review' })
    ]);
    statusSel.value = state.status;
    var catSel = h('select', { id: 'f-category', class: 'control', autocomplete: 'off' },
      [h('option', { value: 'all', text: 'All' })].concat(categories().map(function (c) { return h('option', { value: c, text: c }); })));
    catSel.value = state.category;
    searchInput = h('input', {
      id: 'f-search', class: 'control search', type: 'search', placeholder: 'Id, category, or field name',
      autocomplete: 'off', 'aria-describedby': 'search-hint'
    });
    searchInput.value = state.q;
    var clearBtn = h('button', { class: 'btn', type: 'button', text: 'Clear' });

    var results = h('div', { id: 'results' });

    /* keep the visible controls identical to the in-memory filter state (used after Back/Forward or restore) */
    syncControls = function () {
      statusSel.value = state.status; catSel.value = state.category; searchInput.value = state.q;
    };

    statusSel.addEventListener('change', function () { state.status = statusSel.value; state.page = 1; state.selected = 0; updateResults(); });
    catSel.addEventListener('change', function () { state.category = catSel.value; state.page = 1; state.selected = 0; updateResults(); });
    searchInput.addEventListener('input', function () { state.q = searchInput.value; state.page = 1; state.selected = 0; updateResults(); });
    clearBtn.addEventListener('click', function () {
      state.status = 'all'; state.category = 'all'; state.q = ''; state.page = 1; state.selected = 0;
      statusSel.value = 'all'; catSel.value = 'all'; searchInput.value = '';
      updateResults();
    });

    content.appendChild(h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter work items', onsubmit: function (e) { e.preventDefault(); } }, [
      h('div', { class: 'field' }, [h('label', { for: 'f-status', text: 'Status' }), statusSel]),
      h('div', { class: 'field' }, [h('label', { for: 'f-category', text: 'Category' }), catSel]),
      h('div', { class: 'field' }, [h('label', { for: 'f-search', text: 'Search' }), searchInput]),
      clearBtn
    ]));
    content.appendChild(h('p', { class: 'meta', id: 'search-hint' }, [
      'Search covers ids, categories, and field names, never message content. Keyboard: ',
      h('span', { class: 'kbd', text: '/' }), ' search, ', h('span', { class: 'kbd', text: 'J' }), ' ', h('span', { class: 'kbd', text: 'K' }),
      ' move, ', h('span', { class: 'kbd', text: 'Enter' }), ' open.'
    ]));
    content.appendChild(results);

    updateResults = function () {
      var rows = visibleItems();
      var pages = Math.max(1, Math.ceil(rows.length / state.perPage));
      if (state.page > pages) { state.page = pages; }
      var start = (state.page - 1) * state.perPage;
      var slice = rows.slice(start, start + state.perPage);
      if (state.selected > slice.length - 1) { state.selected = Math.max(0, slice.length - 1); }
      clear(results);

      var filtersActive = state.status !== 'all' || state.category !== 'all' || state.q.trim() !== '';
      if (rows.length === 0 && !filtersActive) {
        /* self-diagnosing: no filter is active, so an empty list means the sample data did not load */
        results.appendChild(stateBox('No sample items are loaded. Check that data.js is in the same folder as index.html.'));
        announce('No sample items are loaded.');
        return;
      }
      if (rows.length === 0) {
        results.appendChild(stateBox('No items match these filters.', [
          h('button', { class: 'btn', type: 'button', text: 'Clear filters', onclick: function () { clearBtn.click(); } })
        ]));
        announce('No items match these filters.');
        return;
      }

      var head = h('tr', { role: 'row' }, ['Status', 'Category', 'Received', 'Confidence', 'Reason'].map(function (t) {
        return h('th', { scope: 'col', role: 'columnheader', text: t });
      }));
      var body = h('tbody', { role: 'rowgroup' }, slice.map(function (it, idx) {
        var info = statusInfo(it);
        var open = function () { state.scrollY = window.scrollY; window.location.hash = '#/item/' + it.id; };
        var tr = h('tr', { role: 'row', 'data-index': String(idx), class: state.kbd && idx === state.selected ? 'is-selected' : '' }, [
          h('td', { role: 'cell', 'data-col': 'status' }, [
            h('a', {
              class: 'row-link', href: '#/item/' + it.id,
              'aria-label': 'Open item ' + it.id + ', ' + info.label + ', ' + categoryOf(it),
              onclick: function () { state.scrollY = window.scrollY; }
            }, [chip(info)])
          ]),
          h('td', { role: 'cell', 'data-col': 'category', text: categoryOf(it) }),
          h('td', { role: 'cell', 'data-col': 'received', class: 'meta', text: it.received }),
          h('td', { role: 'cell', 'data-col': 'confidence', class: 'num', text: it.confidence === null ? 'None' : it.confidence.toFixed(2) }),
          h('td', { role: 'cell', 'data-col': 'reason', class: 'reason-text', text: shortReason(it) })
        ]);
        tr.addEventListener('click', function (e) { if (e.target.closest('a')) { return; } open(); });
        return tr;
      }));
      var table = h('table', { class: 'items', role: 'table', 'aria-label': 'Work items' }, [
        h('thead', { role: 'rowgroup' }, [head]), body
      ]);
      results.appendChild(h('div', { class: 'table-wrap' }, [table]));

      var prev = h('button', { class: 'btn', type: 'button', text: 'Previous', disabled: state.page <= 1 ? true : null,
        onclick: function () { state.page--; state.selected = 0; updateResults(); } });
      var next = h('button', { class: 'btn', type: 'button', text: 'Next', disabled: state.page >= pages ? true : null,
        onclick: function () { state.page++; state.selected = 0; updateResults(); } });
      results.appendChild(h('div', { class: 'pager' }, [
        h('span', { class: 'meta', text: (start + 1) + ' to ' + (start + slice.length) + ' of ' + rows.length }),
        h('div', { style: 'display:flex;gap:8px' }, [prev, next])
      ]));
      announce(rows.length + (rows.length === 1 ? ' item shown' : ' items shown'));
    };
    updateResults();
  }

  /* ---------- detail ---------- */
  var AGENTS = [
    { key: 'intake', name: 'Intake', glyph: 'inbox' },
    { key: 'processing', name: 'Processing', glyph: 'sliders' },
    { key: 'qc', name: 'Quality Control', glyph: 'shield' },
    { key: 'reporting', name: 'Reporting', glyph: 'chart' }
  ];
  function agentState(key, item) {
    if (key === 'intake') {
      return item.status === 'ready' ? { text: 'done', inactive: false } : { text: 'needs review', inactive: false };
    }
    if (key === 'processing') {
      return item.handedOff ? { text: 'stub: receives hand-off only', inactive: true } : { text: 'not active in the pilot', inactive: true };
    }
    return { text: 'not active in the pilot', inactive: true };
  }
  function pipelineStrip(item) {
    return h('ol', { class: 'pipeline', 'aria-label': 'The four agents and their state for this item' }, AGENTS.map(function (a) {
      var st = agentState(a.key, item);
      return h('li', { class: 'pipe-item' + (st.inactive ? ' inactive' : ''), 'data-agent': a.key }, [
        h('span', { class: 'pipe-glyph' }, [icon(a.glyph, 16)]),
        h('div', {}, [h('div', { class: 'pipe-name', text: a.name }), h('div', { class: 'pipe-state', text: st.text })])
      ]);
    }));
  }
  function stepTrace(item) {
    return h('ol', { class: 'trace', 'aria-label': 'Steps taken for this item' }, item.steps.map(function (s) {
      var ic = s.status === 'done' ? icon('check', 16) : (s.status === 'failed' ? icon('alert', 16) : icon('dashed', 16));
      var word = s.status === 'failed' ? 'Did not finish' : (s.status === 'skipped' ? 'Not run' : '');
      var sub = [word, s.note].filter(Boolean).join(' . ');
      var left = h('div', {}, [s.name, sub ? h('span', { class: 'state-word' + (s.status === 'failed' ? ' failed' : ''), text: sub }) : null]);
      return h('li', {}, [
        h('span', { class: s.status === 'failed' ? 'failed' : '' }, [ic]),
        left,
        h('span', { class: 'ms', text: s.ms === null ? '' : s.ms + ' ms' })
      ]);
    }));
  }

  function renderDetail(id) {
    state.route = 'detail';
    clear(content);
    var item = null;
    D.items.forEach(function (it) { if (it.id === id) { item = it; } });
    var crumbs = function (label) {
      return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, [h('ol', {}, [
        h('li', {}, [h('a', { href: '#/', text: 'Work items' })]),
        h('li', {}, [h('span', { 'aria-current': 'page', text: label })])
      ])]);
    };

    if (state.view === 'denied' || !item) {
      setTitle('Not available');
      content.appendChild(crumbs('Item'));
      content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Work item' }));
      content.appendChild(stateBox("You don't have access to this item.", [h('a', { class: 'btn', href: '#/', text: 'Back to work items' })]));
      content.appendChild(protoControls());
      return;
    }
    if (state.view === 'loading') {
      setTitle('Loading');
      content.appendChild(crumbs('Loading'));
      content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Work item' }));
      content.appendChild(skeletonRows(6));
      content.appendChild(protoControls());
      return;
    }
    if (state.view === 'error') {
      setTitle('Error');
      content.appendChild(crumbs('Item ' + item.id));
      content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Work item' }));
      content.appendChild(stateBox("We couldn't load this item. Try again.", [
        h('p', { class: 'ref', text: 'Reference: corr-synthetic-0002' }),
        h('button', { class: 'btn primary', type: 'button', text: 'Retry', onclick: function () { state.view = 'normal'; render(); } })
      ]));
      content.appendChild(protoControls());
      return;
    }

    setTitle('Item ' + item.id);
    var info = statusInfo(item);
    content.appendChild(crumbs('Item ' + item.id));
    content.appendChild(h('div', { class: 'detail-head' }, [
      h('div', {}, [
        h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: categoryOf(item) }),
        h('p', { class: 'meta' }, ['Received ' + item.received + ' through ' + D.channelLabel + ' . Item ', h('span', { class: 'mono', text: item.id })])
      ]),
      chip(info)
    ]));

    var read = h('div', { class: 'col-read' });

    var piiLine;
    if (item.message === null) { piiLine = item.messageHidden; }
    else if (item.pii.length === 0) { piiLine = 'No personal data was found in this message.'; }
    else {
      piiLine = 'Hidden to protect personal data: ' + item.pii.map(function (p) { return p.type + ' x ' + p.count; }).join(', ') + '.';
    }
    read.appendChild(h('section', { class: 'card', 'aria-labelledby': 'h-msg' }, [
      h('p', { class: 'overline', text: 'Message (masked)' }),
      h('h2', { class: 'sr-only', id: 'h-msg', text: 'Message (masked)' }),
      item.message === null ? null : h('p', { class: 'msg' }, renderTokens(item.message)),
      h('p', { class: 'hidden-note', text: piiLine })
    ]));

    var fieldsCard = h('section', { class: 'card', 'aria-labelledby': 'h-fields' }, [h('h2', { class: 'title', id: 'h-fields', text: 'Extracted fields' })]);
    if (item.fields.length === 0) {
      fieldsCard.appendChild(h('p', { class: 'hidden-note', text: 'No fields were extracted.' }));
    } else {
      fieldsCard.appendChild(h('table', { class: 'fields' }, [
        h('thead', {}, [h('tr', {}, ['Field', 'Value (masked)', 'Confidence', 'Found'].map(function (t) { return h('th', { scope: 'col', text: t }); }))]),
        h('tbody', {}, item.fields.map(function (f) {
          return h('tr', {}, [
            h('td', { text: f.name }),
            h('td', {}, f.found ? renderTokens(f.value) : ['Not found']),
            h('td', { class: 'num', text: f.conf === null ? 'None' : f.conf.toFixed(2) }),
            h('td', { text: f.found ? 'Yes' : 'No' })
          ]);
        }))
      ]));
    }
    read.appendChild(fieldsCard);

    if (item.reasons.length) {
      read.appendChild(h('section', { class: 'card', 'aria-labelledby': 'h-why' }, [
        h('h2', { class: 'title', id: 'h-why', text: 'Why this needs review' }),
        h('ul', { class: 'reasons' }, item.reasons.map(function (r) {
          var t = D.reasons[r];
          if (r === 'missing_fields') { t = missingCount(item) + ' required fields were not found in the message.'; }
          return h('li', { text: t });
        }))
      ]));
    }

    var side = h('aside', { 'aria-labelledby': 'h-handled' }, [
      h('section', { class: 'card tight' }, [
        h('h2', { class: 'heading', id: 'h-handled', text: 'How this was handled' }),
        pipelineStrip(item),
        h('p', { class: 'overline', text: 'Steps' }),
        stepTrace(item),
        h('p', { class: 'versions', text: 'Skill ' + D.versions.skill + ' . Model ' + D.versions.model + ' . Prompt ' + D.versions.prompt })
      ])
    ]);

    content.appendChild(h('div', { class: 'detail-grid' }, [read, side]));
    content.appendChild(protoControls());
  }

  /* ---------- router ---------- */
  function render() {
    renderBanners();
    var m = (window.location.hash || '#/').match(/^#\/item\/([\w-]+)$/);
    var comingFromDetail = state.route === 'detail';
    if (m) { renderDetail(m[1]); } else { renderList(); }
    var title = document.getElementById('page-title');
    if (title) { title.focus({ preventScroll: true }); }
    if (!m && comingFromDetail) { window.scrollTo(0, state.scrollY); }
    else if (m) { window.scrollTo(0, 0); }
  }
  window.addEventListener('hashchange', render);

  /* ---------- keyboard ---------- */
  function moveSelection(delta) {
    var rows = content.querySelectorAll('.items tbody tr');
    if (!rows.length) { return; }
    if (!state.kbd) { state.kbd = true; delta = 0; }   /* first key press highlights the current row */
    var next = Math.max(0, Math.min(rows.length - 1, state.selected + delta));
    rows[state.selected] && rows[state.selected].classList.remove('is-selected');
    state.selected = next;
    rows[next].classList.add('is-selected');
    rows[next].scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }
    var t = e.target;
    var tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape' && t.blur) { t.blur(); }
      return;
    }
    if (state.route === 'list' && !(state.view === 'loading' || state.view === 'empty' || state.view === 'error' || state.view === 'denied')) {
      if (e.key === '/') { e.preventDefault(); if (searchInput) { searchInput.focus(); } }
      else if (e.key === 'j' || e.key === 'J') { moveSelection(1); }
      else if (e.key === 'k' || e.key === 'K') { moveSelection(-1); }
      else if (e.key === 'Enter' && tag !== 'A' && tag !== 'BUTTON' && tag !== 'SUMMARY') {
        var rows = content.querySelectorAll('.items tbody tr');
        var row = rows[state.selected];
        if (row) { var a = row.querySelector('a'); if (a) { state.scrollY = window.scrollY; window.location.hash = a.getAttribute('href'); } }
      }
    } else if (state.route === 'detail' && e.key === 'Escape') {
      window.location.hash = '#/';
    }
  });

  /* Back/Forward cache or restored pages: re-render from the in-memory state so stale control values never show */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { render(); } else if (state.route === 'list') { syncControls(); }
  });

  /* Boot guard: show a clear message instead of a blank page if the sample data file is missing */
  if (!D || !D.items || !D.items.length) {
    clear(content);
    content.appendChild(h('h1', { class: 'display', text: 'Work items' }));
    content.appendChild(h('div', { class: 'state-box' }, [
      h('p', { text: 'The synthetic sample data did not load. Make sure data.js is in the same folder as index.html, then reload.' })
    ]));
    return;
  }
  render();
})();
