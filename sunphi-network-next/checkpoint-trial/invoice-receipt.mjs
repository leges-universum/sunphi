import assert from 'node:assert/strict';
import {exact, hash, hex, verify} from './crypto.mjs';
import {parseToken, formatToken} from './token-units.mjs';

const scale = '1000000';
export function priceAcceptedLines(lines){
 assert(Array.isArray(lines)&&lines.length>=1&&lines.length<=16,'Use one to sixteen invoice lines.');
 let face=0n,accepted=0n,disputed=0n;
 for(const line of lines){
  const hasDispute=Object.hasOwn(line,'disputed');
  exact(line,['description','unitPrice','quantity','accepted',...(hasDispute?['disputed']:[])]);
  assert(typeof line.description==='string'&&line.description.trim()===line.description&&line.description.length>0&&line.description.length<=120,'Enter a short line description.');
  const price=BigInt(parseToken(line.unitPrice,scale));
  assert(price>0n&&Number.isSafeInteger(line.quantity)&&line.quantity>0,'Enter a positive price and quantity.');
  assert(Number.isSafeInteger(line.accepted)&&line.accepted>=0&&line.accepted<=line.quantity,'Accepted quantity exceeds the invoice line or is invalid.');
  if(hasDispute){
   assert(Number.isSafeInteger(line.disputed)&&line.disputed>0&&line.disputed<=line.quantity-line.accepted,'Disputed quantity must fit within the unaccepted quantity.');
   disputed+=price*BigInt(line.disputed);
  }
  face+=price*BigInt(line.quantity);
  accepted+=price*BigInt(line.accepted);
 }
 assert(face<=BigInt(Number.MAX_SAFE_INTEGER),'Invoice exceeds the accounting range.');
 return {faceMicro:String(face),amountMicro:String(accepted),remainingMicro:String(face-accepted),...(disputed?{disputedMicro:String(disputed)}:{})};
}

export function saveInvoiceNotice(wallet,advice){
 const pid=advice.notice.body.pid;
 wallet.db.exec('CREATE TABLE IF NOT EXISTS company_invoice_notices(pid TEXT PRIMARY KEY, advice TEXT NOT NULL)');
 wallet.db.prepare('INSERT INTO company_invoice_notices VALUES(?,?) ON CONFLICT(pid) DO NOTHING').run(pid,JSON.stringify(advice));
 assert.deepEqual(readInvoiceNotice(wallet,pid),advice,'Conflicting invoice notice for this payment.');
}
export function readInvoiceNotice(wallet,pid){
 hex(pid);
 if(!wallet.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_invoice_notices'").get())return null;
 const row=wallet.db.prepare('SELECT advice FROM company_invoice_notices WHERE pid=?').get(pid);
 return row?JSON.parse(row.advice):null;
}

export function inspectInvoiceAdvice(advice) {
 exact(advice, ['bill', 'notice']);
 const {bill, notice} = advice;
 for (const signed of [bill, notice]) exact(signed, ['body', 'signature']);
 const b = bill.body, n = notice.body;
 const header = ['domain', 'network', 'reference', 'buyer', 'buyerCompany', 'supplier', 'supplierCompany'];
 for (const field of ['network', 'buyerCompany', 'supplierCompany']) {
  assert(typeof b[field] === 'string' && b[field].trim() === b[field] && b[field].length > 0 && b[field].length <= 256, 'Invalid invoice identity.');
 }
 assert(typeof b.reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(b.reference), 'Invalid invoice reference.');
 assert(b.buyer !== b.supplier, 'Invoice parties must be distinct.');
 const fields = {Invoice: b.reference, 'Buyer company': b.buyerCompany, 'Supplier company': b.supplierCompany};
 if (Object.hasOwn(b, 'lines')) {
  const totals = priceAcceptedLines(b.lines);
  exact(b, [...header, 'lines', ...Object.keys(totals)]);
  assert.equal(b.domain, totals.disputedMicro ? 'DUEBYTE_COMPANY_PRICED_INVOICE_V2' : 'DUEBYTE_COMPANY_PRICED_INVOICE_V1');
  for (const [field, value] of Object.entries(totals)) assert.equal(b[field], value, 'Invoice totals differ from signed lines.');
  const display = value => formatToken(value, scale) + ' DUBYT';
  Object.assign(fields, {'Invoice value': display(b.faceMicro), 'Accepted value': display(b.amountMicro), 'Outside this payment': display(b.remainingMicro)});
  if (b.disputedMicro) fields['Of which disputed'] = display(b.disputedMicro);
 } else {
  exact(b, [...header, 'amountMicro']);
  assert.equal(b.domain, 'DUEBYTE_COMPANY_NATIVE_INVOICE_V1');
 }
 exact(n, ['domain', 'invoiceHash', 'pid', 'feeMicro']);
 hex(n.pid);
 for (const value of [b.amountMicro, n.feeMicro]) assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
 assert(BigInt(b.amountMicro) > 0n);
 assert(n.domain === 'DUEBYTE_NATIVE_INVOICE_PAYMENT_NOTICE_V1' && n.invoiceHash === hash(b)
  && verify(b, bill.signature, b.supplier) && verify(n, notice.signature, b.buyer), 'Invoice signatures could not be verified.');
 return fields;
}

export function matchInvoicePayment(advice, payment, network, owner) {
 const fields = inspectInvoiceAdvice(advice), {bill: {body: b}, notice: {body: n}} = advice;
 assert(network === b.network && (owner === b.buyer || owner === b.supplier), 'Invoice belongs to a different network or wallet.');
 assert(payment?.status === 'SETTLED' && payment.unitScale === scale && payment.pid === n.pid && payment.sender === b.buyer &&
  payment.recipient === b.supplier && payment.value === b.amountMicro && payment.fee === n.feeMicro, 'A matching confirmed payment is required.');
 return fields;
}

export function inspectSavedInvoice(archive) {
 const {network, owner, receipt} = archive;
 const {payment, invoiceAdvice: advice} = receipt;
 const fields = matchInvoicePayment(advice, payment, network, owner);
 const direction = owner === payment.sender ? 'Sent' : 'Received';
 assert(receipt.id === payment.pid && payment.direction === direction, 'Receipt identifiers or direction differ.');
 return {network, owner, direction, pid: payment.pid, fields, supplierReceived: formatToken(payment.value, scale), fee: formatToken(payment.fee, scale)};
}
