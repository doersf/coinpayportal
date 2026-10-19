-- Document history and editors.
--
-- Every upload of a document is kept as a version, sealed under the same
-- document key (so links keep working) with the version number in the AAD.
-- `documents` mirrors the current version's file fields, which is what
-- signers sign. A new version is refused once anyone has signed, so a
-- signature always binds to the bytes its signer saw.
--
-- Recipients can now be editors: they open the document and upload new
-- versions from their link, without signing it.

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1);

CREATE TABLE IF NOT EXISTS public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) <= 128),
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  -- Who uploaded it: the owner's email or the editor's.
  uploaded_by text CHECK (uploaded_by IS NULL OR length(uploaded_by) <= 400),
  recipient_id uuid REFERENCES public.document_recipients(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

-- Version 1 of every existing document.
INSERT INTO public.document_versions (document_id, business_id, version, filename, content_type, bytes, sha256, object_key, created_at)
SELECT d.id, d.business_id, 1, d.filename, d.content_type, d.bytes, d.sha256, d.object_key, d.created_at
FROM public.documents d
ON CONFLICT (document_id, version) DO NOTHING;

ALTER TABLE public.document_recipients DROP CONSTRAINT IF EXISTS document_recipients_role_check;
ALTER TABLE public.document_recipients ADD CONSTRAINT document_recipients_role_check CHECK (role IN ('signer', 'viewer', 'editor'));

ALTER TABLE public.document_events DROP CONSTRAINT IF EXISTS document_events_event_check;
ALTER TABLE public.document_events ADD CONSTRAINT document_events_event_check CHECK (event IN (
  'uploaded', 'shared', 'resent', 'revoked', 'viewed', 'downloaded',
  'consented', 'signed', 'declined', 'completed', 'sealed', 'voided', 'renamed', 'version_added'
));

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.document_versions TO service_role;

NOTIFY pgrst, 'reload schema';
