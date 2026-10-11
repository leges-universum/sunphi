export const tokenDocument = {
  id: 'token', title: 'Token anatomy & recovery', category: 'Understand', status: 'Proposed record format',
  summary: 'What sun(φ) contains, what is fragmented, and which protections address which kinds of loss.',
  sections: [
    { title: 'A token is an accepted ownership record', paragraphs: ['The permanent identifier names one issued asset; its accepted state identifies who may authorize the next transfer. Copying the bytes does not create another issued token. Genesis must admit every identifier exactly once against an approved supply. Supply, genesis format and admission rules are not yet finalized.', 'The private signing key is never in the token or its fragments. The token is not a secret string that belongs to whoever assembles it.'] },
    { title: 'Main object: stored at rest and fragmented', table: { headers: ['Component', 'Purpose'], rows: [
      ['Network and format version', 'Separate protocol versions, networks and signing domains.'],
      ['Permanent token ID', 'Links ownership revisions to the same issued asset, for example token 123.'],
      ['Ownership revision and owner', 'Names the accepted state and public key authorized to spend it.'],
      ['Last completed credit time', 'Bound to the signed receipt; interpreted with accepted-state evidence.'],
      ['Recent transfer history', 'Baseline: ten records binding parties, transfer IDs and signatures. Ten is not a proven security optimum.'],
      ['Accepted-state evidence', 'Establishes issuance admission and current ownership beyond a short history window. Its distributed proof format remains unimplemented.'],
      ['Main hash', 'Commits to canonical serialized content, including signatures but excluding its own hash field. Algorithms and binary format remain open.']
    ] } },
    { title: 'Temporary second part: only in transit', formula: 'In transit: mainHash–reservationHash · At rest: main object only', paragraphs: ['A separate, unfragmented reservation binds the main hash, expected revision, token ID, transfer ID, sender, intended recipient and sending time. The sender signs that payload. The reservation hash identifies the complete signed record; the two hashes do not replace the underlying records.', 'The main hash stays unchanged from sending until completed credit. A completed receipt changes owner, credit time and history, producing a new main hash. There is no permanent “free” marker. Terminal receipt or cancellation evidence must still be retained for replay protection.'] },
    { title: 'How fragments are formed', bullets: ['Serialize the main object canonically and compute its hash.', 'Encode into n fragments, recoverable from k valid distinct fragments. Include main hash, token revision, coding generation, fragment index and verifiable integrity metadata.', 'Place fragments across the defined holder set. Codec and placement implementation are pending.', 'Recover fragments from one version and coding generation; verify their integrity and the reconstructed hash. Duplicate copies of one fragment do not count toward k.', 'Recoding unchanged content changes storage metadata, not ownership. A newer timestamp alone does not establish the accepted current state.', 'Reconstruction recovers data only. It supplies neither the recipient’s private key nor permission to credit.'], links: [['Follow the transaction', '#/transaction'], ['Erasure coding: RFC 5510', 'https://www.rfc-editor.org/rfc/rfc5510.html']] },
    { title: 'Signatures and hashes: no circular dependency', paragraphs: ['The sender signs the canonical reservation payload excluding its signature field. The recipient signs a receipt payload binding the same token, main hash, reservation, transfer ID, parties and receipt time, again excluding its own signature field. The new main object can then include that signed receipt and receive a new hash.', 'Receipt time must be covered by the signature. A recipient signature is cryptographic authorization, not an arbitrary random mark; some schemes are deterministic. SunPhi has not finalized its signature suite.'], links: [['Signature reference: RFC 8032', 'https://www.rfc-editor.org/rfc/rfc8032.html']] },
    { title: 'Protection against loss: scope and limits', table: { headers: ['Event', 'Protection / limit'], rows: [
      ['Some nodes disconnect', 'Redundancy permits recovery while k valid distinct fragments remain available. Correlated outages require separate analysis.'],
      ['Old node reconnects', 'Verify accepted current state before retiring stale fragments. Keep the last recoverable encoding until replacement is safe.'],
      ['Someone copies the token', 'The copy contains no private key. Signature checks and unique state acceptance must prevent unauthorized or conflicting spends.'],
      ['Receipt acknowledgement is lost', 'Retrieve accepted status by transfer ID. A missing response does not authorize refund.'],
      ['Private key is lost', 'Public fragments cannot recover it. Secure key backup or a separately designed recovery scheme is needed.'],
      ['Key is stolen or wrong recipient signed', 'Fragmentation cannot reverse an otherwise valid authorization.'],
      ['All recoverable data and backups disappear', 'Recovery is impossible. This design does not promise zero loss.']
    ] } },
  ],
};

