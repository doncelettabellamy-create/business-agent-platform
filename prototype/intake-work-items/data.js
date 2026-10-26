/* SAMPLE data for opening this folder on its own. Every call and count below is invented; none of it is a real call or a real person.
   The live dashboard never serves this file: it generates /data.js from the saved records. The shape is the owner view's allow-list
   (src/owner-view.ts), nothing more. */
window.PROTO_SAMPLE = true;
window.PROTO_DATA = {
  calls: [
    {
      at: '2026-10-26T20:09:21Z', request: 'Emergency leak', summary: 'burst pipe in the kitchen', requestedTime: 'tomorrow morning', details: [],
      statusText: 'Not confirmed by the caller', needsFollowUp: true,
      nextActions: ['Follow up: the caller did not confirm the details.', 'Verify the address with the caller.'], addressGiven: true
    },
    {
      at: '2026-10-26T18:30:00Z', request: 'Quote request', summary: 'repaint two bedrooms', requestedTime: 'next Tuesday afternoon',
      details: [{ label: 'Number of rooms', value: 'two' }],
      statusText: 'Confirmed by the caller', needsFollowUp: true, nextActions: ['Verify the address with the caller.'], addressGiven: true
    },
    {
      at: '2026-10-25T16:05:00Z', request: 'Quote request', summary: 'replace a tap', requestedTime: null, details: [],
      statusText: 'Confirmed by the caller', needsFollowUp: false, nextActions: ['Ready for follow-up.'], addressGiven: false
    },
    {
      at: '2026-10-24T09:12:00Z', request: 'Not recognised yet', summary: 'cleaning service for four rooms', requestedTime: '9 AM to 1 PM', details: [],
      statusText: 'Not confirmed by the caller', needsFollowUp: true,
      nextActions: ['Follow up: the caller did not confirm the details.', 'Decide what kind of request this is.'], addressGiven: false
    }
  ],
  summary: { intakesReceivedToday: 2, intakesReceivedTotal: 4, needFollowUp: 3, withRequestedTime: 3, confirmedByCaller: 2 }
};
