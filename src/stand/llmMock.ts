// An OpenAI-compatible stand-in for a model provider: `/v1/chat/completions` and `/v1/models`, answers from
// fixtures matched against the last user message, streaming or not. Lets a stand exercise AI features with no
// key and no bill. Rules set while it runs force a reply, a provider error or a slow answer for the requests they
// match, so the paths around a model can be tested without editing fixtures; every request is kept in a log.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export type Fixture = {match: string; reply: string; model?: string};

export const loadFixtures = (location: string | undefined): Fixture[] => {
  if (!location || !fs.existsSync(location)) return [];
  const files = fs.statSync(location).isDirectory()
    ? fs.readdirSync(location).filter(f => f.endsWith('.json')).map(f => path.join(location, f))
    : [location];
  return files.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')) as Fixture[]);
};

type Message = {role: string; content: unknown};

/** A rule set while the mock runs; `match` is a regex on the last user message (all requests without one). */
export type LlmRule = {id: string; action: 'reply' | 'fail' | 'delay'; match?: string; text?: string; status?: number; ms?: number; once?: boolean};

export type LlmRequest = {at: number; model: string; stream: boolean; prompt: string; source: string; status: number; reply?: string};

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (typeof p === 'object' && p && 'text' in p ? String((p as {text: unknown}).text) : '')).join(' ')
      : '';

export const lastUserText = (messages: Message[]): string => {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  return lastUser ? textOf(lastUser.content) : '';
};

export const pickReply = (fixtures: Fixture[], messages: Message[]): string => pickFixture(fixtures, lastUserText(messages)).reply;

const pickFixture = (fixtures: Fixture[], text: string): {reply: string; source: string} => {
  const hit = fixtures.find(f => new RegExp(f.match, 'is').test(text));
  return hit ? {reply: hit.reply, source: `fixture /${hit.match}/`} : {reply: `mock reply to: ${text.slice(0, 200)}`, source: 'default'};
};

const ruleMatches = (r: LlmRule, text: string) => !r.match || new RegExp(r.match, 'is').test(text);

export class LlmMock {
  #server?: http.Server;
  #fixtures: Fixture[] = [];
  requests = 0;
  rules: LlmRule[] = [];
  readonly log: LlmRequest[] = [];
  #ruleSeq = 0;

  readonly port: number;
  readonly fixturesPath?: string;

  constructor(port: number, fixturesPath?: string) {
    this.port = port;
    this.fixturesPath = fixturesPath;
  }

  get running() {
    return this.#server?.listening ?? false;
  }

  async start() {
    if (this.running) return;
    this.#fixtures = loadFixtures(this.fixturesPath);
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.port, '0.0.0.0', () => resolve());
    });
  }

  /** Adds a rule in front of the others (the newest wins). */
  addRule(rule: Omit<LlmRule, 'id'>): LlmRule {
    if (rule.match) new RegExp(rule.match);
    const r = {id: `m${++this.#ruleSeq}`, ...rule};
    this.rules.unshift(r);
    return r;
  }

  clearRules() {
    this.rules = [];
  }

  /** Reads the fixtures again (edited while the stand runs). */
  reload(): number {
    this.#fixtures = loadFixtures(this.fixturesPath);
    return this.#fixtures.length;
  }

  get fixtures() {
    return this.#fixtures.length;
  }

  #record(r: LlmRequest) {
    this.log.push(r);
    if (this.log.length > 50) this.log.shift();
  }

  /** The newest matching rule of the given kinds; `once` rules are used up. */
  #take(actions: LlmRule['action'][], text: string): LlmRule | undefined {
    const r = this.rules.find(x => actions.includes(x.action) && ruleMatches(x, text));
    if (r?.once) this.rules = this.rules.filter(x => x !== r);
    return r;
  }

  async stop() {
    await new Promise<void>(r => (this.#server ? this.#server.close(() => r()) : r()));
    this.#server = undefined;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({object: 'list', data: [{id: 'pitbox-mock', object: 'model'}]}));
      return;
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    this.requests++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: {messages?: Message[]; stream?: boolean; model?: string};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const text = lastUserText(body.messages ?? []);
    const model = body.model ?? 'pitbox-mock';
    const base = {at: Date.now(), model, stream: !!body.stream, prompt: text.slice(0, 200)};
    const delay = this.#take(['delay'], text);
    if (delay?.ms) await new Promise(r => setTimeout(r, delay.ms));
    // A forced reply and a forced error compete: the newest rule that matches decides.
    const decided = this.#take(['reply', 'fail'], text);
    const fail = decided?.action === 'fail' ? decided : undefined;
    if (fail) {
      const status = fail.status ?? 500;
      this.#record({...base, source: `rule ${fail.id}`, status});
      res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: fail.text ?? `mock failure ${status}`, type: status === 429 ? 'rate_limit_exceeded' : 'server_error', code: status}}));
      return;
    }
    const forced = decided?.action === 'reply' ? decided : undefined;
    const {reply, source} = forced ? {reply: forced.text ?? '', source: `rule ${forced.id}`} : pickFixture(this.#fixtures, text);
    this.#record({...base, source: delay ? `${source}, delayed ${delay.ms} ms` : source, status: 200, reply: reply.slice(0, 200)});
    const id = `chatcmpl-mock-${this.requests}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({id, object: 'chat.completion.chunk', created, model, choices: [{index: 0, delta: {role: 'assistant', content: reply}, finish_reason: null}]});
      send({id, object: 'chat.completion.chunk', created, model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'}).end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{index: 0, message: {role: 'assistant', content: reply}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      }),
    );
  }
}