export const transactionDocument = {
  id: 'transaction', title: 'Two-circuit transaction', category: 'Understand', status: 'Workflow specification',
  summary: 'Payment → sending time → reservation. Fragments → receipt time → recipient signature → accepted credit. Every gate has a different job.',
  sections: [
    { title: 'Circuit 1 · authorize and reserve', table: { headers: ['Stage', 'Token 123: Ivan sends to Anna'], rows: [
      ['1. Payment instruction', 'Identify Ivan, accepted main hash H7, intended recipient Anna and unique transfer T. H7 is an illustrative label.'],
      ['2. Sending time and signature', 'Ivan signs a reservation request binding the time, both parties, T and H7.'],
      ['3. Accepted reservation', 'Accept only one conflicting reservation. Ivan cannot make another accepted spend while T is pending. Main M7 / H7 remains unchanged; the second part carries the reservation.']
    ] }, paragraphs: ['Broadcasting a reservation does not prove that every peer received it. Unique reservation acceptance among independent nodes is required; random storage placement does not itself implement it.'] },
    { title: 'Circuit 2 · reconstruct, sign and credit', table: { headers: ['Stage', 'Recipient-side action'], rows: [
      ['4. Assemble fragments', 'Recover M7 from k valid distinct fragments of one coding generation and verify H7. Data is recovered; the transaction is not complete.'],
      ['5. Verify and record receipt time', 'Check Ivan’s authority and the current accepted reservation T naming Anna. Put receipt time in the payload to be signed.'],
      ['6. Recipient signature', 'Anna signs with her private key. Someone who merely assembled the public token cannot sign as Anna under the signature scheme’s security assumptions.'],
      ['7. Accepted credit', 'Publish candidate M8 / H8 naming Anna. Verify and uniquely accept credit instead of cancellation, with required durable storage. Only then show a spendable balance.']
    ] }, paragraphs: ['A local signature is not global finality. Publication, exclusive acceptance and durable placement still require a distributed implementation. The diagram illustrates requirements; it does not execute a payment.'] },
    { title: 'Reliability is attached to each gate', table: { headers: ['Workflow gate', 'What it establishes'], rows: [
      ['Fragment availability · stage 4', 'P(X < k), X ~ Binomial(n,q), estimates insufficient valid fragments for one object at one snapshot, assuming independent equally available holders.'],
      ['Authenticity · stages 2, 5 and 6', 'Signature verification binds the exact record to an authorized key. The availability formula does not measure forgery.'],
      ['Recipient binding · stages 5 and 6', 'Reservation and receipt must name the same recipient and transfer. Fragments do not authorize credit.'],
      ['Freshness and exclusivity · stages 3 and 7', 'A distributed acceptance rule must exclude conflicting reservations, credit and cancellation. That mechanism remains unimplemented.'],
      ['Durability · stage 7 onward', 'New state must survive churn and recoding. Repair, checkpoints and shared failures need testing.']
    ] }, formula: 'n = 5, k = 1, q = 0.8 → P(insufficient fragments) = (1 − 0.8)^5 = 0.032%', paragraphs: ['This illustrative result describes only reconstruction, not illicit acceptance or lifetime loss. The strict any-1% reference is n=N, k=ceil(N/100), conditional on a suitable codec and valid distinct fragments.', 'The two circuits are linked checks, not independent lotteries. Multiplying probabilities of two groups does not prove this transaction secure.'], links: [['Adjust the reconstruction assumptions', '#/probability']] },
    { title: 'What a copied token can and cannot do', paragraphs: ['An outsider may reconstruct H7, but replacing Anna with Boris in Ivan’s signed reservation invalidates the signature. The outsider also needs Anna’s private key to sign her receipt. Stale copies must fail the accepted-current-state check.', 'A malicious owner can genuinely sign two conflicting requests. Preventing both from being accepted requires unique reservation and finality rules. Random storage, timestamps and recipient signatures alone do not supply those rules.', 'The intended invariant is one spendable owner and never both accepted credit and cancellation for the same reservation. It depends on correct signatures, exclusive acceptance, replay protection and durable state. Seven tests of a serial reference model check local transitions; they are not a proof across hostile independent nodes.'] },
    { title: 'Disconnects, expiry and return', table: { headers: ['Last known stage', 'Safe action'], rows: [
      ['Reserved; no signed receipt', 'Remain pending. Expiry may permit a cancellation request under network rules.'],
      ['Fragments reconstructed', 'Still pending: having the data permits neither credit nor refund.'],
      ['Receipt signed; response lost', 'Outcome may be unknown. Retrieve accepted status; do not infer failure from silence.'],
      ['Credit accepted; acknowledgement lost', 'Anna owns the token. Replaying T returns its existing result.'],
      ['Cancellation accepted', 'Ivan may spend again. Advance accepted reservation-state evidence and reject later receipts for cancelled T.']
    ] }, paragraphs: ['A timer requests resolution; it cannot unilaterally restore the sender’s balance. Credit and cancellation must be mutually exclusive. A partition may delay completion: rejecting an unverified transition protects safety, not uninterrupted availability.'] },
  ],
};

