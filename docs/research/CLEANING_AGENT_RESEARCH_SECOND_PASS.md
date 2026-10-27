# Cleaning-agent research note, second pass (ideas; see the status update below for what is now implemented in code)

**Status update 2026-10-26.** Since this note was written, the following moved from proposed to **implemented in code and tests (uncommitted, not live, never heard on a call)**: the configurable opening (business and agent introduction, disclosure, an optional business-approved special), the standard, deep and move-in/move-out question sets (`examples/skill-cleaning-services.json`), preservation of the sealed Intake handoff in memory, the address-unverified rule for stored contacts, and numeric-only call diagnostics. **Everything else in this note remains proposed and unapproved** (property detail fields beyond rooms, frequency for the live skill, access method, pricing, booking, human-fallback triggers, text confirmations). The silent-response blocker is **unresolved** (a second call ended shortly after a question; no call has been made with the diagnostics) and the Processing handoff is **not wired**. The dashboard decision and the founder's approval rules are unchanged. Full figures: `docs/DEVELOPMENT_ROADMAP.md` section 5.

Recorded 2026-10-26. Documentation only. Companion to `docs/research/CLEANING_INTAKE_RESEARCH.md`. Everything under "ideas" is **proposed**: none is implemented, none is founder-approved, and none changes the existing dashboard (preserved and evolved, `docs/DEVELOPMENT_ROADMAP.md` section 1a). Any use is a separate task under section 1b, in simulation first (section 3a).

## 1. Sources (read 2026-10-26; summarised in my own words by a fetch tool, so wording is approximate)

| Source | Kind |
|---|---|
| https://github.com/andriidrok1/open-receptionist/blob/main/server/businesses/cleaning.yaml | An example business configuration file for a cleaning service (a demo business, prices in a foreign currency). **No licence is stated, so nothing is copied** and only the structure of the ideas is noted. |
| https://sharrk.io/ai-receptionist-for-cleaning | A vendor marketing page. |
| https://www.broccoli.com/industries/residential-cleaning | A vendor marketing page. |

**Source claims versus verified behaviour.** Every statement in section 2 is what a source says or shows. None was tested: I did not run, call or inspect any of these products, and vendor pages are marketing, not evidence of accuracy, safety or compliance. The only **verified** behaviour is our own, listed in section 4.

## 2. What the sources say

**Service-specific questions** (claims)
- *Configuration file:* size of the home by room count (it decides the service), preferred day and time, the full address (required), optional access details (entry code, floor, parking). A recap template also includes the caller's name.
- *Sharrk:* the kind of clean; bedrooms, bathrooms, square footage, pets, add-ons. Move-out: move date, whether the home will be empty, add-ons such as oven, fridge, cabinets. Recurring: home details, pets, preferred day, frequency (weekly, bi-weekly, monthly). Deep clean: when it was last professionally cleaned and which rooms matter most. Commercial: square footage, frequency, building access. Short-term rentals: address, checkout times, access notes.
- *Broccoli:* home size, frequency, priorities, pets, access, preferred timing. Move-in and move-out: deadline, square footage, condition, access. Deep clean: rooms, special requests, timing.

**Configurable business rules**
- *Configuration file* (the most concrete): per-service price by room count with a duration, working hours by weekday and a closed day, slot length and how far ahead booking is allowed, how many crews can work at once, a service area, a discount for regular clients, a payment method, and whether supplies are provided. Not present: minimum order, travel fee, buffers, cancellation policy, deposits.
- *Sharrk:* shares rates only "if you've set it"; answers recurring questions "from what you've taught it"; built "from your website". No rule details.
- *Broccoli:* "follows your process"; configuration is not described.

**Quote versus walkthrough**
- *Configuration file:* standard jobs have fixed prices and there is **no quote workflow**; the price of one service (windows) is deferred to the crew on site; requests outside the list go to a person.
- *Sharrk:* residential: books "the first clean or walkthrough"; commercial: books a walkthrough or transfers to staff. Standard-clean pricing is not given.
- *Broccoli:* when asked for a price the sample assistant collects details for the team to follow up and gives no figure. Walkthroughs are not mentioned.

**Booking and confirmation**
- *Configuration file:* slot-based booking, reads back service, day, time, name, address and total before confirming, and issues a reference.
- *Sharrk:* checks open times and books into a calendar tool; texts a confirmation; claims guided texting registration, stop handling and quiet hours. Its own example call contains a day inconsistency.
- *Broccoli:* "books jobs"; calendar, confirmations and rules are not described.

