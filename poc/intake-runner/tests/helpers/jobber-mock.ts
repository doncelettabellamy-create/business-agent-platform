// A local stand-in for Jobber's GraphQL API, shared by the joined fast-call test: the account, the busy calendar (scheduled items), client and job creation, the marker search and the read-back by id.
// Nothing here contacts Jobber. Every value is invented.
import { createServer } from 'node:http';

export const ACCOUNT = { id: 'ACCT-TEST-1', name: 'Test Cleaning Developer Account' };
export interface JobberMockOptions { account: { id: string; name: string }; scheduled: Array<{ startAt: string; endAt: string; allDay?: boolean }>; hasMoreScheduled: boolean; shiftVisitMs: number; jobUserErrors: boolean; searchBlind: boolean }
export interface JobberMock { endpoints: { authorize: string; token: string; graphql: string }; ops: Array<{ field: string; variables: Record<string, unknown> }>; opts: JobberMockOptions; jobs: Map<string, Record<string, unknown>>; clientCount(): number; close(): Promise<void> }

export async function mockJobber(): Promise<JobberMock> {
  const ops: JobberMock['ops'] = []; const jobs = new Map<string, Record<string, unknown>>(); let clients = 0; let n = 0;
  const opts: JobberMockOptions = { account: ACCOUNT, scheduled: [], hasMoreScheduled: false, shiftVisitMs: 0, jobUserErrors: false, searchBlind: false };
  const props = new Map<string, { client: Record<string, unknown>; address: Record<string, unknown> }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const send = (s: number, o: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method !== 'POST' || req.url !== '/api/graphql') return send(404, {});
      if (!/^Bearer tok-valid/.test(String(req.headers.authorization ?? ''))) return send(401, {});
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables?: Record<string, unknown> }; const v = b.variables ?? {};
      const data = (d: unknown) => send(200, { data: d, extensions: { versioning: { version: '2026-09-25' } } });
      if (/query Busy/.test(b.query)) { ops.push({ field: 'scheduledItems', variables: v }); return data({ scheduledItems: { nodes: opts.scheduled, pageInfo: { hasNextPage: opts.hasMoreScheduled } } }); }
      if (/query GetAccount/.test(b.query)) { ops.push({ field: 'account', variables: v }); return data({ account: opts.account }); }
      if (/clientCreate/.test(b.query)) {
        ops.push({ field: 'clientCreate', variables: v });
        const input = (v.input ?? {}) as Record<string, unknown>; clients++; const pid = `PROP-${++n}`;
        props.set(pid, { client: { firstName: input.firstName, lastName: input.lastName, phones: ((input.phones ?? []) as Array<{ number: string }>).map((p) => ({ number: p.number })) }, address: (((input.properties ?? []) as Array<{ address: Record<string, unknown> }>)[0] ?? { address: {} }).address });
        return data({ clientCreate: { client: { id: `CLIENT-${clients}`, clientProperties: { nodes: [{ id: pid }] } }, userErrors: [] } });
      }
      if (/jobCreate/.test(b.query)) {
        ops.push({ field: 'jobCreate', variables: v });
        if (opts.jobUserErrors) return data({ jobCreate: { job: null, userErrors: [{ message: 'bad', path: ['y'] }] } });
        const input = (v.input ?? {}) as { propertyId: string; title: string; instructions: string; timeframe: { startAt: string }; scheduling: { startTime: string; endTime: string }; lineItems: Array<{ unitPrice: number; quantity: number }> };
        const p = props.get(input.propertyId); const id = `JOB-${++n}`; const off = '-06:00';
        const s = Date.parse(`${input.timeframe.startAt}T${input.scheduling.startTime}${off}`) + opts.shiftVisitMs; const e = Date.parse(`${input.timeframe.startAt}T${input.scheduling.endTime}${off}`) + opts.shiftVisitMs;
        jobs.set(id, { id, jobNumber: 1000 + n, title: input.title, instructions: input.instructions, jobStatus: 'UPCOMING', total: input.lineItems.reduce((a, l) => a + l.unitPrice * l.quantity, 0), client: p?.client, property: { address: p?.address }, visits: { nodes: [{ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() }] } });
        return data({ jobCreate: { job: { id, jobNumber: 1000 + n }, userErrors: [] } });
      }
      if (/FindTestJobs/.test(b.query)) { ops.push({ field: 'jobs', variables: v }); return data({ jobs: { nodes: opts.searchBlind ? [] : [...jobs.values()].filter((j) => String(j.title).includes(String(v.term))).map((j) => ({ id: j.id, title: j.title })) } }); }
      if (/ReadBackJob/.test(b.query)) { ops.push({ field: 'job', variables: v }); return data({ job: jobs.get(String(v.id)) ?? null }); }
      return data({});
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoints: { authorize: `${origin}/a`, token: `${origin}/t`, graphql: `${origin}/api/graphql` }, ops, opts, jobs, clientCount: () => clients, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}
