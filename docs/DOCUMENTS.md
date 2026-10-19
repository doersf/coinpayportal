# Documents and e-signatures

Upload a document, share it by private link, and collect electronic signatures.
Documents are **end-to-end encrypted**: the browser (or the `coinpay` CLI)
encrypts every file before upload, so CoinPay stores only ciphertext and cannot
read a document's contents.

## Keys

| Key | What it is | Where it lives |
| --- | --- | --- |
| Passphrase | Chosen by a business admin | Only in people's heads. Lost = documents unrecoverable |
| Vault key (VK) | Random 256-bit key per business | `document_vaults.wrapped_key`, sealed under PBKDF2-SHA256(passphrase, 600k) |
| Document key (DK) | Random 256-bit key per document | `documents.wrapped_key`, sealed under VK; and in each recipient's link after `#k=` |

Every blob is `0x01 || IV(12) || AES-256-GCM(ciphertext+tag)` with a purpose
label as AAD (`coinpay-doc:original:<id>`, `:signed:`, `:dk:<business>`,
`:vk:<business>`), so one kind of blob cannot stand in for another. The browser
implementation is `src/lib/documents/e2e.ts`; the CLI's is
`packages/sdk/src/documents.js`; `src/lib/documents/interop.test.ts` keeps them
byte-compatible.

Vault versions are append-only: changing the passphrase adds a version wrapping
the same VK, and nothing can replace an existing version, so a mistake or a
malicious admin cannot make existing documents unreadable. Creating or adding a
vault version needs `settings.manage`.

## What the server does see

Titles, filenames, file types and sizes, the message to recipients, who a
document went to, and the audit trail (who opened, consented, signed, from which
IP and device). It needs these to send emails and keep the signing record.

## Flow

1. **Vault.** The first visit to `/documents` asks an admin to set the
   passphrase; later visits unlock it. Keys are kept in page memory only.
2. **Upload.** The browser picks the document id (it is bound into the
   ciphertext), encrypts the file under a fresh DK, wraps DK under VK and posts
   `multipart: meta + file` to `POST /api/documents`. Up to 9 MB (the Next proxy
   buffers bodies up to 10 MB). Any file type; PDF, PNG, JPEG, TXT, MD and CSV preview in the page.
3. **Share.** `POST /api/documents/<id>/recipients` adds signers and viewers.
   The server stores only `sha256(token)`; it returns each link once and the
   browser appends `#k=<DK>` before showing it. **By default the invite email
   does not contain the key**: the sender passes each full link on another
   channel. Ticking "put the key in the email" sends `email_document_key`, used
   once to build the email link and never stored (the mail path can then read it).
4. **Sign.** `/sign/<token>#k=...` decrypts in the browser and checks the
   plaintext sha256 against the upload. Signing posts the typed name, an
   optional drawn signature (PNG), consent to sign electronically (ESIGN/UETA),
   and that sha256; the server refuses a signature whose hash does not match.
   A signer can decline with a reason, which ends the document.
5. **Complete.** When the last live signer signs, the document becomes
   `completed` (one conditional update, so concurrent signers complete it once)
   and everyone is emailed. The server cannot build the signed copy, so the
   first signer's (or the owner's) browser builds it with pdf-lib: the original
   stamped with the document id on every page plus a certificate of completion
   (signers, signatures, times, IPs, devices, original sha256, audit trail).
   Non-PDF originals become a page (images) or an embedded attachment. It is
   sealed under DK and uploaded; the first upload wins. Only signers and the
   owner may seal, each seal is audited, and the owner can **Rebuild** it.

## Folders and directory uploads

Documents can live in folders (`documents.folder`, e.g. `contracts/2026/acme`;
null is the top level). The web page uploads many files at once, a whole
folder (folder picker or drag and drop, recursively), each file encrypted
under its own key, three at a time, and shows them as a folding tree with
search. Folder names, like filenames, are visible to the server. Any file
type is accepted; types the page cannot preview are offered as downloads.
Hidden files (`.git`, `.DS_Store`) and `node_modules` are left out unless
asked. `PATCH /api/documents/<id> {action:"move", folder}` refiles one.

`coinpay document publish <dir> --business-id <id>` does the same from a
terminal and is a sync: new files are uploaded, changed files (by sha256)
become a new version of the document at the same folder and filename,
unchanged files are skipped, documents with signatures (or completed,
declined, voided) are left alone, and nothing remote is ever deleted.
`--dry-run` prints the plan; `--folder dest` (or `/`) picks the destination.

## Roles and history

Invites carry a role:

| Role | Can |
| --- | --- |
| Can view (`viewer`) | Open, download, see the history |
| Can edit (`editor`) | Also upload new versions from their link |
| Needs to sign (`signer`) | Open and sign (or decline) the current version |

Every upload is kept as a version (`document_versions`), sealed under the same
document key with the number in the AAD (`coinpay-doc:original:<id>:v<n>`;
version 1 keeps the original label), so existing links open every version and
a server that serves one version as another is caught. `documents` mirrors the
current version, which is what signers see and sign. A new version is refused
once anyone has signed, so a signature always binds to the bytes its signer
saw; to change a signed document, void it and upload a new one. An editor's
upload emails the owner.

Statuses: `draft` → `shared` (viewers only) / `out_for_signature` →
`completed`, or `declined` / `voided`.

## API

| Route | Who | |
| --- | --- | --- |
| `GET/POST /api/documents/vault` | business.read / settings.manage | Vault versions; add one |
| `GET /api/documents?business_id=` | business.read | List with signing progress |
| `POST /api/documents` | invoice.write | Upload (sealed) |
| `GET /api/documents/<id>` | business.read | Document, recipients, audit trail, certificate data |
| `PATCH /api/documents/<id>` | invoice.write | `rename` or `void` |
| `DELETE /api/documents/<id>` | invoice.write (completed: business.update) | Remove with files |
| `GET/POST /api/documents/<id>/file` | business.read / invoice.write | Sealed bytes; upload signed copy (`?replace=1`) |
| `GET/POST /api/documents/<id>/versions` | business.read / invoice.write | History; upload the next version |
| `POST /api/sign/<token>/versions` | editor link | Upload the next version |
| `POST /api/documents/<id>/recipients` | invoice.write | Share (roles: signer, editor, viewer) |
| `POST/DELETE /api/documents/<id>/recipients/<rid>` | invoice.write | New link / revoke |
| `GET/POST /api/sign/<token>` | link | View; `sign` or `decline` |
| `GET/POST /api/sign/<token>/file` | link | Sealed bytes; seal the signed copy (signers) |

## CLI and MCP

`coinpay document vault-setup|list|upload|publish|move|share|get|versions|new-version|link|revoke|download|void|delete`
(`share --signers/--editors/--viewers`, `download --revision N`).
The passphrase comes from `COINPAY_DOCUMENTS_PASSPHRASE` or a hidden prompt;
`share` prints each full link. MCP has `document_list`, `document_get` and
`document_void`, which see metadata only: an agent never gets the passphrase.

Tables: `document_vaults`, `documents`, `document_recipients`, `document_events`
(migration `20261019120000_documents_esign.sql`) and `document_versions`
(`20261019130000_documents_versions_editors.sql`), and `documents.folder`
(`20261019150000_documents_folders.sql`). Files: object kind `signing`
on the files volume, additionally encrypted at rest like finance documents.
