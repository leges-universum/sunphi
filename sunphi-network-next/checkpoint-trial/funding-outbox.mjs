// Shared input reservation guard; no signing or network dependencies.
export const fundingTerminal=new Set(['COMMITTED','REJECTED','CANCELLED','EXPIRED','CONFLICT']);
export function initializeFundingOutbox(db){db.exec('CREATE TABLE IF NOT EXISTS collateral_outgoing(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL)');}
export function pendingFunding(db){initializeFundingOutbox(db);return db.prepare('SELECT record FROM collateral_outgoing').all().some(row=>!fundingTerminal.has(JSON.parse(row.record).status));}
