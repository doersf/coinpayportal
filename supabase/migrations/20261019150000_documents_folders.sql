-- Folders for documents: a whole directory can be uploaded (browser folder
-- picker, drag and drop, or `coinpay document publish <dir>`) and keeps its
-- structure. Like the filename, the folder path is metadata the server sees;
-- file contents stay end-to-end encrypted.
--
-- Normalized by the app (src/lib/documents/types.ts normalizeFolder): segments
-- joined by '/', no leading or trailing slash, no '.' or '..'; null = top level.

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS folder text
  CHECK (folder IS NULL OR (length(folder) BETWEEN 1 AND 1000 AND folder !~ '(^/|/$|//|(^|/)\.\.?(/|$))'));
CREATE INDEX IF NOT EXISTS idx_documents_business_folder ON public.documents(business_id, folder);

ALTER TABLE public.document_events DROP CONSTRAINT IF EXISTS document_events_event_check;
ALTER TABLE public.document_events ADD CONSTRAINT document_events_event_check CHECK (event IN (
  'uploaded', 'shared', 'resent', 'revoked', 'viewed', 'downloaded',
  'consented', 'signed', 'declined', 'completed', 'sealed', 'voided', 'renamed', 'version_added', 'moved'
));

NOTIFY pgrst, 'reload schema';
