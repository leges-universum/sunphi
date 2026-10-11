import { randomBytes } from 'node:crypto';
import { NETWORK, HEX, ADDRESS, exact, digest, identity, signRecord, verifyRecord } from './crypto.mjs';

const integer=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
const address=a=>typeof a==='string'&&ADDRESS.test(a);
const hash=h=>typeof h==='string'&&HEX.test(h);
export function checkReservation(record) {
  if(!verifyRecord(record))throw Error('Invalid sender signature');
  const p=record.payload;
  exact(p,['network','kind','tokenId','mainHash','revision','transferId','sender','recipient','sentAt','expiresAt']);
  if(p.kind!=='reservation'||![p.tokenId,p.mainHash,p.transferId].every(hash)||
     ![p.revision,p.sentAt,p.expiresAt].every(integer)||p.revision>=Number.MAX_SAFE_INTEGER||
     !address(p.recipient)||p.sender!==record.address||p.recipient===p.sender||
     p.expiresAt<=p.sentAt||p.expiresAt-p.sentAt>86400000)throw Error('Invalid reservation');
  return p;
}
export function checkReceipt(receipt,reservation) {
  const r=checkReservation(reservation);
  if(!verifyRecord(receipt))throw Error('Invalid recipient signature');
  const p=receipt.payload;
  exact(p,['network','kind','tokenId','mainHash','reservationHash','transferId','sender','recipient','receivedAt']);
  if(p.kind!=='receipt'||p.tokenId!==r.tokenId||p.mainHash!==r.mainHash||
     p.reservationHash!==digest(reservation)||p.transferId!==r.transferId||
     p.sender!==r.sender||p.recipient!==r.recipient||receipt.address!==r.recipient||
     !integer(p.receivedAt)||p.receivedAt<r.sentAt||p.receivedAt>=r.expiresAt)throw Error('Receipt does not match reservation');
  return p;
}
export function checkMain(main) {
  exact(main,['network','schema','tokenId','revision','owner','lastCreditTime','history']);
  if(main.network!==NETWORK||main.schema!==1||!hash(main.tokenId)||!integer(main.revision)||
     !address(main.owner)||!integer(main.lastCreditTime)||!Array.isArray(main.history)||
     main.history.length!==Math.min(10,main.revision))throw Error('Invalid main object');
  let prev;
  for(const entry of main.history) {
    exact(entry,['reservation','receipt']);
    const r=checkReservation(entry.reservation),p=checkReceipt(entry.receipt,entry.reservation);
    if(r.tokenId!==main.tokenId||(prev&&(r.sender!==prev.recipient||r.revision!==prev.revision+1||r.sentAt<prev.time)))throw Error('Invalid recent history');
    prev={recipient:r.recipient,revision:r.revision,time:p.receivedAt};
  }
  if(prev&&(prev.recipient!==main.owner||prev.revision!==main.revision-1||prev.time!==main.lastCreditTime))throw Error('History does not match main state');
  return main;
}
export function makeReservation(key,main,recipient,sentAt=Date.now(),ttl=300000) {
  checkMain(main);
  const sender=identity(key).address;
  if(sender!==main.owner||sentAt<main.lastCreditTime)throw Error('Not the current owner or invalid sending time');
  const payload={network:NETWORK,kind:'reservation',tokenId:main.tokenId,mainHash:digest(main),
    revision:main.revision,transferId:randomBytes(32).toString('hex'),sender,recipient,sentAt,expiresAt:sentAt+ttl};
  const reservation=signRecord(key,payload);checkReservation(reservation);
  return {format:'sunphi-transfer-v1',network:NETWORK,main:structuredClone(main),reservation};
}
export function checkTransfer(transfer) {
  exact(transfer,['format','network','main','reservation']);
  if(transfer.format!=='sunphi-transfer-v1'||transfer.network!==NETWORK)throw Error('Wrong transfer network');
  const main=checkMain(transfer.main),r=checkReservation(transfer.reservation);
  if(r.tokenId!==main.tokenId||r.mainHash!==digest(main)||r.sender!==main.owner||
     r.revision!==main.revision||r.sentAt<main.lastCreditTime)throw Error('Main object does not match reservation');
  return r;
}
export function makeReceipt(key,transfer,receivedAt=Date.now()) {
  const r=checkTransfer(transfer);
  if(identity(key).address!==r.recipient)throw Error('Only the intended recipient can sign');
  const receipt=signRecord(key,{network:NETWORK,kind:'receipt',tokenId:r.tokenId,mainHash:r.mainHash,
    reservationHash:digest(transfer.reservation),transferId:r.transferId,sender:r.sender,recipient:r.recipient,receivedAt});
  checkReceipt(receipt,transfer.reservation);
  return {format:'sunphi-receipt-v1',network:NETWORK,transfer:structuredClone(transfer),receipt};
}
export function checkReceiptPackage(pkg) {
  exact(pkg,['format','network','transfer','receipt']);
  if(pkg.format!=='sunphi-receipt-v1'||pkg.network!==NETWORK)throw Error('Wrong receipt network');
  checkTransfer(pkg.transfer);return checkReceipt(pkg.receipt,pkg.transfer.reservation);
}
// Candidate only. A signature/reconstruction cannot establish accepted ownership.
export function candidateMain(pkg) {
  const receipt=checkReceiptPackage(pkg),old=pkg.transfer.main;
  const main={...structuredClone(old),revision:old.revision+1,owner:receipt.recipient,lastCreditTime:receipt.receivedAt,
    history:[...old.history,{reservation:pkg.transfer.reservation,receipt:pkg.receipt}].slice(-10)};
  checkMain(main);return structuredClone(main);
}
