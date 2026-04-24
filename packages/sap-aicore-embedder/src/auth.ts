export interface TokenProviderConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export interface GetTokenOptions {
  forceRefresh?: boolean;
}

/** Refresh the token when less than this many ms remain on it. */
const REFRESH_WINDOW_MS = 60_000;

export class TokenProvider {
  private readonly cfg: TokenProviderConfig;
  private cachedToken: string | null = null;
  private cachedExpiryMs = 0;
  private inFlight: Promise<string> | null = null;

  constructor(cfg: TokenProviderConfig) {
    this.cfg = cfg;
  }

  async getToken(options?: GetTokenOptions): Promise<string> {
    if (
      !options?.forceRefresh &&
      this.cachedToken &&
      Date.now() < this.cachedExpiryMs - REFRESH_WINDOW_MS
    ) {
      return this.cachedToken;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchToken()
      .then((result) => {
        this.cachedToken = result.token;
        this.cachedExpiryMs = Date.now() + result.expiresInMs;
        return result.token;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async fetchToken(): Promise<{ token: string; expiresInMs: number }> {
    const basic = Buffer.from(
      `${this.cfg.clientId}:${this.cfg.clientSecret}`,
    ).toString('base64');
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `SAP AI Core token request failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error('SAP AI Core token response missing access_token');
    }
    return {
      token: body.access_token,
      expiresInMs: (body.expires_in ?? 3600) * 1000,
    };
  }
}
