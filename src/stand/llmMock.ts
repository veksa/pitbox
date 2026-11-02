// An OpenAI-compatible stand-in for a model provider: `/v1/chat/completions` and `/v1/models`, answers from
// fixtures matched against the last user message, streaming or not. Lets a stand exercise AI features with no
// key and no bill.

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

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (typeof p === 'object' && p && 'text' in p ? String((p as {text: unknown}).text) : '')).join(' ')
      : '';

export const pickReply = (fixtures: Fixture[], messages: Message[]): string => {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = lastUser ? textOf(lastUser.content) : '';
  const hit = fixtures.find(f => new RegExp(f.match, 'is').test(text));
  return hit ? hit.reply : `mock reply to: ${text.slice(0, 200)}`;
};

export class LlmMock {
  #server?: http.Server;
  #fixtures: Fixture[] = [];
  requests = 0;

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
    const reply = pickReply(this.#fixtures, body.messages ?? []);
    const id = `chatcmpl-mock-${this.requests}`;
    const model = body.model ?? 'pitbox-mock';
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
