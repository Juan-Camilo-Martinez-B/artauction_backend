import { identityV1 } from '@artauction/contracts';
import { invoke } from './invoke';

const REFRESH_MARGIN_MS = 30_000;

/**
 * Obtiene y cachea el token de servicio (OAuth2 client credentials) que un
 * microservicio presenta al llamar RPC internas de otros servicios. Las
 * peticiones concurrentes comparten una sola solicitud a identity.
 */
export class ServiceTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly identity: identityV1.IdentityServiceClient,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly clock: () => number = Date.now,
  ) {}

  async authorization(): Promise<string> {
    return `Bearer ${await this.token()}`;
  }

  token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > this.clock()) {
      return Promise.resolve(this.cached.token);
    }
    this.pending ??= this.fetch().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetch(): Promise<string> {
    const response = await invoke(
      this.identity.issueServiceToken.bind(this.identity),
      identityV1.IssueServiceTokenRequest.fromPartial({ clientId: this.clientId, clientSecret: this.clientSecret }),
      { deadlineMs: 3_000 },
    );
    this.cached = {
      token: response.accessToken,
      expiresAt: this.clock() + response.expiresInSeconds * 1000,
    };
    return response.accessToken;
  }
}
