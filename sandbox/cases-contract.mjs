// Narrow, server-side export contract for the existing Cases collaboration projection.
// No document fetching, AI decisions, business writes or financial authority here.
const fail = message => { throw Error(message); };
const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const integer = v => Number.isSafeInteger(v) && v > 0;
const unique = v => Array.isArray(v) && v.length <= 160 && new Set(v).size === v.length && v.every(x => text(x, 120));
const same = (a, b) => unique(a) && unique(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateTerms(terms) {
  if (!terms || terms.version !== 1 || !text(terms.caseId, 120) || !text(terms.graphId, 120) ||
      !integer(terms.graphVersion) || !integer(terms.amount) || terms.currency !== 'USD' ||
      !['buyer', 'seller', 'supplier'].includes(terms.owner) || !['buyer', 'seller', 'supplier'].includes(terms.recipient) || terms.owner === terms.recipient ||
      !text(terms.bankId, 120) || !Array.isArray(terms.conditions) || !terms.conditions.length || terms.conditions.length > 8)
    fail('Invalid Cases settlement terms');
  const stages = new Set(), ids = new Set();
  for (const c of terms.conditions) {
    if (!text(c.id, 96) || ids.has(c.id) || !text(c.stageId, 120) || stages.has(c.stageId) ||
        !['carrier', 'insurer'].includes(c.actor) || !text(c.label, 500) || !['handover', 'joint'].includes(c.kind) ||
        !text(c.scope) || !text(c.evidenceRequirement) || !unique(c.submitters) || !c.submitters.length ||
        !unique(c.reviewers) || !c.reviewers.length || !unique(c.issuers) || !c.issuers.length || !unique(c.requires))
      fail('Invalid or unsupported Cases condition');
    if (c.kind === 'handover' && c.submitters.some(x => c.reviewers.includes(x))) fail('Independent reviewer required');
    if (c.kind === 'joint' && c.reviewers.length < 2) fail('Joint reviewers required');
    stages.add(c.stageId); ids.add(c.id);
  }
  // Export the dependency closure, not unseen/unapproved stage statuses.
  for (const c of terms.conditions) if (c.requires.some(x => !stages.has(x) || x === c.stageId)) fail('Agreed dependency closure required');
  const done = new Set(), visiting = new Set();
  function visit(c) {
    if (visiting.has(c.stageId)) fail('Cyclic Cases conditions');
    if (done.has(c.stageId)) return;
    visiting.add(c.stageId);
    c.requires.forEach(id => visit(terms.conditions.find(x => x.stageId === id)));
    visiting.delete(c.stageId); done.add(c.stageId);
  }
  terms.conditions.forEach(visit);
  return terms;
}

/** Inputs must be resolved by the authenticated Cases server, never browser claims.
 * grant is a NEW proposed export grant; existing overview consent does not create it.
 * Only the allowlisted accepted submissions leave this boundary. */
export function exportCaseRecord(projection, grant, terms, now) {
  validateTerms(terms);
  if (!Number.isSafeInteger(now) || now < 0) fail('Trusted server time required');
  if (!projection || projection.access !== 'active' || !['party', 'provider'].includes(projection.kind)) fail('Assigned Cases access required; overview is insufficient');
  if (projection.caseId !== terms.caseId || projection.graphId !== terms.graphId || projection.graphVersion !== terms.graphVersion || !integer(projection.revision)) fail('Cases identity or graph version mismatch');
  if (!timestamp(projection.serverNow) || Math.abs(now - Date.parse(projection.serverNow)) > 60000) fail('Fresh Cases projection required');
  if (!grant || grant.status !== 'active' || grant.purpose !== 'bank-settlement' || grant.bankId !== terms.bankId ||
      grant.caseId !== terms.caseId || !text(grant.id, 120) || !integer(grant.version) ||
      !timestamp(grant.expiresAt) || Date.parse(grant.expiresAt) <= now || !unique(grant.stageIds) ||
      terms.conditions.some(c => !grant.stageIds.includes(c.stageId))) fail('Current explicit bank evidence grant required');
  if (!Array.isArray(projection.nodes) || projection.nodes.length > 160 || new Set(projection.nodes.map(n => n.id)).size !== projection.nodes.length) fail('Invalid Cases nodes');
  const conditions = terms.conditions.map(c => {
    const node = projection.nodes.find(n => n.id === c.stageId);
    if (!node || node.state !== 'accepted' || node.kind !== c.kind || node.scope !== c.scope ||
        node.evidenceRequirement !== c.evidenceRequirement || !same(node.requires, c.requires) ||
        node.cancellation?.status === 'pending') fail('Stage unavailable or agreed conditions changed');
    const submissions = node.submissions;
    if (!Array.isArray(submissions) || !submissions.length || submissions.length > 1000) fail('Current evidence required');
    const s = submissions.at(-1);
    if (!text(s.id, 120) || !integer(s.version) || s.status !== 'accepted' || !c.submitters.includes(s.actorId) ||
        !timestamp(s.at) || Date.parse(s.at) > now || !same(s.acceptedBy, c.reviewers) ||
        !Array.isArray(s.objections) || s.objections.length || !Array.isArray(s.evidence) || !s.evidence.length || s.evidence.length > 12)
      fail('Current submission and exact agreed reviewers required');
    const evidence = s.evidence.map(e => {
      if (!text(e.reference, 1000) || !/^[a-f0-9]{64}$/.test(e.sha256) || !c.issuers.includes(e.issuerId) ||
          e.scope !== c.scope || !timestamp(e.observedAt) || Date.parse(e.observedAt) > Date.parse(s.at)) fail('Evidence identity, digest, scope or time mismatch');
      return { reference: e.reference, sha256: e.sha256, issuerId: e.issuerId, scope: e.scope, observedAt: e.observedAt };
    });
    return { conditionId: c.id, stageId: c.stageId, submissionId: s.id, version: s.version,
      actorId: s.actorId, at: s.at, acceptedBy: [...s.acceptedBy].sort(), evidence };
  });
  return { caseId: terms.caseId, graphId: terms.graphId, graphVersion: terms.graphVersion, revision: projection.revision,
    grant: { id: grant.id, version: grant.version, expiresAt: grant.expiresAt }, conditions };
}
