import type { CoinPayClient } from './client.js';
import type { CoinPayDocument, UnlockedVault } from './documents.js';

export interface PublishEntry {
  abs: string;
  rel: string;
  size: number;
  filename: string;
  folder: string | null;
  sha256?: string;
  action: 'upload' | 'version' | 'unchanged' | 'locked' | 'too_large' | 'empty';
  documentId?: string;
  version?: number;
  result?: 'ok' | 'failed';
  error?: string;
}

export interface PublishResult {
  plan: PublishEntry[];
  skippedHidden: number;
  folder: string | null;
}

export function walkDirectory(dir: string, opts?: { includeHidden?: boolean }): Promise<{ files: { abs: string; rel: string; size: number }[]; skipped: number }>;
export function planPublish(local: Omit<PublishEntry, 'action'>[], remote: Pick<CoinPayDocument, 'id' | 'folder' | 'filename' | 'sha256' | 'status' | 'signed'>[]): PublishEntry[];
export function publishDirectory(
  client: CoinPayClient,
  opts: { businessId: string; vault?: UnlockedVault; dir: string; folder?: string; includeHidden?: boolean; dryRun?: boolean; concurrency?: number; onFile?: (entry: PublishEntry) => void }
): Promise<PublishResult>;