export const privacyDocument = {
  id: 'privacy', title: 'Privacy & anonymity', category: 'Research', status: 'Threat model',
  summary: 'Public keys are pseudonyms. Records, network observations and payment data may connect them to a person.',
  sections: [
    { title: 'What can identify or link participants', table: { headers: ['Information', 'Observer and possible inference'], rows: [
      ['Owner and recipient public identifiers', 'Record readers can link reused keys. A key alone does not prove a legal name.'],
      ['Persistent token ID and history', 'Record readers can trace ownership changes. Others may archive records beyond the ten-transfer window.'],
      ['Sending and receipt timestamps', 'Observers can correlate timing across sources. Precision and publication rules remain open.'],
      ['IP address and connection timing', 'Direct peers see network counterparts. NAT, shared computers and relays mean an IP is not proof of a person or original sender.'],
      ['Amounts, orders and BTC addresses', 'Exchange records can link both payment legs. The exact public amount representation is not yet defined.'],
      ['Bank or identity records', 'Payment providers may associate an order with a customer. This mapping is not inherently public.'],
      ['Reward authorization and payouts', 'The accounting service would see wallet session times and payouts. Shared timing may suggest, but not prove, a common operator.']
    ] } },
    { title: 'Fragmentation does not establish anonymity', paragraphs: ['Erasure coding changes data placement; it is not encryption. Anyone who obtains enough valid fragments may reconstruct the public object. More nodes or wallets do not by themselves provide a measurable anonymity guarantee.', 'Deleting local old data does not delete an observer’s archive. Private-key secrecy protects signing authority, not the unlinkability of public transactions.'] },
    { title: 'Privacy boundaries to implement', bullets: ['Keep names, email, phone and identity documents out of public token records.', 'Separate exchange customer records from public protocol data, with minimal collection and restricted access. The current website has no live wallet or exchange service.', 'Separate node transport identities from wallet keys where possible. New wallet keys may reduce reuse but do not erase token-history or timing links.', 'Authenticated encryption protects transport against some observers; endpoints still receive the data. Relay-based origin protection needs its own design and testing.', 'Stronger transaction confidentiality needs a separate design compatible with validity checks. It is not already delivered by fragmentation.'] },
    { title: 'Current claim: pseudonymity', paragraphs: ['Full sender or recipient anonymity has not been established. No anonymity percentage is claimed without an implemented protocol, defined adversary and measurements.', 'Bitcoin’s privacy guidance provides a useful comparison for address reuse and external identity links; it is not evidence of SunPhi’s implemented properties.'], links: [['Bitcoin privacy guidance', 'https://bitcoin.org/en/protect-your-privacy'], ['Wallet and key safety', '#/wallet'], ['Security requirements', '#/security']] },
  ],
};
