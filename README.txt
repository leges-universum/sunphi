SUNPHI WALLET — EXACT PACKAGED APPLICATION SOURCE
This release tag identifies the application files inside the downloadable Windows preview. It does not modify main.
The Electron runtime is distributed in the ZIP and is not included in this source tree.

SUNPHI WALLET — USER GUIDE & RELEASE LIMITATIONS
Applies to Wallet 0.4.7 for Windows x64
Guide revised: 13 October 2026
Reference: SPHI STD 001, Edition 1.1 RC3, with Addendum A1

1. WHAT THIS RELEASE DOES

SunPhi provides a token standard and supporting technology. Under that standard,
the identified banks and financial institutions remain responsible for their
products, obligations and financial decisions. A token's profile, issuer,
programme, instrument and terms determine the right it represents.

Wallet 0.4.7 is a local demonstration of selected holder workflows. It uses eight
test positions across six profiles and two fictional institutions. It does not
connect to a live bank, production token network or real financial account.
Use test data only. No real money or enforceable financial claim is created.

The wallet lets you inspect holdings, move or exchange eligible test tokens,
send them to another registered local wallet, review exact terms and follow
outcomes in History. It is not a certificate of conformity to the standard.
This guide explains the current customer interface, not earlier release changes.

2. DOWNLOAD AND OPEN

Download from https://coin.sun-phi.com/#/wallet.
Check the version, release link and SHA-256 shown there. Extract the COMPLETE
ZIP into a folder; do not run the application from inside the archive.
Close an older running wallet, then open SunPhi Wallet.exe in the new folder.
Keep the accompanying runtime files and folders together. Node.js is not needed.

This portable Windows build is not digitally signed by its publisher. Windows
may show an unknown-publisher warning. A matching checksum identifies the
downloaded bytes; it does not substitute for publisher signing or a security audit.
There is no automatic updater. Keep your wallet file and backup when replacing
the application folder. This guide update does not require a new application ZIP.

3. SIGN IN, CREATE OR RESTORE

Open existing
Choose your encrypted wallet file before entering its password. Check the
displayed filename and folder. After a successful open, creation or restore,
the last wallet is preselected at the next launch or after locking. Enter its
password or choose another file. If it has moved, use Locate wallet file.
Only the path is remembered; the password is not saved.

Create new
Enter a wallet name and a unique password of at least 12 characters, confirm
the password, then choose a new filename. Use a strong passphrase rather than
relying on length alone. The eye button inside each password field shows or
hides its contents.

Restore backup
Select the encrypted backup, enter its password, then choose a new destination
for the restored wallet. The original backup is preserved. Both the backup
and its password are required; there is no password-reset service.

After opening, use Security to save an encrypted backup. To initialise this
wallet's test assets, choose Start demonstration in Overview. This is a local
demonstration setup, not registration with a financial institution.

4. FIND YOUR WAY AROUND

Overview
Start the demonstration, refresh balances and status, or open the main tasks.

Holdings
See each asset's issuer and available token quantity. Reserved, pending receipt,
disputed, encumbered, retired and income quantities are shown separately.
Available operations opens actions for that asset. Use these tokens shows
outgoing actions; Add tokens to this product shows supported incoming exchanges
or moves from your other products. Issuer & terms expands the issuer's role,
the financial-right description and identifying terms.

Transfers & exchanges
Choose Between my products, Send to a recipient or Receive. Holdings can open
the appropriate form with the asset and operation already selected.

History
See sent and received transfers and own-product exchanges, newest first,
with dates, token quantities, counterparties where relevant and status.
Search entries and use Check status when confirmation needs attention.
Outgoing operations can be expanded through Evidence timeline.
Export evidence package in Overview or History saves signed records without
private keys. The export may contain wallet addresses and transaction details;
review it before sharing.

Support
Save a local support draft with an operation reference, category and description.
It stays inside the encrypted wallet. No support request or email is sent.
Do not include passwords or private keys.

Security
Save an encrypted backup, change the wallet password and read About this preview.
Back returns to the previous screen; Wallet overview returns to Overview.
There are no separate Institutions or Approvals pages. Issuer information is
in Holdings, and confirmation is part of the transfer. Technical laboratories
and file-signing tools are not tasks in the customer interface.

