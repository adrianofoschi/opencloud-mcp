import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { OpenCloud } from '../src/opencloud.js';
import { extractText } from '../src/tika.js';
import { createToolServer } from '../src/tools.js';

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const space = '/dav/spaces/1284d238-aa92-42ce-bdc4-0b0000009157$4c510ada-c86b-4815-8820-42cdf82c3d51';
const credentials = `Basic ${Buffer.from('ambrogio:secret app token').toString('base64')}`;

function entry(path: string, name: string, type: string, size: number, highlights?: string): string {
  return `<d:response><d:href>${space}/${path}</d:href><d:propstat><d:prop><oc:name>${name}</oc:name>`
    + `<d:getcontenttype>${type}</d:getcontenttype><d:getcontentlength>${size}</d:getcontentlength>`
    + '<d:getlastmodified>Mon, 21 Oct 2024 10:00:00 GMT</d:getlastmodified><d:resourcetype/>'
    + (highlights ? `<oc:highlights>${highlights}</oc:highlights>` : '<oc:highlights/>')
    + `<oc:privatelink>https://cloud.example.com/f/${encodeURIComponent(name)}</oc:privatelink>`
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

/** OpenCloud as seen on a real 7.2 instance: content patterns return highlights, name patterns do not. */
async function fakeOpenCloud(patterns: string[], searched: string[], files: Record<string, { type: string; body: string }>) {
  return listen(createServer(async (request, response) => {
    if (request.headers.authorization !== credentials) return void response.writeHead(401).end();
    if (request.method === 'REPORT' && request.url === '/dav/spaces/') {
      const body = (await read(request)).toString();
      searched.push(body);
      const pattern = /<oc:pattern>(.*)<\/oc:pattern>/.exec(body)?.[1] ?? '';
      patterns.push(pattern);
      const found = pattern.startsWith('content:')
        ? entry('Fatture/2024-05-10_fattura-lavatrice.pdf', '2024-05-10_fattura-lavatrice.pdf', 'application/pdf', 4096,
          '&amp;lt;mark&amp;gt;Fattura&amp;lt;/mark&amp;gt; lavatrice&amp;#xA;totale 499 EUR')
        : entry('Fatture/2024-05-10_fattura-lavatrice.pdf', '2024-05-10_fattura-lavatrice.pdf', 'application/pdf', 4096)
          + entry('Note/fattura%20da%20pagare.txt', 'fattura da pagare.txt', 'text/plain', 30);
      return void response.writeHead(207, { 'content-type': 'application/xml' })
        .end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${found}</d:multistatus>`);
    }
    const file = files[decodeURIComponent(request.url ?? '')];
    if (request.method === 'GET' && file) return void response.writeHead(200, { 'content-type': file.type }).end(file.body);
    response.writeHead(404).end();
  }));
}

async function fakeTika(seen: string[]) {
  return listen(createServer(async (request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers['content-type']} ${(await read(request)).toString()}`);
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Fattura lavatrice\n\n\n\nTotale 499 EUR   \n');
  }));
}

async function started(options: Readonly<{ tika?: boolean; readMaxChars?: number }> = {}) {
  const patterns: string[] = [];
  const searched: string[] = [];
  const extracted: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const openCloudUrl = await fakeOpenCloud(patterns, searched, {
    [`${space}/Fatture/2024-05-10_fattura-lavatrice.pdf`]: { type: 'application/pdf', body: '%PDF-1.7 binary' },
    [`${space}/Note/fattura da pagare.txt`]: { type: 'text/plain; charset=utf-8', body: 'abcdefghij'.repeat(100) },
  });
  const tikaUrl = options.tika === false ? undefined : await fakeTika(extracted);
  const config: Config = { openCloudUrl, user: 'ambrogio', appToken: 'secret app token', mcpToken: 'mcp-secret',
    host: '127.0.0.1', port: 0, readMaxChars: options.readMaxChars ?? 8000, downloadMaxBytes: 1024 * 1024,
    ...(tikaUrl ? { tikaUrl } : {}) };
  const openCloud = new OpenCloud(config);
  const origin = await listen(createHttpServer(() => createToolServer({ openCloud, config, version: '9.9.9',
    log: fields => { logs.push(fields); },
    ...(tikaUrl ? { extract: (bytes, type) => extractText(tikaUrl, bytes, type) } : {}) }), config.mcpToken));
  return { url: new URL('/mcp', origin), origin, patterns, searched, extracted, logs };
}

async function connected(url: URL, token = 'mcp-secret') {
  const client = new Client({ name: 'test', version: '0.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

describe('opencloud-mcp', () => {
  it('offers the two read-only tools', async () => {
    const client = await connected((await started()).url);
    expect(client.getServerVersion()).toMatchObject({ name: 'opencloud-mcp', version: '9.9.9' });
    const { tools } = await client.listTools();
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint])).toEqual([['search_files', true], ['read_file', true]]);
  });

  it('searches names and content, content matches first with their excerpt, each file once', async () => {
    const { url, patterns, searched } = await started();
    const client = await connected(url);
    const result = await client.callTool({ name: 'search_files', arguments: { query: 'fattura (lavatrice)' } });
    expect(patterns.sort()).toEqual(['*fattura*lavatrice*', 'content:fattura content:lavatrice']);
    expect(searched.every(body => body.includes('<oc:privatelink/>'))).toBe(true);
    expect(result.structuredContent).toEqual({ results: [
      { file: `${space}/Fatture/2024-05-10_fattura-lavatrice.pdf`, name: '2024-05-10_fattura-lavatrice.pdf',
        path: '/Fatture/2024-05-10_fattura-lavatrice.pdf', type: 'file', contentType: 'application/pdf', size: 4096,
        modified: '2024-10-21T10:00:00.000Z', excerpt: 'Fattura lavatrice totale 499 EUR',
        link: 'https://cloud.example.com/f/2024-05-10_fattura-lavatrice.pdf' },
      { file: `${space}/Note/fattura%20da%20pagare.txt`, name: 'fattura da pagare.txt', path: '/Note/fattura da pagare.txt',
        type: 'file', contentType: 'text/plain', size: 30, modified: '2024-10-21T10:00:00.000Z',
        link: 'https://cloud.example.com/f/fattura%20da%20pagare.txt' },
    ] });
  });

  it('reads a PDF through Tika and a text file directly, in parts', async () => {
    const { url, extracted } = await started({ readMaxChars: 600 });
    const client = await connected(url);
    const pdf = await client.callTool({ name: 'read_file', arguments: { file: `${space}/Fatture/2024-05-10_fattura-lavatrice.pdf` } });
    expect(pdf.structuredContent).toEqual({ name: '2024-05-10_fattura-lavatrice.pdf', contentType: 'application/pdf',
      totalCharacters: 33, offset: 0, text: 'Fattura lavatrice\n\nTotale 499 EUR' });
    expect(extracted).toEqual(['PUT /tika application/pdf %PDF-1.7 binary']);
    const file = `${space}/Note/fattura%20da%20pagare.txt`;
    const first = await client.callTool({ name: 'read_file', arguments: { file } });
    expect(first.structuredContent).toMatchObject({ totalCharacters: 1000, offset: 0, nextOffset: 600 });
    const second = await client.callTool({ name: 'read_file', arguments: { file, offset: 600 } });
    expect(second.structuredContent).toMatchObject({ offset: 600, text: 'abcdefghij'.repeat(40) });
    expect(second.structuredContent).not.toHaveProperty('nextOffset');
  });

  it('refuses files outside the spaces and reports what cannot be read', async () => {
    const { url, logs } = await started({ tika: false });
    const client = await connected(url);
    for (const file of ['/etc/passwd', `${space}/../../other`, `${space}/x?download=1`]) {
      expect(await client.callTool({ name: 'read_file', arguments: { file } }))
        .toMatchObject({ isError: true, content: [{ text: 'Unknown file: use the file of a search result' }] });
    }
    expect(await client.callTool({ name: 'read_file', arguments: { file: `${space}/Fatture/2024-05-10_fattura-lavatrice.pdf` } }))
      .toMatchObject({ isError: true, content: [{ text: 'This type of file cannot be read' }] });
    expect(await client.callTool({ name: 'read_file', arguments: { file: `${space}/missing.txt` } }))
      .toMatchObject({ isError: true, content: [{ text: 'File not found' }] });
    expect(await client.callTool({ name: 'search_files', arguments: { query: ' :() ' } }))
      .toMatchObject({ isError: true });
    expect(logs.map(entry => entry.event)).toContain('read_failed');
  });

  it('requires the Bearer token, refuses browsers and other methods', async () => {
    const { url, origin } = await started();
    await expect(connected(url, 'wrong')).rejects.toThrow();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: 'Bearer mcp-secret' };
    expect((await fetch(url, { method: 'POST', body, headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
    expect((await fetch(new URL('/other', origin))).status).toBe(404);
    expect(await (await fetch(new URL('/health', origin))).text()).toBe('ok');
  });
});
