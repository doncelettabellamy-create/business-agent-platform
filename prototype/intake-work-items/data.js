/* Synthetic, masked prototype data. No real people, no real messages, no network calls.
   All names, tokens, ids, and timestamps are invented for visual review only.
   Categories and field names are generic placeholders (vertical is TBD, D-01). */
(function () {
  'use strict';

  var STEP_NAMES = [
    'Verified request',
    'Checked for duplicates',
    'Found personal data',
    'Hid personal data and stored it safely',
    'Classified',
    'Extracted fields',
    'Validated',
    'Saved and handed off'
  ];

  var REASONS = {
    missing_fields: 'Some required fields were not found in the message.',
    low_confidence: 'The system was not confident enough in the result.',
    detector_offline: 'The personal-data check was unavailable, so the message was not sent to the model.',
    schema_invalid: 'The result did not match the expected format after the allowed retries.',
    unknown_category: 'The request did not match any configured category.',
    token_cap: 'The run reached its safety limit before finishing.'
  };

  var VERSIONS = { skill: 'v0.0.0-draft', model: 'model-id (TBD)', prompt: 'p0 (draft)' };

  /* steps helper: status per step name index */
  function steps(statuses, retries) {
    var ms = [42, 8, 310, 95, 880, 920, 14, 31];
    return STEP_NAMES.map(function (name, i) {
      var s = statuses[i] || 'skipped';
      return {
        name: name,
        status: s,
        ms: s === 'skipped' ? null : ms[i],
        note: retries && retries[i] ? 'Retried ' + retries[i] + (retries[i] === 1 ? ' time' : ' times') : ''
      };
    });
  }
  var ALL_DONE = ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done'];
  var UNTIL_PII_FAIL = ['done', 'done', 'failed'];
  var PARKED_AFTER_VALIDATE = ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done'];

  var MSG = {
    a: 'Hello, this is [PERSON_1]. I would like to follow up on my earlier request. Please contact me at [CONTACT_1] when you can. Reference: [ID_1].',
    b: 'Hi, [PERSON_1] here. I need to change the details of my request. The new date is not decided yet. My number is [CONTACT_1].',
    c: '[PERSON_1] writing on behalf of [PERSON_2]. We would like a quote for option B. Please reply to [CONTACT_1].',
    d: 'Question about my account [ID_1]. Could someone call me on [CONTACT_1] today?',
    e: 'Thanks!',
    f: 'Please cancel the request I sent yesterday. It was sent by [PERSON_1], reference [ID_1].',
    g: 'Hello, I am [PERSON_1]. I want to add one more item to my request and I will confirm the quantity later. Contact: [CONTACT_1].'
  };

  function pii(list) { return list; }

  var items = [
    { id: 'wi-0014', status: 'needs-human', category: null, received: '2026-10-24 09:47', confidence: null,
      reasons: ['detector_offline'], message: null, pii: [],
      fields: [], steps: steps(UNTIL_PII_FAIL), handedOff: false, messageHidden: 'The message is held back while the personal-data check is unavailable.' },
    { id: 'wi-0013', status: 'needs-human', category: 'Category B', received: '2026-10-24 09:31', confidence: 0.58,
      reasons: ['missing_fields', 'low_confidence'], message: MSG.c, pii: pii([{ type: 'Person', count: 2 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: '[PERSON_2]', conf: 0.71, found: true },
        { name: 'Field 2', value: 'Option B', conf: 0.66, found: true },
        { name: 'Field 3', value: null, conf: null, found: false },
        { name: 'Field 4', value: null, conf: null, found: false }
      ], steps: steps(ALL_DONE, { 5: 1 }), handedOff: false },
    { id: 'wi-0012', status: 'needs-human', category: null, received: '2026-10-24 09:12', confidence: null,
      reasons: ['unknown_category'], message: MSG.e, pii: [],
      fields: [], steps: steps(ALL_DONE), handedOff: false },
    { id: 'wi-0011', status: 'needs-human', category: 'Category A', received: '2026-10-24 08:55', confidence: 0.62,
      reasons: ['schema_invalid'], message: MSG.g, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Add item', conf: 0.62, found: true },
        { name: 'Field 2', value: null, conf: null, found: false }
      ], steps: steps(['done', 'done', 'done', 'done', 'done', 'failed'], { 5: 2 }), handedOff: false },
    { id: 'wi-0010', status: 'ready', category: 'Category A', received: '2026-10-24 08:40', confidence: 0.93,
      reasons: [], message: MSG.a, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }, { type: 'Identifier', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Follow-up', conf: 0.95, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.97, found: true },
        { name: 'Field 3', value: 'Earlier request', conf: 0.88, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0009', status: 'ready', category: 'Category B', received: '2026-10-24 08:22', confidence: 0.89,
      reasons: [], message: MSG.b, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Change details', conf: 0.9, found: true },
        { name: 'Field 2', value: 'Not decided', conf: 0.82, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0008', status: 'ready', category: 'Category C', received: '2026-10-24 08:05', confidence: 0.91,
      reasons: [], message: MSG.d, pii: pii([{ type: 'Identifier', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Call back', conf: 0.93, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.96, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0007', status: 'ready', category: 'Category A', received: '2026-10-23 17:48', confidence: 0.95,
      reasons: [], message: MSG.f, pii: pii([{ type: 'Person', count: 1 }, { type: 'Identifier', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Cancel', conf: 0.97, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.96, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0006', status: 'ready', category: 'Category B', received: '2026-10-23 16:30', confidence: 0.87,
      reasons: [], message: MSG.c, pii: pii([{ type: 'Person', count: 2 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: '[PERSON_2]', conf: 0.9, found: true },
        { name: 'Field 2', value: 'Option B', conf: 0.88, found: true },
        { name: 'Field 3', value: 'Quote', conf: 0.84, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0005', status: 'ready', category: 'Category A', received: '2026-10-23 15:12', confidence: 0.92,
      reasons: [], message: MSG.a, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }, { type: 'Identifier', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Follow-up', conf: 0.93, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.95, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0004', status: 'ready', category: 'Category C', received: '2026-10-23 14:02', confidence: 0.9,
      reasons: [], message: MSG.d, pii: pii([{ type: 'Identifier', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Call back', conf: 0.92, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.94, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0003', status: 'ready', category: 'Category B', received: '2026-10-23 11:44', confidence: 0.86,
      reasons: [], message: MSG.b, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Change details', conf: 0.88, found: true },
        { name: 'Field 2', value: 'Not decided', conf: 0.8, found: true }
      ], steps: steps(ALL_DONE, { 4: 1 }), handedOff: true },
    { id: 'wi-0002', status: 'ready', category: 'Category A', received: '2026-10-23 10:20', confidence: 0.94,
      reasons: [], message: MSG.g, pii: pii([{ type: 'Person', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Add item', conf: 0.95, found: true },
        { name: 'Field 2', value: 'Quantity later', conf: 0.85, found: true }
      ], steps: steps(ALL_DONE), handedOff: true },
    { id: 'wi-0001', status: 'ready', category: 'Category C', received: '2026-10-23 09:03', confidence: 0.9,
      reasons: [], message: MSG.d, pii: pii([{ type: 'Identifier', count: 1 }, { type: 'Contact detail', count: 1 }]),
      fields: [
        { name: 'Field 1', value: 'Call back', conf: 0.91, found: true },
        { name: 'Field 2', value: '[ID_1]', conf: 0.93, found: true }
      ], steps: steps(ALL_DONE), handedOff: true }
  ];

  window.PROTO_DATA = {
    items: items,
    reasons: REASONS,
    versions: VERSIONS,
    channelLabel: 'Channel (to be decided)',
    rejectedToday: 2
  };
})();