5. TOKEN QUANTITIES AND BASKET ESTIMATES

Enter payment amounts as quantities of the selected token, for example
100.00 sun(phi) Pi. The phi mark and profile identify a family; the issuer,
programme and instrument distinguish the actual asset.

XDR is the separate currency-basket valuation reference under Addendum A1.
It is not the payment unit, another available asset, or a rule that every
SunPhi token equals one XDR. A Pi token can retain a currency-denominated
deposit right while its basket estimate is shown in XDR. Changing a valuation
does not change token quantities or the underlying contractual right.

Current estimates use fixed, dated demonstration inputs based on the XDR
reference basket of USD, EUR, CNY, JPY and GBP. They are not live FX, NAV or
executable market quotes. Gr uses a receivable face reference; Ma uses a
contingent face reference. The guarantee is not a spendable payment balance.
Compare the source and destination token quantities and terms in the review,
rather than treating an indicative basket estimate as an exchange promise.

Only available tokens can be used. Reserved and pending receipts are excluded.
A stale balance must be refreshed. The wallet explains unavailable operations;
absence of an own-product exchange does not necessarily prevent an eligible
transfer to another holder. Recipient compatibility is checked separately.

6. MOVE OR EXCHANGE BETWEEN YOUR PRODUCTS

1. Open Holdings > Available operations, or Transfers & exchanges >
   Between my products.
2. Select the source asset and a supported destination operation.
3. Check the available balance and the From/To asset and issuer details.
4. Enter the token quantity. The field shows the required unit and precision.
5. Choose Review rights & instruction.
6. Check both token quantities, issuers, rights, fees, quote validity and terms.
   Close the review to edit. To proceed, select the consent checkbox and choose
   Confirm demo transfer.
7. Follow the original operation in History.

Six own-product directions are implemented:
- Pi treasury deposit -> Pi payment-service deposit at the same institution.
- Pi treasury deposit -> Pi deposit at the other test institution.
- Pi -> Go payment instrument.
- Vi -> Pi deposit token.
- Pi -> Bl fund units.
- Pi -> Gr receivable tokens.

These directions are not automatically reversible. The wallet offers the
supported choices. A change of issuer or product may change the financial
right; common token technology does not make the two obligations identical.

7. SEND TO A RECIPIENT

1. Choose Transfers & exchanges > Send to a recipient, or use that action
   in the asset's Holdings card.
2. Select the asset and check Available to transfer.
3. Enter the recipient wallet address. This field is mandatory.
4. Choose Check recipient. Check the returned address and label, then select
   a compatible Receiving product. A test wallet label is not verified identity.
5. Enter Tokens to send. Payment purpose is optional.
6. Choose Review transfer. Check the recipient, source and destination assets,
   token quantities, purpose, fees and terms; then confirm the exact proposal.
7. Open History to follow the result. Do not submit the same payment again
   because a response is delayed.

This release supports eligible same-instrument recipient transfers for Vi, Pi,
Go, Bl and Gr, plus the configured Asterwell-Pi to Brookfield-Pi replacement.
Ma guarantees cannot be sent or spent as payment tokens. An address alone
does not make every product or destination eligible.

8. RECEIVE AND FOLLOW CONFIRMATION

Both test wallets must first start the demonstration on the same computer,
under the same application data environment. For a second wallet, lock the
current wallet, create or open the other file and start its demonstration.
Open Transfers & exchanges > Receive and use Copy wallet address.
The address begins with sunphi_lab1_. Give that address to the sender; do not
share the wallet file or password. Reopen the sender wallet to prepare a transfer.

An accepted recipient instruction first reserves the sender's tokens and
records an incoming pending amount. Pending tokens cannot be spent.
Status updates while the wallet is unlocked; reopening or Check status obtains
the current result. If confirmation has already completed, the recipient may
see Completed immediately rather than observing the intermediate pending state.

Credit follows verified confirmation records, without an artificial waiting
period. There is no promised number of seconds. Missing confirmation leaves
the amount pending; a failed check can require recovery. Keep the original
reference and use History. A delayed or missing response is not proof that
the transfer failed.

All confirmations in this build come from the local demonstration adapter.
This is not an independently operated validator network or external settlement.
Wallets on other computers and real institutional transfers are not connected.

