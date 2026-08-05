import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface DemoStoreConfig {
  gatewayUrl: string;
  publicGatewayUrl?: string;
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
  publicBaseUrl?: string;
  log?: (...args: unknown[]) => void;
}

export interface DemoOrder {
  product: { id: string; name: string; priceSats: number };
  invoiceId: string;
  paid: boolean;
}

export interface DemoStore {
  server: Server;
  orders: Map<string, DemoOrder>;
  listen(port: number, host?: string): Promise<AddressInfo | string | null>;
  close(): Promise<void>;
}

export function createDemoStore(config: DemoStoreConfig): DemoStore;
