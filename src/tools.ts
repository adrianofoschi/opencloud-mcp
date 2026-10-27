import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { OpenCloudError, type FoundFile, type OpenCloud } from './opencloud.js';
import { searchPatterns } from './text.js';

export type ToolDependencies = Readonly<{
  openCloud: Pick<OpenCloud, 'search' | 'download'>;
  extract?: (bytes: Uint8Array, contentType: string) => Promise<string>;
  config: Pick<Config, 'readMaxChars'>;
  version: string;
  log: (fields: Record<string, unknown>) => void;
}>;

type SearchArguments = Readonly<{ query: string; limit?: number }>;
type ReadArguments = Readonly<{ file: string; offset?: number }>;

const maxResults = 20;
const defaultResults = 10;

/** Text types read as they are; anything else goes through Tika. */
function isText(contentType: string): boolean {
  return contentType.startsWith('text/') || ['application/json', 'application/xml', 'application/csv'].includes(contentType);
}

function failure(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function success<T extends Record<string, unknown>>(value: T) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** Content matches first, with their excerpt, then name-only matches; each file once. */
export function merged(byContent: readonly FoundFile[], byName: readonly FoundFile[], limit: number): FoundFile[] {
  const seen = new Set<string>();
  return [...byContent, ...byName].filter(found => !seen.has(found.file) && seen.add(found.file)).slice(0, limit);
}

/** The MCP server, built for one request by the stateless handler. */
export function createToolServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer({ name: 'opencloud-mcp', version: dependencies.version }, { capabilities: { tools: {} } });

  server.registerTool('search_files', {
    description: 'Search the OpenCloud files you can see by words in their name or in their text, including PDFs and '
      + 'office documents. Returns the files, content matches first, with an excerpt around the words found.',
    inputSchema: fromJsonSchema<SearchArguments>({ type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to find; all of them must match.' },
        limit: { type: 'integer', minimum: 1, maximum: maxResults, description: `Number of files, ${defaultResults} by default.` },
      } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    const patterns = searchPatterns(query);
    if (!patterns) return failure('Invalid argument query: write at least one word');
    const size = limit ?? defaultResults;
    try {
      const [byContent, byName] = await Promise.all([dependencies.openCloud.search(patterns.content, size),
        dependencies.openCloud.search(patterns.name, size)]);
      return success({ results: merged(byContent, byName, size) });
    } catch (error) {
      dependencies.log({ level: 'error', event: 'search_failed', message: error instanceof Error ? error.message : 'Unknown failure' });
      return failure(error instanceof OpenCloudError ? error.message : 'Search failed');
    }
  });

  server.registerTool('read_file', {
    description: 'Read the text of a file found by search_files, including PDFs and office documents. Long texts are '
      + 'returned in parts: call again with nextOffset to read the next part.',
    inputSchema: fromJsonSchema<ReadArguments>({ type: 'object', additionalProperties: false, required: ['file'],
      properties: {
        file: { type: 'string', minLength: 1, maxLength: 2000, description: 'The file field of a search result.' },
        offset: { type: 'integer', minimum: 0, description: 'First character to return, 0 by default.' },
      } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ file, offset }) => {
    try {
      const downloaded = await dependencies.openCloud.download(file);
      let text: string;
      if (isText(downloaded.contentType)) text = new TextDecoder().decode(downloaded.bytes);
      else if (dependencies.extract) text = await dependencies.extract(downloaded.bytes, downloaded.contentType);
      else return failure('This type of file cannot be read');
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const start = Math.min(offset ?? 0, text.length);
      const end = Math.min(start + dependencies.config.readMaxChars, text.length);
      return success({ name: downloaded.name, contentType: downloaded.contentType, totalCharacters: text.length,
        offset: start, text: text.slice(start, end), ...(end < text.length ? { nextOffset: end } : {}) });
    } catch (error) {
      dependencies.log({ level: 'error', event: 'read_failed', message: error instanceof Error ? error.message : 'Unknown failure' });
      return failure(error instanceof OpenCloudError ? error.message : 'The text of the file could not be extracted');
    }
  });
  return server;
}
