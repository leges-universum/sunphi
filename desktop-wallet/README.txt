SUNPHI WALLET DESKTOP 0.2.0 — OFFLINE INTEGRATION BUILD

Windows x64. Extract the whole ZIP into a folder and open SunPhi Wallet.exe.
Keep the runtime files beside the executable. Node.js is not required.
This local build is unsigned. It has not passed an independent security audit.
Do not use it to secure real funds or production signing authority.

WHAT IS IMPLEMENTED
- Create/open a password-encrypted Ed25519 signing profile.
- AES-256-GCM authenticated storage, fixed scrypt parameters, encrypted history.
- Local key isolation from the renderer; no private-key export or network access.
- Explicit review before signing or executing a test instruction.
- Automatic lock after five minutes without a wallet operation, sleep/screen lock.
- Exclusive encrypted backups, restore to a new file, password change.
- Issuer trust imported separately with independently confirmed SHA-256 fingerprint.
- Verify/import source-signed sandbox consent and enrolment packages; sign/export
  the approval using the assigned personal key. Signing does not execute payment.
- Persistent fictional deposit lifecycle: issuance, transfer reservation, receipt,
  bank settlement, unknown-result query, cancellation, redemption and bank payout.
- Signed test event journal, replay verification, history and public statement export.
- English interface, graphite/light themes, keyboard focus and review dialog.

FIRST USE
1. Create wallet, choose a NEW file name, and use a unique password (12+ characters).
2. Security & recovery -> Save encrypted backup. Keep password separately.
3. Start test programme from Overview to try fictional deposit operations.
4. Fund 100 units, transfer 25, acknowledge receipt, confirm settlement.
5. Try a lost reply: the sender sees a reservation until Query original outcome.
   Reconciliation reads the original result; it does not create another payment.
6. Redeem from the receiving test holder; confirm the simulated bank payout.
7. Lock and reopen the saved file. Holdings and signed history persist.

INSTITUTION FILE EXCHANGE
Current protocol is integration sandbox only. The institution workflow must assign
the wallet public key to the verified actor. Confirm the trust fingerprint through
an independent channel; never trust a key simply because a proposal contains it.
Import trust, import proposal/challenge, review its full payload, sign, export the
public approval, and submit it through the institution's authenticated workflow.
This build does not submit files automatically or connect to a production bank.
One issuer binding per profile prevents accidental cross-institution signing.

BACKUPS AND LIMITS
Backup includes encrypted key, local test state, trust and signing history.
Password change does not re-encrypt old backups. There is no password reset.
Restoring an old file restores old local information; it cannot reverse a bank's
ledger. The test journal is locally verifiable but cannot detect a complete rollback
to an older valid file without an external checkpoint. Keep the current backup.
Default limits: 4 MiB wallet, 990 test events, 50 imported signing packages.
The JavaScript runtime cannot guarantee erasure of all secret copies in memory;
lock drops references, and application exit terminates the process.

NOT CONNECTED / NOT CLAIMED
No real bank, live balances, money movement, fiat/crypto conversion, deposit
insurance, production token issuance, hardware signer, automatic update or signed
installer. No production key revocation/recovery or bank authority is simulated
as real. The fictional test bank's keys are intentionally inside the encrypted
test workspace; this is NOT a design for storing a real bank's keys in a client.
The test programme uses historical fixture assumptions ($1 + 2% issuance fee,
5% simple interest, original depositor income). Actual institution terms may differ.
Other token families and multiple institutions need their verified programme/API
contracts before they can become actionable accounts in the wallet.

DEVELOPMENT
npm ci
npm test
npm start
npm run package:win
The UI verification harness (npm run preview) creates only disposable test profiles
on loopback port 5183; it is never included in the packaged application.
