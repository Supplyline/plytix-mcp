
import 'dotenv/config';

type FetchInit = RequestInit & { retry?: boolean };

export interface PlytixProduct {
  id: string;
  sku?: string;
  attributes?: Record<string, any>;
  replaces?: string[];
  includes?: string[];
  modules?: string[];
  has_optional_accessory?: string[];
}

export class PlytixClient {
  private token: string | null = null;
  private tokenExp = 0;

  private readonly apiKey = process.env.PLYTIX_API_KEY ?? "";
  private readonly apiPassword = process.env.PLYTIX_API_PASSWORD ?? "";
  private readonly base = process.env.PLYTIX_API_BASE ?? "https://pim.plytix.com";
  private readonly authUrl = process.env.PLYTIX_AUTH_URL ?? "https://auth.plytix.com/auth/api/get-token";

  constructor() {
    if (!this.apiKey || !this.apiPassword) {
      throw new Error("Missing PLYTIX_API_KEY or PLYTIX_API_PASSWORD");
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    // 60s skew
    if (this.token && now < this.tokenExp - 60_000) return this.token!;

    const r = await fetch(this.authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, api_password: this.apiPassword }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Auth failed: HTTP ${r.status} - ${body}`);
    }
    const j: any = await r.json();
    const newToken = j?.data?.[0]?.access_token;
    if (!newToken) throw new Error("Auth response missing access_token");
    this.token = newToken;
    // Official TTL is ~15 minutes; cache for ~14 minutes.
    this.tokenExp = now + 14 * 60_000;
    return this.token!;
  }

  async call<T = unknown>(path: string, init: FetchInit = {}): Promise<T> {
    const token = await this.getToken();
    const url = path.startsWith("http") ? path : `${this.base}${path}`;

    const r = await fetch(url, {
      ...init,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (r.status === 401 && !init.retry) {
      // Token probably expired: clear and retry once
      this.token = null;
      this.tokenExp = 0;
      return this.call<T>(path, { ...init, retry: true });
    }

    if (r.status === 204) return {} as T;
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text}`);
    }
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return (await r.json()) as T;
    } else {
      // Fallback for non-json bodies (unlikely here)
      return (await r.text()) as unknown as T;
    }
  }

  async getProductById(id: string): Promise<PlytixProduct> {
    return this.call(`/api/v2/products/${encodeURIComponent(id)}`);
  }

  async getProductsByIds(ids: string[]): Promise<PlytixProduct[]> {
    const unique = Array.from(new Set(ids));
    return Promise.all(unique.map((id) => this.getProductById(id)));
  }

  async getProductBySku(sku: string): Promise<PlytixProduct | null> {
    try {
      return await this.call(`/api/v2/products/sku/${encodeURIComponent(sku)}`);
    } catch {
      return null;
    }
  }

  async getProductsBySkus(skus: string[]): Promise<PlytixProduct[]> {
    const unique = Array.from(new Set(skus));
    const results = await Promise.all(unique.map((s) => this.getProductBySku(s)));
    return results.filter((p): p is PlytixProduct => !!p);
  }
}
