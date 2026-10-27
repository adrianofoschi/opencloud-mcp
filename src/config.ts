/** The configuration of the server, read once from the environment at startup. */
export type Config = Readonly<{
  /** Base URL of OpenCloud, for example `http://opencloud:9200`. */
  openCloudUrl: string;
  /** Host header sent to OpenCloud, when it differs from the host of `openCloudUrl`. */
  openCloudHost?: string;
  user: string;
  appToken: string;
  /** Base URL of Apache Tika, used to read PDFs and office documents; without it only text files are read. */
  tikaUrl?: string;
  /** Bearer token the MCP clients must send. */
  mcpToken: string;
  host: string;
  port: number;
  /** Characters of text returned by one read. */
  readMaxChars: number;
  /** Largest file that is downloaded to be read. */
  downloadMaxBytes: number;
}>;

export class ConfigError extends Error {}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ConfigError(`Missing environment variable ${name}`);
  return value;
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigError(`Invalid environment variable ${name}: expected an http(s) URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`Invalid environment variable ${name}: expected an http(s) URL`);
  }
  return url.toString().replace(/\/+$/, '');
}

function integer(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigError(`Invalid environment variable ${name}: expected an integer of at least ${minimum}`);
  }
  return value;
}

export function readConfig(environment: NodeJS.ProcessEnv): Config {
  const tika = environment.TIKA_URL?.trim();
  const host = environment.OPENCLOUD_HOST?.trim();
  return {
    openCloudUrl: httpUrl('OPENCLOUD_URL', required(environment, 'OPENCLOUD_URL')),
    ...(host ? { openCloudHost: host } : {}),
    user: required(environment, 'OPENCLOUD_USER'),
    appToken: required(environment, 'OPENCLOUD_APP_TOKEN'),
    ...(tika ? { tikaUrl: httpUrl('TIKA_URL', tika) } : {}),
    mcpToken: required(environment, 'MCP_TOKEN'),
    host: environment.HTTP_HOST?.trim() || '0.0.0.0',
    port: integer(environment, 'HTTP_PORT', 3000, 1),
    readMaxChars: integer(environment, 'READ_MAX_CHARS', 8000, 500),
    downloadMaxBytes: integer(environment, 'DOWNLOAD_MAX_BYTES', 20 * 1024 * 1024, 1024),
  };
}
