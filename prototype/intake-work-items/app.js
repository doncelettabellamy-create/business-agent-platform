/* Phone intakes for the business owner: the list of intakes and the page for one intake.
   It shows what the server sends, which is the owner view's fixed allow-list (src/owner-view.ts): no confidence, codes, masks, steps,
   ids or addresses ever reach this page. Everything is written as text, never as HTML. The only network call is GET /api/owner. */
(function () {
  'use strict';

  var REFRESH_MS = 15000;
  var PAGE = 25;
  var LABELS = {
    requestedTime: 'Requested time (not booked)',
    intakesToday: 'Intakes received today',
    intakesTotal: 'Intakes received in total',
    needFollowUp: 'Need follow-up',
    withRequestedTime: 'With a requested time',
    confirmedByCaller: 'Confirmed by the caller'
  };
  var CONFIRMED = 'Confirmed by the caller';
  var CALL_HASH = /^#\/call\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)-(\d{1,4})$/;

  var el = function (id) { return document.getElementById(id); };
  var content = el('content'), banner = el('banner'), updated = el('updated'), live = el('live'), refreshBtn = el('refresh');
  var state = { data: null, tab: null, chosen: false, limit: PAGE, scrollY: 0, route: 'list', busy: false, timer: null };

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) { return; }
      if (k === 'class') { node.className = v; }
      else if (k === 'text') { node.textContent = v; }
      else if (k.slice(0, 2) === 'on') { node.addEventListener(k.slice(2), v); }
      else { node.setAttribute(k, v === true ? '' : v); }
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) { return; }
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function setTitle(t) { document.title = t + ' - Phone assistant'; }

  function when(iso, long) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return 'Unknown time'; }
    return d.toLocaleString(undefined, long
      ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function validShape(d) {
    if (!d || !Array.isArray(d.calls) || !d.summary) { return false; }
    var s = d.summary;
    return ['intakesReceivedToday', 'intakesReceivedTotal', 'needFollowUp', 'withRequestedTime', 'confirmedByCaller'].every(function (k) { return typeof s[k] === 'number'; });
  }

  /* A call has no id on purpose. Its address in the page is its time plus a count of earlier calls with the very same time. */
  function keyOf(calls, index) {
    var n = 0;
    for (var i = 0; i < index; i++) { if (calls[i].at === calls[index].at) { n++; } }
    return calls[index].at + '-' + n;
  }
  function findByKey(key) {
    var calls = state.data === null ? [] : state.data.calls;
    for (var i = 0; i < calls.length; i++) { if (keyOf(calls, i) === key) { return calls[i]; } }
    return null;
  }
  function currentKey() {
    var m = (window.location.hash || '').match(CALL_HASH);
    return m ? m[1] + '-' + m[2] : null;
  }

  function chip(call) {
    var ok = call.statusText === CONFIRMED;
    return h('span', { class: 'chip ' + (ok ? 'ok' : 'warn') }, [
      h('span', { class: 'chip-mark', 'aria-hidden': 'true', text: ok ? '✓' : '!' }), call.statusText
    ]);
  }
  function fact(label, value) { return h('div', { class: 'fact' }, [h('dt', { text: label }), h('dd', { text: value })]); }
  function actions(list) { return h('ul', { class: 'steps' }, list.map(function (a) { return h('li', { text: a }); })); }

  /* ---------- the list ---------- */
  function tile(label, n, attention) {
    return h('li', { class: 'tile' + (attention ? ' attention' : '') }, [h('span', { class: 'tile-n', text: String(n) }), h('span', { class: 'tile-label', text: label })]);
  }
  function listCard(calls, index) {
    var call = calls[index];
    var href = '#/call/' + keyOf(calls, index);
    var go = function () { state.scrollY = window.scrollY || 0; window.location.hash = href; };
    var li = h('li', { class: 'card' + (call.needsFollowUp ? ' follow' : '') }, [
      h('div', { class: 'card-top' }, [
        h('h3', { class: 'card-title' }, [h('a', { href: href, text: call.request, onclick: function () { state.scrollY = window.scrollY || 0; } })]),
        chip(call)
      ]),
      h('p', { class: 'when' }, [h('time', { datetime: call.at, text: when(call.at, false) })]),
      h('p', { class: 'summary', text: call.summary === null ? 'No request details were captured.' : call.summary }),
      call.requestedTime === null ? null : h('p', { class: 'asked', text: LABELS.requestedTime + ': ' + call.requestedTime }),
      h('p', { class: 'next-one', text: call.nextActions[0] }),
      h('p', { class: 'more' }, [h('a', { href: href, text: 'View details', onclick: function () { state.scrollY = window.scrollY || 0; } })])
    ]);
    li.addEventListener('click', function (e) { if (e && e.target && e.target.closest && e.target.closest('a')) { return; } go(); });
    return li;
  }
  function renderList() {
    state.route = 'list';
    setTitle('Phone intakes');
    clear(content);
    content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Phone intakes' }));
    content.appendChild(h('p', { class: 'lede', text: 'Calls taken by your phone assistant, and what to do next.' }));
    var d = state.data;
    if (d === null) { content.appendChild(h('div', { class: 'empty', text: 'Loading your phone intakes.' })); return; }
    var s = d.summary;
    content.appendChild(h('ul', { class: 'tiles', 'aria-label': 'Totals' }, [
      tile(LABELS.intakesToday, s.intakesReceivedToday, false), tile(LABELS.needFollowUp, s.needFollowUp, s.needFollowUp > 0),
      tile(LABELS.withRequestedTime, s.withRequestedTime, false), tile(LABELS.confirmedByCaller, s.confirmedByCaller, false)
    ]));
    content.appendChild(h('p', { class: 'muted', text: LABELS.intakesTotal + ': ' + s.intakesReceivedTotal }));
    if (!state.chosen || state.tab === null) { state.tab = s.needFollowUp > 0 ? 'follow' : 'all'; }

    var tabFollow = h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': state.tab === 'follow' ? 'true' : 'false', text: 'Needs follow-up (' + s.needFollowUp + ')' });
    var tabAll = h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': state.tab === 'all' ? 'true' : 'false', text: 'All intakes (' + s.intakesReceivedTotal + ')' });
    var pick = function (name) {
      state.chosen = true; state.tab = name; state.limit = PAGE; renderList();
      live.textContent = name === 'follow' ? 'Showing intakes that need follow-up' : 'Showing all intakes';
    };
    tabFollow.addEventListener('click', function () { pick('follow'); });
    tabAll.addEventListener('click', function () { pick('all'); });
    content.appendChild(h('div', { class: 'list-head' }, [
      h('h2', { text: 'Customer requests' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [tabFollow, tabAll])
    ]));

    var calls = d.calls;
    var indexes = [];
    calls.forEach(function (c, i) { if (state.tab === 'all' || c.needsFollowUp) { indexes.push(i); } });
    if (indexes.length === 0) {
      content.appendChild(h('p', { class: 'empty', text: calls.length === 0 ? 'No phone intakes yet. This page updates by itself after a call.' : 'Nothing needs follow-up.' }));
      return;
    }
    content.appendChild(h('ul', { class: 'cards' }, indexes.slice(0, state.limit).map(function (i) { return listCard(calls, i); })));
    if (indexes.length > state.limit) {
      content.appendChild(h('p', { class: 'more-row' }, [h('button', {
        class: 'btn', type: 'button', text: 'Show more (' + (indexes.length - state.limit) + ' more)',
        onclick: function () { state.limit += PAGE; renderList(); }
      })]));
    }
  }

  /* ---------- one intake ---------- */
  function section(title, kids) {
    return h('section', { class: 'panel' }, [h('h2', { class: 'panel-title', text: title })].concat(kids));
  }
  function renderDetail(key) {
    state.route = 'detail';
    clear(content);
    var call = findByKey(key);
    var back = h('p', { class: 'crumb' }, [h('a', { href: '#/', text: '← All intakes' })]);
    if (call === null) {
      setTitle('Intake not found');
      content.appendChild(back);
      content.appendChild(h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: 'Intake not found' }));
      content.appendChild(h('p', { class: 'empty', text: state.data === null ? 'Loading your phone intakes.' : "This intake isn't available any more." }));
      return;
    }
    setTitle(call.request);
    content.appendChild(back);
    content.appendChild(h('div', { class: 'detail-head' }, [
      h('div', {}, [
        h('h1', { class: 'display', id: 'page-title', tabindex: '-1', text: call.request }),
        h('p', { class: 'when' }, [h('time', { datetime: call.at, text: when(call.at, true) })])
      ]),
      chip(call)
    ]));
    var panels = [
      section('What the caller needs', [h('p', { text: call.summary === null ? 'No request details were captured.' : call.summary })]),
      section(LABELS.requestedTime, [h('p', { text: call.requestedTime === null ? 'None given' : call.requestedTime })])
    ];
    if (call.details.length > 0) {
      panels.push(section('Other details', [h('dl', { class: 'facts' }, call.details.map(function (d) { return fact(d.label, d.value); }))]));
    }
    if (call.addressGiven) {
      /* The owner view puts an 'Address' detail on a call only when the caller confirmed the address on the phone. */
      var addressConfirmed = call.details.some(function (d) { return d.label === 'Address'; });
      panels.push(section('Address', [h('p', { text: addressConfirmed
        ? 'An address was given and the caller confirmed it on the phone. It is not shown here. It was not checked against any address data.'
        : 'An address was given but it is not confirmed. It is not shown here. A person needs to check it with the caller.' })]));
    }
    panels.push(section('Next steps', [actions(call.nextActions)]));
    content.appendChild(h('div', { class: 'panels' }, panels));
  }

  /* ---------- router ---------- */
  function render() {
    var key = currentKey();
    var wasDetail = state.route === 'detail';
    if (key !== null) { renderDetail(key); } else { renderList(); }
    var title = document.getElementById('page-title');
    if (title) { title.focus({ preventScroll: true }); }
    if (key === null && wasDetail) { window.scrollTo(0, state.scrollY); } else if (key !== null) { window.scrollTo(0, 0); }
  }

  function showBanner(text) { banner.hidden = text === null; banner.textContent = text === null ? '' : text; }

  function queueRefresh() {
    if (state.timer !== null) { window.clearTimeout(state.timer); }
    state.timer = window.setTimeout(function () {
      state.timer = null;
      if (document.hidden) { queueRefresh(); } else { refresh(); }
    }, REFRESH_MS);
  }

  function refresh() {
    if (state.busy || typeof window.fetch !== 'function') { return Promise.resolve(); }
    state.busy = true;
    return window.fetch('/api/owner', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) { throw new Error('status'); } return res.json(); })
      .then(function (data) {
        if (!validShape(data)) { throw new Error('shape'); }
        state.data = data;
        showBanner(null);
        updated.textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        render();
      })
      .catch(function () {
        if (window.PROTO_SAMPLE === true) { return; }
        showBanner(state.data === null ? "Can't load your phone intakes yet. Trying again shortly." : "Can't reach the phone dashboard. Showing the last information; trying again shortly.");
        if (state.data === null) { updated.textContent = 'Not loaded'; }
      })
      .then(function () { state.busy = false; queueRefresh(); });
  }

  /* ---------- start ---------- */
  if (validShape(window.PROTO_DATA)) { state.data = window.PROTO_DATA; }
  if (window.PROTO_SAMPLE === true) { showBanner('These are sample intakes, not real calls.'); }
  refreshBtn.addEventListener('click', function () { refresh(); });
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); } });
  render();
  refresh();
})();
