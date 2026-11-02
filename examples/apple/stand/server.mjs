// The example's stand: one HTTP service the app asks, counting what it answered.

import http from 'node:http';

const port = Number(process.env.PORT ?? 4100);
let hits = 0;

http
  .createServer((req, res) => {
    if (req.url === '/health') return void res.end('ok');
    if (req.url === '/hits') return void res.end(String(hits));
    if (req.url === '/reset') {
      hits = 0;
      return void res.end('0');
    }
    if (req.url === '/hello') {
      hits++;
      return void res.end(`hello from the stand #${hits}`);
    }
    res.writeHead(404).end();
  })
  .listen(port, '127.0.0.1', () => console.log(`stand on :${port}`));
