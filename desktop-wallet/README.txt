SUNPHI WALLET 0.4.5 — PROCEDURE INTEGRATION PREVIEW
SPHI STD 001 1.1 RC3 + A1 | Windows x64 | English interface

SIMPLER NAVIGATION AND INSTITUTIONS IN 0.4.5
The redundant Approvals page is removed. Review and confirm the exact terms
within Transfers & exchanges; follow submitted operations in History.
Institutions shows issuers, roles, your assets and services with direct actions.
Technical route tables, trust fingerprints and sequence numbers are removed.
Only active own-product operations are offered. Balance, guarantee, unavailable
exchange, stale-data and unresolved-transfer limits are explained at selection.

Extract the complete ZIP and open SunPhi Wallet.exe. Keep runtime files beside it.
No Node.js installation is required. This portable build is unsigned and has not
passed independent security certification. Use fictional test data only.

TOKEN PAYMENTS AND BASKET VALUATION SINCE 0.4.0

Both transfer forms show a prominent balance immediately below the selected asset.
Available to transfer is separate from reserved and incoming pending amounts.
Each figure shows the identified token symbol; balances update with asset selection and
verified status refresh. Stale or unresolved records show Last confirmed available.
Choose the source asset first; only its available actions are offered. Plain
language actions name the destination institution and explain the change of rights.
Internal routing codes are kept in technical details. Assets with
no outgoing route are labelled and disabled. The transfer input displays the
source unit beside the amount. From/To cards show
phi, product family, instrument name and issuer/obligor. Phi identifies the token
family; all new payments are entered and confirmed as token quantities.
The separate XDR basket estimate is not a spendable balance. It shows a dated,
fixed demonstration rate, not a live market price. Underlying contractual rights
and denominations remain visible separately. One test token represents one whole
original contractual unit; raw quantities and precision do not change.
Known old test positions receive a signed unit mapping. Old signed receipts retain
their original units. Unknown instrument definitions cannot be relabelled.
Footer links enlarge slightly on hover with no button-background highlight. Changing the route clears the old amount.
The review identifies each instrument and its exact outgoing/incoming unit.
Choose Between my products for own-account moves; choose Send to a recipient
for another holder. Recipient address is required; payment purpose is optional.
Receive shows your address and Copy address. Both test wallets must be registered
on this computer in the same laboratory directory. Remote wallets are not connected.
The sender amount is reserved first. The recipient sees Pending, excluded from
available funds. Automatic status queries obtain signed evidence and credit once
after all checks pass. No artificial confirmation delay is imposed. Missing proof
keeps funds pending; changed terms or routes hold the operation for recovery.
Local signed finality is a simulation, not independent BFT consensus. No production
node or institutional API is connected. Restarts and old wallet backups query the
original instruction; they do not repeat the debit or reverse a confirmed credit.

PASSWORD EYE CONTROLS IN 0.3.7
Every password field has its own eye button inside the field, including
confirmation and password change. The separate Show password button is removed.
Visibility resets when changing file or entry mode, locking, or submitting.

LAST WALLET AND UNFILLED NAVIGATION IN 0.3.6
The last successfully opened, created or restored wallet is preselected after
locking and on the next launch. Filename and folder stay visible; choose another
file at any time. Only its path is stored in this computer's application data.
The password, private keys and balances are not stored in this preference.
If the file moves or becomes unavailable, choose Locate wallet file.
Cancelled selection and incorrect passwords do not replace the last wallet.
Navigation in both themes now uses a coloured underline and coloured icon only,
without a filled tile, including hover and the entry/legacy navigation.

FILE-FIRST SIGN IN FROM 0.3.5
Open existing immediately opens the file picker. Select your wallet, check the
displayed filename and folder, then enter its password and unlock. Choose another
file or Back clears the password. Cancel leaves no selected file. A wrong
password keeps the selected file visible for retry. File paths cannot be supplied
by the page: unlock is bound to the native selection with a one-use selection ID.
Create new uses a wallet name, password and confirmation, then a save location.
Restore backup selects the backup first; after verifying its password, choose a
NEW location for the restored copy. The original backup is not overwritten.
Show/hide password and inline errors are available. No password-reset service
exists. Locking asks for the password of the last wallet; no password is saved.