**Human handoff**
- *Configuration file:* a fixed list of out-of-scope requests (offices, post-renovation, upholstery, crew complaints, windows) goes to a person.
- *Sharrk:* a caller who asks for a person is transferred live with the captured details; other criteria are not stated.
- *Broccoli:* not described.

**Not stated by any of the three:** a greeting or disclosure that the caller is speaking to an AI (Sharrk's compliance answer is missing), accuracy or error rates, how access details are protected.

### Founder requirement for the opening (see `docs/DEVELOPMENT_ROADMAP.md` section 2a)

**Founder requirement (stated 2026-10-26; implemented in code and tests the same day; NOT live).** Every call opens by (1) introducing the **configured business** and the **agent** by name, (2) giving the **disclosure** (that the caller is speaking with an AI assistant, and the recording notice the business needs), and (3) mentioning a **special or promotion only if that business has approved one**, as exact approved text. The business name, agent name, disclosure wording and any special are per-business configuration, never invented or reworded by the model, and a special never carries a price or a commitment. In code all three are now configurable through an optional `opening` block; the live config has none, so live calls still use the original notice (`docs/PRODUCT_CONTINUITY.md` section 4, stage 2). Neither the configuration file nor the Sharrk page states an AI disclosure or a business introduction, and the file has no promotion setting, so this requirement is ours and is not taken from them.

## 3. Proposed ideas for us (none approved)

1. **Service-specific question sets**, selected by service type: standard/recurring (size, frequency, pets), deep (last professional clean, priority rooms), move-in/move-out (date, empty or not, add-ons), plus a quote-only route. Each set is configuration (section 2 of the roadmap says services are per business), not code.
2. **A business rules block** in the configuration, for the simulated quote and calendar: working hours, slot length, advance limit, crew capacity, service area, minimum job, buffer, supplies and payment text. All values come from the business; none is invented by the assistant.
3. **Quote versus walkthrough as a per-service choice:** fixed price from an approved table, estimate range, or a walkthrough/visit booking, with a person pricing anything outside the table. This extends the roadmap's quote-versus-estimate policy with a "walkthrough" outcome (and for commercial or unusual jobs, a person).
4. **Booking idea:** read the whole job back (service, day and time, address area, price) and take an explicit yes before writing a slot, then verify the booking by reading it back from the calendar (roadmap section 3a). A reference number on the confirmation is a later idea.
5. **Fixed out-of-scope list** that always goes to a person, and what the caller hears is fixed text that promises nothing until a callback process exists.
6. **Text confirmations and reminders** only with the caller's explicit consent and the rules for texting (registration, stop handling, quiet hours) decided first; a founder decision, after the open blockers.

## 4. Verified behaviour in our own system (for contrast; nothing from the sources is verified)

- One cleaning call was confirmed and saved (rooms, date and time window captured; local, 6:50 PM). Contact capture was not yet in that server.
- The intake asks one named field at a time, chosen by code, from a skill with one category and four fields. There is no service type, frequency, property detail beyond rooms, access, price, calendar or booking.
- Contact capture (name, callback number, address; encrypted, 30-day retention) is built and ON in the running server but has never been exercised on a live call.

## 5. Open blockers (unresolved; they gate everything above)

1. **Silent response.** In the 8:40 PM cleaning call, after the second question (rooms answered, date and time window still missing), no further caller speech reached the server for about 30 seconds and the connection closed; the call was saved unconfirmed. Unknown: whether the question had words, was sent or was played; whether the caller spoke; who closed the connection; the time to the first word. Nothing from this note counts as validated on a live call until this is diagnosed. The smallest proposed evidence step (not approved) is in `CLEANING_INTAKE_RESEARCH.md` section 0.
2. **Agent handoff is not wired.** The phone path ends at a saved record. The sealed Intake handoff is kept in memory and offered to an optional `confirmedHandoff` seam in the handler, but the server does not pass that seam; the pipeline starts only at Intake and has no entry for an existing handoff; `eligibleForProcessing` has no consumer in the source; and the seal is in-process only, so it cannot survive a restart or a wait for address verification. Until a founder-approved bridge exists, no quote, calendar or booking idea here can run on a real call (`DEVELOPMENT_ROADMAP.md` section 3).

## 6. Decisions needed (none taken)
Service types and question sets; which business rules to configure and their values; the quote, estimate and walkthrough policy per service; the out-of-scope list; text-confirmation consent; and when to start, which is gated by the two blockers above.
