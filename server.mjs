import http from 'node:http';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(fileURLToPath(import.meta.url));

export function createRequestHandler({
  storageDirectory = join(projectDirectory, '.data'),
  indexPath = join(projectDirectory, 'index.html'),
} = {}) {
  let writeQueue = Promise.resolve();

  function sendJson(response, status, body) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }

  function saveSubscription(email) {
    const pending = writeQueue.then(async () => {
      await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
      const destination = join(storageDirectory, 'subscribers.json');
      let subscribers;
      try {
        subscribers = JSON.parse(await readFile(destination, 'utf8'));
        if (!Array.isArray(subscribers)) throw new Error('Invalid subscriber store');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        subscribers = [];
      }
      if (subscribers.some(subscriber => subscriber.email === email)) return false;

      subscribers.push({ email, subscribedAt: new Date().toISOString() });
      const temporary = join(storageDirectory, '.' + randomUUID() + '.tmp');
      try {
        await writeFile(temporary, JSON.stringify(subscribers, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return true;
    });
    writeQueue = pending.catch(() => {});
    return pending;
  }

  return async function handleRequest(request, response) {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/subscribe') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          sendJson(response, 405, { error: 'Use POST to subscribe.' });
          return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          sendJson(response, 415, { error: 'Send JSON.' });
          return;
        }

        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes <= 4096) chunks.push(chunk);
        }
        if (bytes > 4096) {
          sendJson(response, 413, { error: 'Request is too large.' });
          return;
        }

        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendJson(response, 400, { error: 'Enter a valid email address.' });
          return;
        }
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(response, 400, { error: 'Enter a valid email address.' });
          return;
        }
        const created = await saveSubscription(email);
        sendJson(response, created ? 201 : 200, { subscribed: true });
        return;
      }

      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const page = await readFile(indexPath);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        response.end(page);
        return;
      }
      sendJson(response, 404, { error: 'Not found.' });
    } catch {
      sendJson(response, 503, { error: 'Signup is unavailable right now. Please try again.' });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(createRequestHandler());
  server.requestTimeout = 15000;
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    const address = server.address();
    console.log('The Fading Chorus is running at http://' + address.address + ':' + address.port);
  });
}