SIMPLER TRANSFERS FROM 0.3.4
Choose a route and amount, review the terms and confirm the demo transfer.
Artificial failure scenarios are no longer selectable anywhere in the interface.
Failure-injection checks remain in automated developer tests. A delayed reply
still preserves the original reference; Check status never sends another transfer.
Older saved demonstrations with an interrupted destination retain an explicit
Continue saved demo transfer action so those files are not left blocked.
The mode label now says Demonstration mode / Test data. No real money is used.
Version and standard details are available in Security -> About this preview.

VISUAL HIERARCHY FROM 0.3.3
Neutral charcoal layers in dark mode; white and subtle grey surfaces in light
mode. Financial values use bundled IBM Plex Mono (SIL Open Font License).
Amounts, units, headings, instructions and reference details have distinct roles.
Space for screen guidance is measured at the current width so laboratory buttons
do not shift between short and wrapped text. Copy is never truncated.

NAVIGATION FROM 0.3.2
Routine feedback uses a compact top-right notification and disappears after four
seconds. Hover/focus pauses dismissal. Errors and recovery states stay visible.
Back restores the previous section and scroll position. Wallet overview remains
available from every section. Each screen explains its purpose and next step.
Open, create and restore are separate entry modes. Reviews return to editing.
All dropdowns have a dedicated right-hand arrow and keyboard navigation.
Logo underlines span the complete wordmark in both themes.
No financial protocol, key format or migration behaviour changed.

FIRST USE
1. Create a wallet with a NEW filename and a unique password of 12+ characters.
2. Save an encrypted backup from Security; keep the password separately.
3. Overview -> Start demonstration.
4. Holdings shows eight positions across Vi, Pi, Go, Ma, Bl and Gr, attributed to
   two FICTIONAL institutions. Family codes are not interchangeable legal rights.
5. Transfers & exchanges -> select a direction -> enter source amount -> review.
6. Compare source/destination right, obligor, quantity, fees, terms and expiry.
   Check the explicit consent box and confirm the demo transfer.
7. History shows institutional acceptance, reservation, execution decision,
   distinct leg confirmations and completion or recovery under one reference.
8. If confirmation is delayed, use Check status in History. Do not repeat the
   transfer. Signed technical evidence remains available under Evidence timeline.
9. Support can save an encrypted LOCAL DRAFT. No request or email is submitted.

IMPLEMENTED IN THE NEW PROCEDURE LABORATORY
- Exact decimal string/BigInt quantities, 0–12 decimal places; no floating money.
- Instrument/programme/institution identity, financial-right descriptions and terms.
- Separate available, reserved, pending, disputed, encumbered, retired and income
  fields. No total that adds incompatible money, securities and guarantees.
- Six directional routes: Pi service allocation; Pi issuer replacement; Pi/Go,
  Vi/Pi, Pi/Bl and Pi/Gr exchanges. Ma is a non-spendable contingent position.
- Signed time-limited proposal and exact holder authority. Changed proposals
  require new review. Route status, version and balance checked at execution.
- Encrypted durable outbox written before dispatch. Unknown outcomes block new
  instructions. Reconciliation queries original identifiers and signed records.
- Separate local adapter journal survives wallet restore; older wallet history
  does not roll back its test institution records. Partial execution retains the
  source claim/reservation and pending destination until explicit test recovery.
- Public evidence export, transaction search, institution/route inspection.
- Site-aligned Inter typography, original wordmarks and sunflower window icon,
  dark/light surfaces, orange/red accents, custom keyboard-operable dropdowns,
  thin field focus, transparent dark checkbox and stable scrollbar gutter.

