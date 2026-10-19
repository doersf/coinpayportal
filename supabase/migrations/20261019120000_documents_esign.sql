-- Documents: upload a file, share it by private link, and collect electronic
-- signatures (DocuSign/Dropbox Sign shape, on CoinPay).
--
-- End-to-end encrypted: the browser encrypts each file under its own key
-- before upload (src/lib/documents/e2e.ts), so the files volume holds only
-- ciphertext and CoinPay never sees a document's contents. The business keeps
-- each document key wrapped under its vault key, which is wrapped under a key
-- derived from the documents passphrase; recipients get the document key in
-- the link fragment, which never reaches the server.
--
-- What the server does see: titles, filenames, who a document went to, and
-- the signature audit trail, because it sends the emails and keeps the record.
-- A recipient's link token is a credential, so only its sha256 is stored.

-- One row per passphrase wrapping of the vault key. Append-only: a passphrase
-- change adds a version wrapping the same key, so a mistaken or malicious
-- replacement can never make existing documents unreadable.
CREATE TABLE IF NOT EXISTS public.document_vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  kdf_salt text NOT NULL CHECK (kdf_salt ~ '^[A-Za-z0-9_-]{16,64}$'),
  kdf_iterations integer NOT NULL CHECK (kdf_iterations BETWEEN 100000 AND 10000000),
  wrapped_key text NOT NULL CHECK (wrapped_key ~ '^[A-Za-z0-9_-]{40,200}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, version)
);

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  message text CHECK (message IS NULL OR length(message) <= 2000),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) <= 128),
  -- Plaintext size and sha256, as computed by the uploader's browser. Signers'
  -- browsers recompute the hash after decrypting and sign that value.
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The document key, sealed under the vault key, and which vault wrapped it.
  wrapped_key text NOT NULL CHECK (wrapped_key ~ '^[A-Za-z0-9_-]{40,200}$'),
  vault_version integer NOT NULL,
  object_key text NOT NULL,
  -- draft: nobody has it yet; shared: viewers only; out_for_signature: waiting
  -- on at least one signer; completed: every signer signed.
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'shared', 'out_for_signature', 'completed', 'declined', 'voided')),
  -- The signed copy: the original plus a certificate of completion, built and
  -- encrypted under the same document key by a participant's browser.
  signed_object_key text,
  signed_sha256 text CHECK (signed_sha256 IS NULL OR signed_sha256 ~ '^[0-9a-f]{64}$'),
  signed_bytes integer,
  completed_at timestamptz,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_business ON public.documents(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.document_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 320),
  role text NOT NULL CHECK (role IN ('signer', 'viewer')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'viewed', 'signed', 'declined')),
  sent_at timestamptz,
  viewed_at timestamptz,
  -- Consent to do business electronically (ESIGN/UETA), given before signing.
  consented_at timestamptz,
  signed_at timestamptz,
  signature_name text CHECK (signature_name IS NULL OR length(signature_name) <= 200),
  -- The sha256 of the plaintext the signer's browser decrypted, which must equal documents.sha256.
  signed_document_sha256 text CHECK (signed_document_sha256 IS NULL OR signed_document_sha256 ~ '^[0-9a-f]{64}$'),
  -- A drawn signature as a PNG data URL; typed-only signatures leave it null.
  signature_image text CHECK (signature_image IS NULL OR (signature_image LIKE 'data:image/png;base64,%' AND length(signature_image) <= 400000)),
  signature_ip text,
  signature_user_agent text CHECK (signature_user_agent IS NULL OR length(signature_user_agent) <= 500),
  declined_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) <= 1000),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'signed' OR (role = 'signer' AND signed_at IS NOT NULL AND signature_name IS NOT NULL AND consented_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_document_recipients_document ON public.document_recipients(document_id, created_at);
-- One live entry per person per document; a revoked one can be re-added.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_recipients_email
  ON public.document_recipients(document_id, lower(email)) WHERE revoked_at IS NULL;

-- Append-only: nothing updates or deletes a row except the document's own cascade.
CREATE TABLE IF NOT EXISTS public.document_events (
  id bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES public.document_recipients(id) ON DELETE SET NULL,
  actor text NOT NULL CHECK (actor IN ('owner', 'recipient', 'system')),
  event text NOT NULL CHECK (event IN (
    'uploaded', 'shared', 'resent', 'revoked', 'viewed', 'downloaded',
    'consented', 'signed', 'declined', 'completed', 'sealed', 'voided', 'renamed'
  )),
  actor_label text CHECK (actor_label IS NULL OR length(actor_label) <= 400),
  ip text,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_events_document ON public.document_events(document_id, id);

ALTER TABLE public.document_vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_vaults, public.documents, public.document_recipients, public.document_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.document_vaults TO service_role;
REVOKE ALL ON SEQUENCE public.document_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents, public.document_recipients TO service_role;
GRANT SELECT, INSERT, DELETE ON public.document_events TO service_role;
GRANT USAGE ON SEQUENCE public.document_events_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
