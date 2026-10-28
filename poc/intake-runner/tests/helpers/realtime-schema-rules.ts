// What the documented Realtime schema refuses (client events reference, read 2026-10-27), as a function the offline voice stand-ins call on every request. A request refused here is answered with an error
// that names it, so a test that sends something the real service would reject fails. A model of the documentation, not of the service: whether a given model accepts a given effort is NOT stated anywhere.
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const HINT_MODELS = ['gpt-transcribe', 'gpt-live-transcribe'];

/** Why the real service would refuse this client event, or undefined. */
export function refusalFor(m: any): string | undefined {
  if (m?.type === 'session.update') {
    const s = m.session;
    if (s?.type !== 'realtime') return 'session.update without session.type';
    if (s.reasoning !== undefined && !EFFORTS.includes(s.reasoning?.effort)) return 'session.reasoning.effort is not one of the documented values';
    const t = s.audio?.input?.transcription;
    if (t !== undefined && t !== null) {
      if (typeof t.model !== 'string') return 'transcription.model is missing';
      for (const k of Object.keys(t)) if (!['model', 'language', 'languages', 'keywords'].includes(k)) return `transcription.${k} is not sent by this project (prompt and delay are not documented for the models used)`;
      if ('language' in t && 'languages' in t) return 'transcription.language and transcription.languages must not both be sent';
      if (('languages' in t || 'keywords' in t) && !HINT_MODELS.includes(t.model)) return 'transcription languages and keywords are documented only for gpt-transcribe and gpt-live-transcribe';
      if ('languages' in t && !(Array.isArray(t.languages) && t.languages.length > 0 && t.languages.every((l: unknown) => typeof l === 'string' && /^[a-z]{2}$/.test(l)))) return 'transcription.languages must be ISO-639-1 codes';
      if ('keywords' in t && !(Array.isArray(t.keywords) && t.keywords.length > 0 && t.keywords.every((k: unknown) => typeof k === 'string' && k.length > 0 && !/[<>\r\n]/.test(k)))) return 'transcription.keywords must be single-line hints without angle brackets';
    }
  }
  if (m?.type === 'session.update' && m.session?.tools !== undefined) {
    const tl = m.session.tools;
    if (!Array.isArray(tl) || tl.length < 1 || !tl.every((t: any) => t?.type === 'function' && typeof t.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.name) && typeof t.description === 'string' && typeof t.parameters === 'object' && t.parameters !== null)) return 'session.tools must be function tools with a name, a description and parameters';
    if (m.session.tool_choice !== undefined && !['auto', 'none', 'required'].includes(m.session.tool_choice)) return 'session.tool_choice is not one of the documented values';
  }
  if (m?.type === 'response.create' && m.response?.tool_choice !== undefined && !['auto', 'none', 'required'].includes(m.response.tool_choice)) return 'response.tool_choice is not one of the documented values';
  if (m?.type === 'conversation.item.create') {
    const it = m.item;
    if (it?.type === 'function_call_output' && (typeof it.call_id !== 'string' || it.call_id.length === 0 || typeof it.output !== 'string')) return 'a function_call_output needs a call_id and a string output';
  }
  if (m?.type === 'response.create' && m.response?.reasoning !== undefined && !EFFORTS.includes(m.response.reasoning?.effort)) return 'response.reasoning.effort is not one of the documented values';
  return undefined;
}
