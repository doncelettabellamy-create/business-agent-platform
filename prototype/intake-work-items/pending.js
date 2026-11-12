/* "Bookings needing a person": a small panel above the intakes. It shows the booking references Drew could not finish (the reference is in the Jobber job's title), nothing else.
   It is hidden when nothing needs a person, and it says so plainly when Drew could not check. Everything is written as text, never as HTML. The only network call is GET /api/pending. */
(function () {
  'use strict';

  var REFRESH_MS = 15000;
  var REF = /^DREWTEST-[0-9A-F]{12}$/;
  var panel = document.getElementById('pending');
  var seen = false, busy = false, timer = null;
  if (!panel) { return; }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) { return; }
      if (k === 'class') { node.className = v; } else if (k === 'text') { node.textContent = v; } else { node.setAttribute(k, v === true ? '' : v); }
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined) { node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return node;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  /* The shape the server sends. Anything else is treated as "could not check", never as "nothing needs a person". */
  function validShape(d) {
    if (!d || (d.status !== 'none' && d.status !== 'some' && d.status !== 'unknown') || !Array.isArray(d.items)) { return false; }
    if (d.asOf !== null && typeof d.asOf !== 'string') { return false; }
    return d.items.every(function (i) { return i && typeof i.ref === 'string' && REF.test(i.ref) && (i.state === 'pending' || i.state === 'client_created'); });
  }
  var STATE = { pending: 'started; Jobber has not confirmed the outcome', client_created: 'the customer was created in Jobber; the visit is not confirmed' };

  function hide() { clear(panel); panel.hidden = true; }
  function show(d) {
    clear(panel); panel.hidden = false;
    panel.appendChild(h('h2', { class: 'panel-title', text: 'Bookings needing a person' }));
    if (d.status === 'unknown') {
      panel.appendChild(h('p', { text: 'Drew could not check whether any bookings need a person. Please look in Jobber, and ask the person who runs Drew to check.' }));
      return;
    }
    panel.appendChild(h('p', { text: 'Drew could not finish these bookings. Search for the reference in Jobber, then check with the caller before anything is booked again.' }));
    if (d.items.length === 0) {
      panel.appendChild(h('p', { text: 'Some earlier bookings need a person but cannot be listed here. Please ask the person who runs Drew to check.' }));
      return;
    }
    panel.appendChild(h('ul', { class: 'steps' }, d.items.map(function (i) { return h('li', { text: i.ref + ': ' + STATE[i.state] }); })));
    if (d.asOf !== null) {
      var t = new Date(d.asOf);
      if (!isNaN(t.getTime())) { panel.appendChild(h('p', { class: 'muted', text: 'Last checked ' + t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.' })); }
    }
  }

  function queue() {
    if (timer !== null) { window.clearTimeout(timer); }
    timer = window.setTimeout(function () { timer = null; if (document.hidden) { queue(); } else { refresh(); } }, REFRESH_MS);
  }

  function refresh() {
    if (busy || typeof window.fetch !== 'function') { return Promise.resolve(); }
    busy = true;
    return window.fetch('/api/pending', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 404) { seen = false; hide(); return null; }   /* this server has no such panel: show nothing */
        if (!res.ok) { throw new Error('status'); }
        return res.json();
      })
      .then(function (data) {
        if (data === null) { return; }
        if (!validShape(data)) { throw new Error('shape'); }
        seen = true;
        if (data.status === 'none') { hide(); } else { show(data); }
      })
      .catch(function () {
        /* Once the panel has worked, a failure to reach the server is "could not check", never "nothing needs a person". */
        if (seen) { show({ status: 'unknown', asOf: null, items: [] }); }
      })
      .then(function () { busy = false; queue(); });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); } });
  refresh();
})();
