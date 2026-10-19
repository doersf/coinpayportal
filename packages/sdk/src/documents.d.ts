import type { CoinPayClient } from './client.js';

export interface CoinPayDocument {
  id: string;
  business_id: string;
  title: string;
  message: string | null;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  wrapped_key: string;
  vault_version: number;
  status: 'draft' | 'shared' | 'out_for_signature' | 'completed' | 'declined' | 'voided';
  signed_sha256: string | null;
  signed_bytes: number | null;
  completed_at: string | null;
  voided_at: string | null;
  created_at: string;
  signers?: number;
  signed?: number;
  viewers?: number;
}

export interface DocumentRecipient {
  id: string;
  name: string;
  email: string;
  role: 'signer' | 'viewer';
  status: 'pending' | 'viewed' | 'signed' | 'declined';
  signed_at: string | null;
  signature_name: string | null;
  revoked_at: string | null;
  /** The link without the key (server copy). */
  url?: string;
  /** The link with `#k=<key>`, when the vault was unlocked. Hand it over yourself. */
  link?: string | null;
}

export interface DocumentVault {
  version: number;
  kdf_salt: string;
  kdf_iterations: number;
  wrapped_key: string;
  created_at: string;
}

export interface UnlockedVault {
  vaultKey: Uint8Array;
  version: number;
}

export function listDocuments(client: CoinPayClient, opts?: { businessId?: string; status?: string }): Promise<CoinPayDocument[]>;
export function getDocument(client: CoinPayClient, documentId: string): Promise<{ document: CoinPayDocument & { signed_available: boolean }; recipients: DocumentRecipient[]; events: unknown[]; certificate: unknown }>;
export function listDocumentVaults(client: CoinPayClient, opts?: { businessId?: string }): Promise<DocumentVault[]>;
export function setupDocumentsVault(client: CoinPayClient, opts: { businessId: string; passphrase: string }): Promise<UnlockedVault>;
export function unlockDocumentsVault(client: CoinPayClient, opts: { businessId: string; passphrase: string }): Promise<UnlockedVault>;
export function uploadDocument(client: CoinPayClient, opts: { businessId: string; vault: UnlockedVault; bytes: Uint8Array; filename: string; title?: string; message?: string }): Promise<CoinPayDocument>;
export function shareDocument(
  client: CoinPayClient,
  documentId: string,
  opts: { recipients: { name: string; email: string; role?: 'signer' | 'viewer'; expires_in_days?: number }[]; message?: string | null; sendEmail?: boolean; emailKey?: boolean; vault?: UnlockedVault }
): Promise<{ status: string; recipients: DocumentRecipient[] }>;
export function newDocumentLink(client: CoinPayClient, documentId: string, recipientId: string, opts?: { sendEmail?: boolean; emailKey?: boolean; vault?: UnlockedVault }): Promise<{ url: string; link: string | null }>;
export function revokeDocumentRecipient(client: CoinPayClient, documentId: string, recipientId: string): Promise<{ status: string }>;
export function voidDocument(client: CoinPayClient, documentId: string, opts?: { reason?: string }): Promise<unknown>;
export function deleteDocument(client: CoinPayClient, documentId: string): Promise<unknown>;
export function downloadDocument(client: CoinPayClient, documentId: string, opts: { version?: 'original' | 'signed'; vault: UnlockedVault }): Promise<{ bytes: Uint8Array; filename: string; document: CoinPayDocument }>;
