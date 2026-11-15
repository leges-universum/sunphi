// This predicate is only a liveness decision for an already authenticated offer.
// It never accepts a snapshot or substitutes for the checkpoint verifier.
export function acceptedSnapshotExpired(metadata,now=Math.floor(Date.now()/1000)){
 return Number.isSafeInteger(metadata?.document?.body?.expiresAt)&&now>=metadata.document.body.expiresAt;
}
