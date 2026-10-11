import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenModel, emissionScenario } from './model.mjs';

const reserve = (m, id = 'a') => m.reserve({ id, sender: 'Ivan', recipient: 'Anna', version: m.version, expires: 60 });

test('recipient-specific credit; stale state cannot spend after credit', () => {
  const m = new TokenModel('Ivan');
  assert.equal(reserve(m), true);
  assert.equal(m.spendableBy('Ivan'), false);
  assert.equal(m.credit({ id: 'a', recipient: 'Boris', version: 1 }), false);
  assert.equal(m.credit({ id: 'a', recipient: 'Anna', version: 1 }), true);
  assert.equal(m.spendableBy('Anna'), true);
  assert.equal(m.reserve({ id: 'b', sender: 'Ivan', recipient: 'Boris', version: 0, expires: 60 }), false);
});

test('timer alone does not return token; cancellation invalidates delayed receipt', () => {
  const m = new TokenModel('Ivan');
  reserve(m);
  m.advance(60);
  assert.equal(m.spendableBy('Ivan'), false);
  assert.equal(m.cancel({ id: 'a', version: 1 }), true);
  assert.equal(m.spendableBy('Ivan'), true);
  assert.equal(m.credit({ id: 'a', recipient: 'Anna', version: 1 }), false);
  assert.equal(m.reserve({ id: 'a', sender: 'Ivan', recipient: 'Anna', version: 2, expires: 120 }), false);
});

test('lost acknowledgement after credit cannot permit return', () => {
  const m = new TokenModel('Ivan');
  reserve(m);
  m.advance(59);
  assert.equal(m.credit({ id: 'a', recipient: 'Anna', version: 1 }), true);
  m.advance(61);
  assert.equal(m.cancel({ id: 'a', version: 1 }), false);
  assert.equal(m.spendableBy('Anna'), true);
});

test('boundary: exactly at expiry only cancellation may succeed', () => {
  for (const time of [59, 60, 61]) {
    for (const order of [['credit', 'cancel'], ['cancel', 'credit']]) {
      const m = new TokenModel('Ivan');
      reserve(m);
      m.advance(time);
      const results = order.map(action => m[action]({ id: 'a', recipient: 'Anna', version: 1 }));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(m.owner, time < 60 ? 'Anna' : 'Ivan');
    }
  }
});

test('second reservation cannot bypass existing reservation', () => {
  const m = new TokenModel('Ivan');
  reserve(m);
  assert.equal(reserve(m, 'b'), false);
});

test('emission arithmetic stays exact beyond JavaScript Number safe integer', () => {
  for (const supply of [100_000_000n, 1_000_000_000n, 10_000_000_000n]) {
    const row = emissionScenario(supply);
    assert.equal(BigInt(row.accountingUnits) / 100_000_000n, supply);
    assert.equal(BigInt(row.hypotheticalEncodedPayloadBytes), supply * 204800n);
  }
});

test('model explicitly requires monotonic oracle time', () => {
  const m = new TokenModel('Ivan');
  m.advance(10);
  assert.throws(() => m.advance(9));
});
