// Deterministic answer parsers for the fast Drew test call (proof of concept; fast-call-handler.ts). PURE: no I/O, no model, no randomness; the clock and the time zone are passed in.
// Each parser reads ONE short answer to ONE short question and says only what it understood: a missing part is returned as missing and asked about, never guessed. Nothing here sees a name, a street or a
// phone number (those use call-state.ts). The caller's words are not logged by anything in this file.

export type YesNo = 'yes' | 'no' | 'unclear';
const NO = /\b(?:no|nope|nah|negative|not|don'?t|do not|wrong|incorrect|cancel|never ?mind|stop|hang up)\b/;
const YES = /\b(?:yes|yeah|yep|yup|yea|sure|correct|right|ok|okay|absolutely|definitely|affirmative|please do|go ahead|sounds good|that works|that is fine|that'?s fine|do it|book it|uh huh|mm hmm)\b/;
/** A yes, a no, or unclear. Whichever of the two comes FIRST in the line wins ("no, that's not right" is a no, "yes that's right" is a yes); both absent is unclear. */
export function yesNo(raw: unknown): YesNo {
  if (typeof raw !== 'string' || raw.length > 300) return 'unclear';
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const n = NO.exec(t); const y = YES.exec(t);
  if (n === null && y === null) return 'unclear';
  if (n !== null && (y === null || n.index < y.index)) return 'no';
  return 'yes';
}

// ---------------------------------------------------------------- "are you an A I?"
const WHAT = '(?:real|actual|live)?\\s*(?:person|human|human being|robot|bot|a i|ai|artificial|machine|computer|automated|recording|recorded|someone real)';
const AI_Q = [
  new RegExp(`\\b(?:are|r)\\s+(?:you|u)\\s+(?:(?:a|an|actually|really|just|even)\\s+)*${WHAT}\\b`),
  new RegExp(`\\b(?:is|was)\\s+(?:this|that)\\s+(?:a|an|really|actually)?\\s*${WHAT}\\b`),
  new RegExp(`\\b(?:am|do)\\s+i\\s+(?:talking|speaking|chatting|dealing)\\s+(?:to|with)\\s+(?:a|an|the)?\\s*${WHAT}\\b`),
  /\b(?:are|r)\s+(?:you|u)\s+(?:real|human|alive)\b/,
  /\b(?:is|am)\s+(?:this|i)\s+(?:a\s+)?(?:real|live)\s+(?:person|human)\b/,
  /\bwho(?:'s| is| am i)\s+(?:this|talking|speaking)\b.*\b(?:person|human|robot|bot|ai|a i|machine)\b/,
  /\b(?:you|this)\s+(?:sound|sounds)\s+like\s+(?:a\s+)?(?:robot|bot|machine|computer|recording)\b.*\?/,
  /\b(?:talk|speak)\s+to\s+(?:a|an|the)?\s*(?:real|live)\s+(?:person|human)\b/,
];
/** Whether the caller is asking if they are talking to a machine (are you a robot, is this an A I, am I talking to a real person ...). The call then answers truthfully before anything else, at any step. */
export function isAiQuestion(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 300) return false;
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ?]+/g, ' ').replace(/\s+/g, ' ').trim();
  return AI_Q.some((re) => re.test(t));
}

