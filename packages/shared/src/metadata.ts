/**
 * Metadata upload with fallback:
 *   1. Irys (permanent, decentralized) when reachable
 *   2. the marketplace API's /metadata store (self-hosted) otherwise
 *
 * The fallback keeps the PoC running through Irys outages; new uploads
 * return to Irys automatically once it is reachable again.
 */
export interface UploadResult {
  uri: string;
  via: 'irys' | 'marketplace-api';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function uploadMetadata(
  json: unknown,
  options: {
    /** e.g. () => umi.uploader.uploadJson(json) */
    irysUpload?: () => Promise<string>;
    marketplaceUrl: string;
    timeoutMs?: number;
  },
): Promise<UploadResult> {
  let irysError = 'no irys uploader configured';
  if (options.irysUpload) {
    try {
      const uri = await withTimeout(options.irysUpload(), options.timeoutMs ?? 25_000);
      return { uri, via: 'irys' };
    } catch (err: any) {
      irysError = err.message ?? String(err);
      console.warn(`[metadata] irys upload failed (${irysError}); using marketplace API storage`);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${options.marketplaceUrl}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  } catch (err: any) {
    throw new Error(
      `Metadata upload failed on both paths. Irys: ${irysError}. ` +
        `Marketplace API (${options.marketplaceUrl}): ${err.message} — is the API running? (npm run api)`,
    );
  }
  if (!response.ok) {
    throw new Error(`Marketplace API /metadata returned ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { uri: string };
  return { uri: body.uri, via: 'marketplace-api' };
}
