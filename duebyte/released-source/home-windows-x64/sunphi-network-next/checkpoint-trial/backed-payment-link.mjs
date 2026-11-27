import assert from 'node:assert/strict';
import {exact,hash,hex,integer,publicKey,verify} from './crypto.mjs';
import {amount} from './payment-model.mjs';
import {SERIES,cashFor,commercialUnitLabel} from './research/backed-series.mjs';
const prefix='duebyte://pay/test-series/';
export function paymentLink(agreement,supplierSignature){
 return prefix+Buffer.from(JSON.stringify({agreement,supplierSignature})).toString('base64url');
}
export function parsePaymentLink(link,configHash,t,owner){
 assert(typeof link==='string'&&link.startsWith(prefix)&&link.length<=4096,'Invalid DueByte test payment link.');
 const payload=link.slice(prefix.length);assert(/^[A-Za-z0-9_-]+$/.test(payload));
 const raw=Buffer.from(payload,'base64url');assert.equal(raw.toString('base64url'),payload);
 const data=JSON.parse(raw.toString('utf8'));exact(data,['agreement','supplierSignature']);
 const g=data.agreement;exact(g,['domain','configHash','series','buyer','supplier','nonce','referenceHash','quantity','unitPrice',...(Object.hasOwn(g,'unit')?['unit']:[])]);commercialUnitLabel(g);
 assert.equal(g.domain,SERIES+'/ORDER');assert.equal(g.configHash,configHash,'Payment link is for another network.');assert.equal(g.series,t.id,'Payment link is for another series.');
 publicKey(g.supplier);assert.equal(g.buyer,owner,'Payment request is for another buyer.');assert.notEqual(g.supplier,owner);hex(g.nonce);hex(g.referenceHash);
 integer(g.quantity,1);assert(g.quantity<=1000000);cashFor(t,amount(g.unitPrice));
 assert(verify(g,data.supplierSignature,g.supplier),'Invalid supplier signature.');
 return {id:hash(g),command:{type:'SERIES_ORDER',...data}};
}
