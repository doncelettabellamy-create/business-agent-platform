// A minimal stand-in for the browser's DOM, enough to run the dashboard pages' own scripts in Node without a browser or a network.
// Elements keep their children, text, attributes and listeners; unknown ids give a stable element, so a page can be run as written.
export class FakeNode {
  tag: string; children: FakeNode[] = []; own = ''; attrs = new Map<string, string>(); listeners = new Map<string, Array<(e: unknown) => void>>();
  className = ''; hidden = false; value = ''; disabled = false;
  constructor(tag: string) { this.tag = tag; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { this.children.push(c); return c; }
  removeChild(c: FakeNode): FakeNode { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: unknown): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn({ type, preventDefault() {} }); }
  get textContent(): string { return [this.own, ...this.children.map((c) => c.textContent)].filter((s) => s.length > 0).join(' '); }
  set textContent(v: string) { this.children = []; this.own = String(v); }
  /** Every descendant element (not text), depth first. */
  descendants(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(): null { return null; }
  querySelectorAll(): never[] { return []; }
  closest(): null { return null; }
  click(): void { this.fire('click'); }
  focus(): void {}
}

export interface FakeBrowser {
  document: Record<string, unknown>; window: Record<string, unknown>;
  node(id: string): FakeNode;
  created: string[];
  timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  docListeners: Map<string, Array<(e: unknown) => void>>;
  winListeners: Map<string, Array<(e: unknown) => void>>;
  setHidden(h: boolean): void;
  /** Changes the page's address fragment and tells the page, as a browser does. */
  navigate(hash: string): void;
}
export function fakeBrowser(extraWindow: Record<string, unknown> = {}): FakeBrowser {
  const nodes = new Map<string, FakeNode>(); const created: string[] = []; const timers: FakeBrowser['timers'] = [];
  const docListeners = new Map<string, Array<(e: unknown) => void>>();
  const winListeners = new Map<string, Array<(e: unknown) => void>>();
  const node = (id: string): FakeNode => { let n = nodes.get(id); if (!n) { n = new FakeNode('x'); nodes.set(id, n); } return n; };
  const document: Record<string, unknown> = {
    hidden: false, title: '',
    getElementById: node,
    createElement: (t: string) => { created.push(t); return new FakeNode(t); },
    createTextNode: (t: string) => { const n = new FakeNode('#text'); n.own = t; return n; },
    addEventListener: (type: string, fn: (e: unknown) => void) => { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
  };
  const window: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    location: { hash: '' }, scrollY: 0, scrollTo: () => {},
    addEventListener: (type: string, fn: (e: unknown) => void) => { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    ...extraWindow,
  };
  const navigate = (hash: string): void => { (window.location as { hash: string }).hash = hash; for (const fn of winListeners.get('hashchange') ?? []) fn({ type: 'hashchange' }); };
  return { document, window, node, created, timers, docListeners, winListeners, setHidden: (h) => { document.hidden = h; }, navigate };
}
