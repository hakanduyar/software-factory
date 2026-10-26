const MAX_BYTES = 65536;

export function decodeTelegramImportJsonBytes(bytes: Uint8Array): { readonly raw: string; readonly value: unknown } {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(raw);
    return { raw, value };
  } catch {
    throw new Error('Telegram import failed.');
  }
}
