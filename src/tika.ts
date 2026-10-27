/** The text of a document, extracted by Apache Tika. */
export async function extractText(tikaUrl: string, bytes: Uint8Array, contentType: string,
  fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${tikaUrl}/tika`, { method: 'PUT', body: new Uint8Array(bytes),
    headers: { accept: 'text/plain; charset=UTF-8', 'content-type': contentType }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Tika failed with HTTP ${response.status}`);
  return response.text();
}
