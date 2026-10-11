import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryQuote, reserveStress, SUPPLY_CAP } from '../src/issuance-policy.mjs';
import { IssuanceModel } from './issuance-model.mjs';

function fund(m, id, quantity) {
  m.settlePayment({ id, paymentId: 'payment-' + id, cents: quantity * 102n });
  for (const [asset, network, decimals, cents] of [['USDC', 'Ethereum', 6, 90n], ['BTC', 'Bitcoin', 8, 10n]]) {
    m.acquireReserve({ id, receiptId: id + asset, asset, network, decimals, reserveAddress: 'LAB-ONLY-' + network, units: quantity, principalCents: quantity * cents });
  }
}
test('primary purchase preserves the full dollar plus separate 1% and 1% fees', () => {
  assert.deepEqual(primaryQuote(1n), { quantity:1n, reserveCents:100n, platformCents:1n, rewardCents:1n, buyerCents:102n });
  const q = primaryQuote(SUPPLY_CAP);
  assert.equal(q.buyerCents,10_200_000_000n);
  assert.equal(q.reserveCents+q.platformCents+q.rewardCents,q.buyerCents);
  for (const v of [0n,-1n,SUPPLY_CAP+1n,1,1.5]) assert.throws(()=>primaryQuote(v));
});
test('no premint; purchase completion issues once, with separate reserve and fee accounting', () => {
  const m = new IssuanceModel();
  assert.equal(m.snapshot.issued,0n);
  m.create({id:'a',buyer:'Anna',quantity:10n});
  assert.throws(()=>m.issue('a'));
  fund(m,'a',10n);
  assert.equal(m.snapshot.issued,0n);
  const issued=m.issue('a');
  assert.deepEqual(issued.issuedRange,{first:1n,last:10n,owner:'Anna'});
  assert.deepEqual(m.issue('a'),issued);
  assert.equal(m.snapshot.issued,10n);
  assert.equal(m.snapshot.reserveAcquisitionCents,1000n);
  assert.equal(m.snapshot.platformFeeCents,10n);
  assert.equal(m.snapshot.rewardFundingCents,10n);
});
test('committed orders cannot oversubscribe the cap; cancellation releases unissued capacity', () => {
  const m = new IssuanceModel();
  m.create({id:'a',buyer:'Anna',quantity:SUPPLY_CAP});
  assert.throws(()=>m.create({id:'b',buyer:'Boris',quantity:1n}));
  m.cancelUnpaid('a'); m.cancelUnpaid('a');
  m.create({id:'b',buyer:'Boris',quantity:SUPPLY_CAP});
  fund(m,'b',SUPPLY_CAP); m.issue('b');
  assert.equal(m.snapshot.remainingCapacity,0n);
  assert.throws(()=>m.create({id:'c',buyer:'Boris',quantity:1n}));
});
test('payment replay, mismatches, partial backing and changed order replay fail safely', () => {
  const m = new IssuanceModel();
  m.create({id:'a',buyer:'Anna',quantity:1n});m.create({id:'b',buyer:'Boris',quantity:1n});
  assert.throws(()=>m.create({id:'a',buyer:'Boris',quantity:1n}));
  assert.throws(()=>m.settlePayment({id:'a',paymentId:'p',cents:100n}));
  m.settlePayment({id:'a',paymentId:'p',cents:102n});
  m.settlePayment({id:'a',paymentId:'p',cents:102n});
  assert.throws(()=>m.settlePayment({id:'b',paymentId:'p',cents:102n}));
  assert.throws(()=>m.issue('a')); assert.throws(()=>m.cancelUnpaid('a'));
  const lot={id:'a',receiptId:'r',asset:'USDC',network:'Ethereum',reserveAddress:'LAB-ONLY',units:900000n,decimals:6,principalCents:90n};
  m.acquireReserve(lot);m.acquireReserve(lot);
  assert.throws(()=>m.issue('a'));
  assert.throws(()=>m.acquireReserve({...lot,units:1n}));
  m.settlePayment({id:'b',paymentId:'pb',cents:102n});
  assert.throws(()=>m.acquireReserve({...lot,id:'b'}));
  assert.equal(m.order('a').reserveCents,90n);
});
test('only correctly identified supported reserve assets and full basket allocation permit issue', () => {
  const m = new IssuanceModel();m.create({id:'a',buyer:'Anna',quantity:1n});m.settlePayment({id:'a',paymentId:'p',cents:102n});
  const lot={id:'a',receiptId:'r',asset:'USDC',network:'Ethereum',reserveAddress:'LAB',units:1n,decimals:6,principalCents:100n};
  assert.throws(()=>m.acquireReserve({...lot,network:'Bitcoin'}));
  m.acquireReserve(lot);assert.throws(()=>m.issue('a'));
  const copy=m.order('a');copy.reserveCents=0n;copy.lots[0].units=0n;
  assert.equal(m.order('a').reserveCents,100n);assert.equal(m.order('a').lots[0].units,1n);
});
test('basket value is not a dollar peg; cap is not issued supply', () => {
  const r=reserveStress({issued:1000,usdcChange:0,btcChange:-50});
  assert.equal(r.reserveUsd,950);assert.equal(r.backingPerTokenUsd,0.95);assert.equal(r.coveragePercent,95);
  assert.equal(reserveStress({issued:1000,usdcChange:-10,btcChange:0}).backingPerTokenUsd,0.91);
  assert.throws(()=>reserveStress({issued:0,usdcChange:0,btcChange:0}));
});
