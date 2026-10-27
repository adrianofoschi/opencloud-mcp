import { XMLParser } from 'fast-xml-parser';
import type { Config } from './config.js';
import { escapeXml, plainExcerpt } from './text.js';

export type FoundFile = Readonly<{
  /** The file as the read tool expects it: its WebDAV path under `/dav/spaces/`. */
  file: string;
  name: string;
  /** The path inside its space. */
  path: string;
  type: 'file' | 'folder';
  contentType?: string;
  size?: number;
  modified?: string;
  /** The text around the words found in the content, when the match is in the content. */
  excerpt?: string;
  /** Address that opens the file in the OpenCloud web interface, for anyone who has access to it. */
  link?: string;
}>;

export type DownloadedFile = Readonly<{ name: string; contentType: string; bytes: Uint8Array }>;

/** A failure that the tools report with its fixed message. */
export class OpenCloudError extends Error {}

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false,
  isArray: name => name === 'response' || name === 'propstat' });

const spacePath = /^\/dav\/spaces\/[^/]+\//;

/** The WebDAV search and download of OpenCloud, with the credentials of one user. */
export class OpenCloud {
  readonly #config: Config;
  readonly #fetch: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const credentials = Buffer.from(`${this.#config.user}:${this.#config.appToken}`).toString('base64');
    return { authorization: `Basic ${credentials}`,
      ...(this.#config.openCloudHost ? { host: this.#config.openCloudHost, 'x-forwarded-proto': 'https' } : {}), ...extra };
  }

  /** Every space the user can see, with the query language of OpenCloud: `*name*` or `content:word`. */
  async search(pattern: string, limit: number): Promise<FoundFile[]> {
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<oc:search-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>'
      + '<oc:name/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><oc:highlights/><oc:privatelink/>'
      + `</d:prop><oc:search><oc:pattern>${escapeXml(pattern)}</oc:pattern><oc:limit>${limit}</oc:limit></oc:search>`
      + '</oc:search-files>';
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.openCloudUrl}/dav/spaces/`, { method: 'REPORT',
        headers: this.#headers({ 'content-type': 'application/xml' }), body, signal: AbortSignal.timeout(20_000) });
    } catch (error) { throw new OpenCloudError('OpenCloud is not reachable', { cause: error }); }
    if (response.status === 401) throw new OpenCloudError('OpenCloud refused the credentials');
    if (response.status !== 207) throw new OpenCloudError(`OpenCloud search failed with HTTP ${response.status}`);
    return parseMultistatus(await response.text());
  }

  /** The content of a file found by a search, refused above the download limit. */
  async download(file: string): Promise<DownloadedFile> {
    if (!spacePath.test(file) || file.split('/').includes('..') || /[?#]/.test(file)) {
      throw new OpenCloudError('Unknown file: use the file of a search result');
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.openCloudUrl}${file}`, { headers: this.#headers(),
        signal: AbortSignal.timeout(60_000) });
    } catch (error) { throw new OpenCloudError('OpenCloud is not reachable', { cause: error }); }
    if (response.status === 404) throw new OpenCloudError('File not found');
    if (response.status !== 200 || !response.body) throw new OpenCloudError(`OpenCloud download failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.#config.downloadMaxBytes) {
      await response.body.cancel();
      throw new OpenCloudError('File too large to read');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > this.#config.downloadMaxBytes) throw new OpenCloudError('File too large to read');
      chunks.push(chunk);
    }
    return { name: decodeURIComponent(file.split('/').filter(Boolean).at(-1) ?? ''),
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
      bytes: Buffer.concat(chunks) };
  }
}

type Prop = Partial<Record<'name' | 'getcontenttype' | 'getcontentlength' | 'getlastmodified' | 'highlights' | 'privatelink', string>>
  & { resourcetype?: unknown };

function parseMultistatus(xml: string): FoundFile[] {
  let document: { multistatus?: { response?: Array<{ href?: string; propstat?: Array<{ prop?: Prop; status?: string }> }> } };
  try { document = parser.parse(xml); } catch (error) { throw new OpenCloudError('OpenCloud returned an invalid search response', { cause: error }); }
  return (document.multistatus?.response ?? []).flatMap(response => {
    const href = response.href;
    if (typeof href !== 'string' || !spacePath.test(href)) return [];
    const prop: Prop = Object.assign({}, ...(response.propstat ?? [])
      .filter(stat => !stat.status || stat.status.includes(' 200 ')).map(stat => stat.prop ?? {}));
    const relative = decodeURIComponent(href.replace(spacePath, '')).replace(/\/$/, '');
    const folder = typeof prop.resourcetype === 'object' && prop.resourcetype !== null && 'collection' in prop.resourcetype;
    const size = Number(prop.getcontentlength);
    const excerpt = prop.highlights ? plainExcerpt(prop.highlights) : '';
    return [{ file: href, name: prop.name || relative.split('/').at(-1) || relative, path: `/${relative}`,
      type: folder ? 'folder' as const : 'file' as const,
      ...(prop.getcontenttype ? { contentType: prop.getcontenttype } : {}),
      ...(Number.isFinite(size) && prop.getcontentlength !== undefined ? { size } : {}),
      ...(prop.getlastmodified ? { modified: new Date(prop.getlastmodified).toISOString() } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(prop.privatelink && /^https?:\/\//.test(prop.privatelink) ? { link: prop.privatelink } : {}) }];
  });
}
