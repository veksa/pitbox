// An actor of the examples: another user of the app, started by pitbox on a free port. It answers a health check
// and echoes what `actor call` sends, with its name.

import http from 'node:http';

const [name = 'peer', port = '0'] = process.argv.slice(2);

http
  .createServer((req, res) => {
    if (req.url === '/health') return void res.end('ok');
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      console.log(`${name} got ${req.method} ${req.url} ${body}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({from: name, got: body ? JSON.parse(body) : null}));
    });
  })
  .listen(Number(port), '127.0.0.1', () => console.log(`${name} on :${port}`));