// ---------------------------------------------------------------- counts
const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, to: 2, too: 2, for: 4, tree: 3 };
const NUMTOK = '(?:\\d+(?:\\.5)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
/** The same, plus the words a voice recognizer writes for two, three and four ("to", "too", "tree", "for"). They count ONLY right before a bedroom or bathroom word, or as the whole of a one-number answer: anywhere else they are ordinary words. */
const NUMTOK_NEAR = '(?:\\d+(?:\\.5)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|to|too|tree|for)';
function num(tok: string): number | undefined { const t = tok.toLowerCase(); if (/^\d+(?:\.5)?$/.test(t)) return Number(t); return Object.hasOwn(WORDS, t) ? WORDS[t] : undefined; }
const squash = (raw: string): string => raw.toLowerCase().replace(/[’]/g, "'").replace(/\b(\w+)\s+and\s+a\s+half\b/g, '$1.5').replace(/\b(\w+)\s+point\s+five\b/g, '$1.5').replace(/[^a-z0-9.' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const toNum = (s: string): string => s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\.5\b/g, (_m, w: string) => `${WORDS[w]}.5`);
export interface Size { beds?: number; baths?: number }
/** The bedrooms and bathrooms in an answer ("two bedrooms and two bathrooms", "2 bed 2 bath", "three and a half baths", or just "two and two"). Whatever is not said is left out. A studio is zero bedrooms. */
export function sizeFrom(raw: unknown): Size {
  if (typeof raw !== 'string' || raw.length > 300) return {};
  const t = toNum(squash(raw)); const out: Size = {};
  const bed = new RegExp(`\\b(${NUMTOK_NEAR})\\s*(?:-\\s*)?(?:bed(?:room)?s?|br)\\b`).exec(t); const bath = new RegExp(`\\b(${NUMTOK_NEAR})\\s*(?:-\\s*)?(?:bath(?:room)?s?|ba)\\b`).exec(t);
  if (bed !== null) { const v = num(bed[1]); if (v !== undefined && Number.isInteger(v) && v >= 0 && v <= 12) out.beds = v; }
  if (bath !== null) { const v = num(bath[1]); if (v !== undefined && v >= 0.5 && v <= 12) out.baths = v; }
  if (/\bstudio\b/.test(t) && out.beds === undefined) out.beds = 0;
  if (out.beds === undefined && out.baths === undefined) {
    const nums = [...t.matchAll(new RegExp(`\\b${NUMTOK}\\b`, 'g'))].map((m) => num(m[0])).filter((v): v is number => v !== undefined);
    if (nums.length === 2 && !/\b(?:bed|bath|room)/.test(t)) { if (Number.isInteger(nums[0]) && nums[0] >= 0 && nums[0] <= 12) out.beds = nums[0]; if (nums[1] >= 0.5 && nums[1] <= 12) out.baths = nums[1]; }
  }
  return out;
}
/** One bare count said to a question about ONE of them ("two", "2", "one and a half"). Undefined when no single number is said. */
export function countFrom(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length > 120) return undefined;
  const nums = [...toNum(squash(raw)).matchAll(new RegExp(`\\b${NUMTOK}\\b`, 'g'))].map((m) => num(m[0])).filter((v): v is number => v !== undefined);
  if (nums.length === 0) { const lone = /^(?:(?:um+|uh+|just|only|maybe|about)\s+)*(to|too|tree|for)\.?$/.exec(squash(raw)); if (lone !== null) return WORDS[lone[1]]; }   // the whole answer is the recognizer's "to", "too" or "for": two, two, four
  return nums.length === 1 && nums[0] >= 0 && nums[0] <= 12 ? nums[0] : undefined;
}
/** What an answer to the size question looks like, as flags and a count only (never a word or a number): for the diagnostics, so a failed size answer can be told apart from a missing one. */
export function sizeShape(raw: unknown): { bedWord: boolean; bathWord: boolean; numberWords: number; homophone: boolean } {
  if (typeof raw !== 'string' || raw.length > 300) return { bedWord: false, bathWord: false, numberWords: 0, homophone: false };
  const t = toNum(squash(raw));
  return { bedWord: /\b(?:bed(?:room)?s?|br)\b/.test(t), bathWord: /\b(?:bath(?:room)?s?|ba)\b/.test(t), numberWords: [...t.matchAll(new RegExp(`\\b${NUMTOK}\\b`, 'g'))].length, homophone: /\b(?:to|too|tree|for)\b/.test(t) };
}

// ---------------------------------------------------------------- time zones
export interface Zoned { y: number; m: number; d: number; weekday: number; hour: number; minute: number }
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** The calendar date, weekday (0 = Sunday) and clock time of an instant in a time zone (an IANA name such as America/Chicago). */
export function zonedParts(ms: number, tz: string): Zoned {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: WD.indexOf(String(p.weekday).toLowerCase().slice(0, 3)), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
/** The zone's UTC offset at an instant, as +HH:MM or -HH:MM. */
export function utcOffsetFor(ms: number, tz: string): string {
  const z = zonedParts(ms, tz); const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hour, z.minute); const min = Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
  const a = Math.abs(min); return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export const pad2 = (n: number): string => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
/** A calendar date plus a number of days (pure calendar arithmetic). */
export function addDays(date: string, n: number): string { const t = new Date(`${date}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
export const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The instant of a local date and clock time ("2026-11-10", "09:30") in a zone. */
export function instantOf(date: string, hm: string, tz: string): number { return Date.parse(`${date}T${hm}:00${utcOffsetFor(Date.parse(`${date}T12:00:00Z`), tz)}`); }

// ---------------------------------------------------------------- day and time
export interface When { date?: string; time?: string; part?: 'morning' | 'afternoon' | 'evening'; flexible?: boolean; /** A month and day that has already passed this year was named: no date is chosen, the caller is asked. */ past?: true }
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty first': 21, 'twenty second': 22, 'twenty third': 23, 'twenty fourth': 24, 'twenty fifth': 25, 'twenty sixth': 26, 'twenty seventh': 27, 'twenty eighth': 28, 'twenty ninth': 29, thirtieth: 30, 'thirty first': 31 };
const ORD_RE = Object.keys(ORD).sort((a, b) => b.length - a.length).join('|');
const MONTH_RE = `(?:${MONTHS.join('|')}|${Object.keys(MONTH_ABBR).join('|')})`;
const monthNo = (w: string): number => { const i = MONTHS.indexOf(w); return i >= 0 ? i + 1 : MONTH_ABBR[w]; };
const TIME_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** The day and/or time an answer names, relative to `nowMs` in `tz`. A weekday is its next occurrence after today; every reading is spoken back with the full date, so a wrong one is corrected there. */
export function whenFrom(raw: unknown, nowMs: number, tz: string): When {
  if (typeof raw !== 'string' || raw.length > 300) return {};
  let t = raw.toLowerCase().replace(/[’]/g, "'").replace(/\./g, '').replace(/[^a-z0-9:/' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  const today = zonedParts(nowMs, tz); const todayIso = isoDate(today.y, today.m, today.d); const out: When = {};
  const takeOut = (m: RegExpExecArray): void => { t = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim(); };
  // A month and day is read in THIS year, or in the four-digit year the caller said. One that has already passed is never moved to next year: it is flagged, and the caller is asked which day they mean.
  const yearSaid = /\b(20\d\d)\b/.exec(t); const yr = yearSaid === null ? undefined : Number(yearSaid[1]);
  const place = (mo: number, dayNo: number): void => {
    const d = isoDate(yr ?? today.y, mo, dayNo); if (new Date(`${d}T12:00:00Z`).getUTCMonth() + 1 !== mo) return;   // no such day (for example February 30)
    if (d < todayIso) out.past = true; else out.date = d;
  };
  // ---- the day
  let m: RegExpExecArray | null;
  if ((m = /\bday after tomorrow\b/.exec(t)) !== null) { out.date = addDays(todayIso, 2); takeOut(m); }
  else if ((m = /\btomorrow\b/.exec(t)) !== null) { out.date = addDays(todayIso, 1); takeOut(m); }
  else if ((m = /\b(?:today|tonight|this evening)\b/.exec(t)) !== null) { out.date = todayIso; if (/tonight|evening/.test(m[0])) out.part = 'evening'; takeOut(m); }
  else if ((m = new RegExp(`\\b(${MONTH_RE})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t)) !== null || (m = new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`).exec(t)) !== null) {
    const monthWord = MONTH_RE.length > 0 && isNaN(Number(m[1])) ? m[1] : m[2]; const dayNo = Number(isNaN(Number(m[1])) ? m[2] : m[1]);
    const mo = monthNo(monthWord); if (mo !== undefined && dayNo >= 1 && dayNo <= 31) { place(mo, dayNo); takeOut(m); }
  } else if ((m = new RegExp(`\\b(${MONTH_RE})\\s+(?:the\\s+)?(${ORD_RE})\\b`).exec(t)) !== null) {
    const mo = monthNo(m[1]); const dayNo = ORD[m[2]]; place(mo, dayNo); takeOut(m);
  } else if ((m = new RegExp(`\\b(?:the\\s+)?(${ORD_RE})\\s+of\\s+(${MONTH_RE})\\b`).exec(t)) !== null) {
    const mo = monthNo(m[2]); const dayNo = ORD[m[1]]; place(mo, dayNo); takeOut(m);
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t)) !== null) {
    const mo = Number(m[1]); const dayNo = Number(m[2]);
    if (mo >= 1 && mo <= 12 && dayNo >= 1 && dayNo <= 31) { place(mo, dayNo); takeOut(m); }
  } else if ((m = new RegExp(`\\b(?:this |next |on )?(${DAYS.join('|')}|${Object.keys(DAY_ABBR).join('|')})\\b`).exec(t)) !== null) {
    const wd = DAYS.indexOf(m[1]) >= 0 ? DAYS.indexOf(m[1]) : DAY_ABBR[m[1]]; let n = (wd - today.weekday + 7) % 7; if (n === 0) n = 7;
    out.date = addDays(todayIso, n); takeOut(m);
  } else if ((m = new RegExp(`\\b(?:the\\s+)?(${ORD_RE}|\\d{1,2}(?:st|nd|rd|th))\\b`).exec(t)) !== null) {
    const dayNo = ORD[m[1]] ?? Number(m[1].replace(/\D+/g, '')); if (dayNo >= 1 && dayNo <= 31) { place(today.m, dayNo); takeOut(m); }
  }
  // ---- the time
  if ((m = /\bnoon\b/.exec(t)) !== null) { out.time = '12:00'; takeOut(m); }
  else {
    const hourTok = `(\\d{1,2}|${Object.keys(TIME_NUM).join('|')})`;
    const mins = '(?::(\\d{2})|\\s+(thirty|fifteen|forty five|forty-five|o\'?clock|oh \\w+))?';
    const re = new RegExp(`\\b${hourTok}${mins}\\s*(am|pm|in the morning|in the afternoon|in the evening|at night)?\\b`);
    // a bare number counts as a time only after "at", "around", "about" or "by", or with am or pm, or with a minute part, so a date digit left over is never taken for an hour
    const mm = re.exec(t);
    if (mm !== null) {
      const hasMarker = mm[4] !== undefined; const hasMin = mm[2] !== undefined || mm[3] !== undefined; const before = t.slice(0, mm.index).trim().split(' ').pop() ?? '';
      if (hasMarker || hasMin || /^(?:at|around|about|by|from|after|before)$/.test(before)) {
        let h = /^\d+$/.test(mm[1]) ? Number(mm[1]) : TIME_NUM[mm[1]]; let mi = 0;
        if (mm[2] !== undefined) mi = Number(mm[2]); else if (mm[3] !== undefined) mi = /thirty/.test(mm[3]) ? 30 : /fifteen/.test(mm[3]) ? 15 : /forty/.test(mm[3]) ? 45 : 0;
        const ap = mm[4] ?? '';
        if (h >= 1 && h <= 12 && mi < 60) {
          if (/pm|afternoon|evening|night/.test(ap)) h = h === 12 ? 12 : h + 12; else if (/am|morning/.test(ap)) h = h === 12 ? 0 : h; else if (h >= 1 && h <= 6) h += 12; else if (h === 12) h = 12;
          out.time = `${pad2(h)}:${pad2(mi)}`; takeOut(mm);
        } else if (h >= 13 && h <= 23 && mi < 60) { out.time = `${pad2(h)}:${pad2(mi)}`; takeOut(mm); }
      }
    }
  }
  if (/\bmorning\b/.test(t)) out.part = 'morning'; else if (/\bafternoon\b/.test(t)) out.part = 'afternoon'; else if (/\bevening\b/.test(t) && out.part === undefined) out.part = 'evening';
  if (/\b(?:any ?time|whenever|anything|flexible|you pick|you choose|doesn'?t matter|no preference|earliest|first available|soonest)\b/.test(t)) out.flexible = true;
  return out;
}

// ---------------------------------------------------------------- speech
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty first', 'twenty second', 'twenty third', 'twenty fourth', 'twenty fifth', 'twenty sixth', 'twenty seventh', 'twenty eighth', 'twenty ninth', 'thirtieth', 'thirty first'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** A date as it is spoken: "Tuesday, November tenth". */
export function sayDay(date: string): string { const [, m, d] = date.split('-').map(Number); return `${cap(DAYS[weekdayOf(date)])}, ${cap(MONTHS[m - 1])} ${ORDINALS[d]}`; }
/** A date as it is spoken in an offer or a read-back, with the year: "Tuesday, November tenth, 2026". */
export function sayDayYear(date: string): string { return `${sayDay(date)}, ${date.slice(0, 4)}`; }
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_W = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function wordsUnder1000(n: number): string {
  const h = Math.floor(n / 100); const r = n % 100; const out: string[] = [];
  if (h > 0) out.push(`${ONES[h]} hundred`);
  if (r > 0) out.push(r < 20 ? ONES[r] : `${TENS_W[Math.floor(r / 10)]}${r % 10 === 0 ? '' : `-${ONES[r % 10]}`}`);
  return out.join(' ');
}
/** An amount of dollars as it is spoken, in words, so the voice never has to read a dollar sign and digits: 199 -> "one hundred ninety-nine dollars"; 1 -> "one dollar"; 199.5 -> "one hundred ninety-nine dollars and fifty cents". Whole amounts below one million; anything else is returned as plain digits followed by "dollars". */
export function sayDollars(amount: number): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount >= 1_000_000) return `${String(amount)} dollars`;
  const cents = Math.round(amount * 100) % 100; const whole = Math.floor(Math.round(amount * 100) / 100);
  const thousands = Math.floor(whole / 1000); const rest = whole % 1000;
  const words = whole === 0 ? 'zero' : [thousands > 0 ? `${wordsUnder1000(thousands)} thousand` : '', rest > 0 ? wordsUnder1000(rest) : ''].filter((s) => s !== '').join(' ');
  return `${words} ${whole === 1 ? 'dollar' : 'dollars'}${cents > 0 ? ` and ${wordsUnder1000(cents)} ${cents === 1 ? 'cent' : 'cents'}` : ''}`;
}
/** A clock time as it is spoken: "10 A M", "2 30 P M". */
export function sayTime(hm: string): string { const [h, mi] = hm.split(':').map(Number); const ap = h >= 12 ? 'P M' : 'A M'; const h12 = h % 12 === 0 ? 12 : h % 12; return mi === 0 ? `${h12} ${ap}` : `${h12} ${pad2(mi)} ${ap}`; }
