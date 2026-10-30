import { Field, Poseidon, PublicKey, Signature, UInt64 } from 'o1js';
import { DOMAIN, LAB_NETWORK, MAX_NOTE, Note } from './circuit.mjs';
import { canonical, digest, exact, fieldString } from './protocol.mjs';

const fields=i=>[DOMAIN.add(10),LAB_NETWORK,Field(i.nonce),Field(i.amount),Field(i.expiresAt),...PublicKey.fromBase58(i.recipient).toFields()];
export function verifyInvoice(invoice,{now=Date.now(),allowExpired=false}={}){
 exact(invoice,['version','network','recipient','amount','nonce','expiresAt','signature']);
 if(invoice.version!==1||invoice.network!==LAB_NETWORK.toString()||typeof invoice.amount!=='string'||! /^(0|[1-9][0-9]{0,14})$/.test(invoice.amount)||BigInt(invoice.amount)<1n||BigInt(invoice.amount)>MAX_NOTE||!Number.isSafeInteger(invoice.expiresAt)||invoice.expiresAt<1||!Number.isSafeInteger(now)||now<0)throw new Error('invalid payment invoice');
 fieldString(invoice.nonce);if(invoice.nonce==='0'||typeof invoice.recipient!=='string'||invoice.recipient.length>64||typeof invoice.signature!=='string'||invoice.signature.length>128)throw new Error('invalid invoice key or nonce');
 const owner=PublicKey.fromBase58(invoice.recipient);if(owner.toBase58()!==invoice.recipient||!Signature.fromBase58(invoice.signature).verify(owner,fields(invoice)).toBoolean())throw new Error('invalid invoice signature');
 if(!allowExpired&&now>=invoice.expiresAt)throw new Error('payment invoice expired');
 return {id:digest(canonical(invoice)),note:new Note({value:UInt64.from(invoice.amount),salt:Poseidon.hash(fields(invoice)),owner})};
}
export function createInvoice(key,amount,{now=Date.now(),ttlMs=86400000}={}){
 if(!Number.isSafeInteger(ttlMs)||ttlMs<60000||ttlMs>30*86400000)throw new Error('invoice lifetime bound');
 const invoice={version:1,network:LAB_NETWORK.toString(),recipient:key.toPublicKey().toBase58(),amount:String(amount),nonce:Field.random().toString(),expiresAt:now+ttlMs};
 invoice.signature=Signature.create(key,fields(invoice)).toBase58();verifyInvoice(invoice,{now});return invoice;
}
