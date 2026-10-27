/**
 * Server-side event publication. In AWS this posts to the AppSync Events HTTP
 * endpoint signed with the Lambda's IAM role (clients cannot publish to the
 * game namespace). Locally it hands events to the in-process WebSocket hub.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ServerConfig } from '../config';

export interface Publisher {
  publish(channel: string, events: unknown[]): Promise<void>;
}

export class AppSyncEventsPublisher implements Publisher {
  private readonly signer: SignatureV4;
  private readonly url: URL;

  constructor(cfg: { httpEndpoint: string; region: string }) {
    this.url = new URL(cfg.httpEndpoint.startsWith('http') ? cfg.httpEndpoint : `https://${cfg.httpEndpoint}/event`);
    this.signer = new SignatureV4({ service: 'appsync', region: cfg.region, credentials: fromNodeProviderChain(), sha256: Sha256 });
  }

  async publish(channel: string, events: unknown[]): Promise<void> {
    // AppSync Events accepts at most 5 events per publish request.
    for (let i = 0; i < events.length; i += 5) {
      const body = JSON.stringify({ channel, events: events.slice(i, i + 5).map((e) => JSON.stringify(e)) });
      const signed = await this.signer.sign({
        method: 'POST',
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        path: this.url.pathname,
        headers: { host: this.url.hostname, 'content-type': 'application/json' },
        body,
      });
      const res = await fetch(this.url, { method: 'POST', headers: signed.headers as Record<string, string>, body });
      if (!res.ok) throw new Error(`AppSync publish failed with HTTP ${res.status}`);
    }
  }
}

export function createPublisher(cfg: ServerConfig['realtime'], local?: Publisher): Publisher {
  if (cfg.mode === 'appsync') return new AppSyncEventsPublisher(cfg);
  if (!local) throw new Error('Local realtime mode requires a local publisher');
  return local;
}