SECURITY AND STORAGE
AES-256-GCM encrypted wallet; fixed scrypt settings; Ed25519 holder signatures.
Private holder key stays in the main process, outside the sandboxed renderer.
Renderer has context isolation, no Node.js, no remote scripts or network access.
Allowlisted help buttons open public SUN PHI pages in the system browser.
Automatic lock after five minutes without a wallet operation, sleep/screen lock.
Lock drops secret references; JavaScript cannot guarantee erasure of every copy.

The test adapter and its FICTIONAL institutional keys live separately in the
application user-data directory, procedure-laboratory-v1. They never enter the
holder wallet or public evidence exports. They are locally controlled, not an
independent production trust service. Do not place real institution keys there.
Deleting or rolling back that adapter invalidates the test trust/recovery model;
an encrypted wallet backup alone does not preserve its independent journal.
Keep the existing application data when moving the portable executable.

UPGRADE / BACKUP
0.2.0 encrypted files open in 0.3.1. On the first procedure connection, the wallet
writes an exact encrypted .before-0.3-*.json backup beside the original file.
Opening alone does not add the procedure extension. After extension, use 0.3.1
to open the updated file; old 0.2.0 readers are not compatible with that extension.
Existing files are never overwritten by backup/restore exports. Restore to a new
filename. A password change affects the active file, not older backups.
There is no password-reset service. Both backup and password are necessary.
Institutional entitlement recovery is separate from restoring local credentials.

LEGACY LABORATORY
The developer-only test tools retain historical Rose (now catalogue Pi) issuance,
sale/funding, transfer, cancellation, redemption, simulated payout and income.
Its $1 reference, 2% fee and 5% income are historical fixtures, not standard terms.
Its fictional bank keys remain in the legacy encrypted fixture for compatibility.
File-signing trust/enrolment/consent flows remain in the developer preview only;
no automatic upload.
Legacy issuance/redemption and the new procedure adapter use separate test
ledgers. They must not be interpreted as one integrated production lifecycle.

LIMITS AND REMAINING PRODUCTION WORK
This release is an implementation preview, not a statement of standard compliance.
Six families are represented; not every product lifecycle is executable. New
adapter primary issuance, subscriptions, redemption, guarantee claims, corporate
maker/checker mandates, hardware custody, country admission, sanctions/identity
checks, revocation, live FX/reserve feeds and real payment/CSD/token rails are NOT
implemented. Laboratory legal gates are explicit fictional fixtures only.
Production needs admitted partner institutions, current legal schedules, verified
API/settlement contracts, trust enrolment, revocation and independent qualification.
No real funds, deposit insurance, legally effective rights or bank accounts exist
here. A locally verified signature is not proof of legal ownership or final payment.
A signed installer, automatic updates and macOS/Linux packages are not provided.
Windows EXE distribution remains Electron-based; the application window/favicon
uses the sunflower. No claim of publisher code signing is made.
4 MiB encrypted wallet; 150 procedure transactions maximum (file bound may be
reached earlier); 50 local case drafts; legacy limits remain unchanged.
Large histories need incremental durable storage and paginated institution APIs
before production. No migration to a production server/database is performed.

DEVELOPMENT
npm ci; npm test; npm start; npm run package:win.
PROCEDURE-CONTRACT.txt describes the integration boundary and acceptance gates.
Preview harness creates disposable loopback-only wallets; it is not packaged.
FORM FEEDBACK LANGUAGE
All application field-validation feedback uses English inline messages, independent of the browser or operating-system language. Required fields, formats and numeric limits remain enforced. Recipient address errors explain the expected address and where to copy it.

The historical-name banner has been removed. Its explanation is available under Security > About this preview. Historical signed records remain unchanged.
TECHNICAL TEST NAVIGATION
The customer package does not expose archived test tools, file-signing imports or laboratory navigation. These are available only in the separate developer preview when explicitly enabled by technical staff. Historical records are preserved. Regular transfers use Transfers & exchanges.

TRANSACTION HISTORY
History in the main navigation shows outgoing and incoming transfers and own-product exchanges, newest first, with token quantities, creation/receipt dates and status. Overview links directly to Transaction history. Historical technical test records stay preserved and are accessible in the developer preview.


