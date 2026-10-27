import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

const maxBodyBytes = 1024 * 1024;

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function body(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function end(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, headers).end();
}

/**
 * The HTTP face of the server: `POST /mcp` with the Bearer token, stateless; `GET /health` for the container.
 * A request with an `Origin` header is refused, so that no web page can use the server through a browser.
 */
export function createHttpServer(factory: () => McpServer, mcpToken: string): Server {
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  return createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/health' && request.method === 'GET') return void response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      if (path !== '/mcp') return end(response, 404);
      if (request.method !== 'POST') return end(response, 405, { allow: 'POST' });
      if (request.headers.origin !== undefined) return end(response, 403);
      if (!authorized(request.headers.authorization, mcpToken)) return end(response, 401, { 'www-authenticate': 'Bearer' });
      const payload = await body(request);
      if (!payload) return end(response, 413);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const answer = await handler.fetch(new Request(`http://localhost${request.url}`, { method: 'POST', headers, body: payload.toString('utf8') }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (answer.body) Readable.fromWeb(answer.body as unknown as NodeReadableStream).pipe(response);
      else response.end();
    })().catch(() => { if (!response.headersSent) end(response, 500); else response.end(); });
  });
}