9. BACKUP, UPDATES AND SECURITY

The holder key and local workspace are encrypted using AES-256-GCM, with scrypt
password derivation and Ed25519 holder signatures. The interface is sandboxed
and isolated from the main process. These controls do not protect an unlocked
wallet against complete compromise of its computer.

The wallet locks after five minutes without a wallet operation and on system
sleep or screen lock. Background status refresh does not extend that interval.
Locking drops secret references; complete memory erasure is not guaranteed.

Save backups to a separate protected location and keep their passwords safely.
Changing the active wallet password does not invalidate older backups or their
passwords. Losing both access to a usable file and its password has no automatic
recovery path in this release.

Demo institution records are stored separately in this computer's application
data. Restoring only the wallet file does not restore that journal. Do not delete
application data when replacing the portable folder. Moving the executable or
copying a wallet backup to another computer is not a complete migration.
The first demonstration connection also saves an encrypted pre-upgrade copy
beside an existing wallet file. Use the current release for updated files;
do not open them with an older build. Historical signed records remain unchanged.

The build has no publisher signature, hardware-backed signing, independent
transaction approval or automatic update channel. It has not completed an
independent security audit or production qualification. Local test signing keys
and the demo journal are controlled on the same host; they do not provide
protection against whole-host rollback or a compromised host.

10. THE STANDARD AND PRODUCTION ADMISSION

SPHI STD 001 1.1 RC3 Chapters 37-39 define connected procedures for issuance,
placement and sale, transfer of rights, transitions between products and
institutions, settlement, recovery, legal gates and SunPhi service duties.
Addendum A1 specifies token quantities, separate XDR valuation and explicit
unit migration. Adopting the identified edition and A1 requires express agreement;
downloading software does not amend an institution's existing contracts.

In production, participating institutions retain responsibility for financial
products, issuer obligations, eligibility, executable prices and legal approvals.
SunPhi performs the technology services assigned to its actual permitted role.
The applicable law and admitted programme determine ownership, settlement and
remedies. A wallet signature or a Completed label alone cannot establish a
legal event requiring registration, notice, consent or external payment.

Each programme and direction requires its own institutional and territorial
approval. The standard does not grant licences, deposit insurance, statutory
finality or a global right to offer products. The institution must complete
the required identity, authority, country and product checks.

RC3 requires verification of the applicable ledger, institutional and
external-settlement evidence before pending tokens become available, with no
mandatory waiting period after all conditions are satisfied. The local
confirmation records in this preview do not implement that production network.

11. RELEASE LIMITATIONS

Available now: the holder workflows and local demonstration described above.
Six profiles are represented; this is not full implementation of all lifecycles.

Not available in the customer release:
- Real issuance, primary subscription/placement, sale proceeds, cash funding
  or redemption/payout to an external financial account.
- Guarantee claims, corporate maker/checker approvals or standing mandates.
- Live institution connections, independent validator consensus, production
  identity/sanctions checks, institutional key revocation or live price feeds.
- Automatic restoration of institutional rights, submitted support cases,
  publisher-signed installation, automatic updates or macOS/Linux packages.

Production requires qualified institutional connectors and signing authorities,
applicable legal schedules, authoritative register/settlement evidence,
reconciliation, security review, operational support and qualification of the
actual build, profiles and routes. Displaying a procedure state does not certify
that these requirements have been met.

Storage limits: encrypted wallet file up to 4 MiB; up to 150 outgoing procedure
instructions and 50 local support drafts. The file limit can be reached earlier.
There is no production-scale history service or automatic journal archival.

12. REFERENCES AND RELEASE IDENTITY

Standard and Addendum A1:
https://coin.sun-phi.com/#/standard
Base English text:
https://coin.sun-phi.com/standard/SunPhi_Standard_1_1_RC3_EN.txt
Addendum A1:
https://coin.sun-phi.com/standard/SunPhi_Standard_1_1_RC3_A1_EN.txt

Download page: https://coin.sun-phi.com/#/wallet

Version 0.4.7 improves light-theme contrast: grey cards and layered panels remain
clearly separate from the white page background, amount surfaces and input fields.
Current release and ZIP SHA-256: https://coin.sun-phi.com/standard/wallet-release.json


