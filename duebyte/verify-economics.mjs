// Run against a fresh extraction of the published Linux Server archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [folder, policyFile, calendarFile] = process.argv.slice(2);
assert(folder && policyFile && calendarFile, 'usage: node verify-economics.mjs SERVER_DIR economic-policy-v4.json ordinary-node-calendar.csv');
const read = name => readFileSync(join(folder, name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = read('manifest.json');
const manifest = JSON.parse(manifestBytes);
const referencePins = {
  '0.3.145': '65bd3ae76c98b927a2a04db0f2f9640d2204998b8af4db514f13b2a6bd6b5554',
  '0.3.147': 'c7e4499ec6cf4275aedb729fdb59e6eeac4f552ecadd48181d698e5f727ea49c'
};
assert.equal(sha(manifestBytes), referencePins[manifest.version], 'reviewed Server manifest');
for (const [name, digest] of Object.entries(manifest.files)) {
  assert.equal(sha(read(name)), digest, name);
}

const base = resolve(folder, 'sunphi-network-next/checkpoint-trial');
const load = name => import(pathToFileURL(join(base, name)).href);
const { makeEconomicPlanV4 } = await load('economic-policy-v3.mjs');
const { compileOrdinaryCurve } = await load('research/smooth-emission.mjs');
const { annualRegularCeilings } = await load('ecosystem-century-model.mjs');
const policy = JSON.parse(readFileSync(policyFile));
const a = policy.allocation;
const scale = 1000000n;
// The published planning example specifies its own existing supply.
const plan = makeEconomicPlanV4({
  configHash: '0'.repeat(64), height: 0, money: { supply: a.existing, unitScale: String(scale) },
  networkReserves: { issued: false, warmup: { mode: 'PAUSED' }, development: { mode: 'PAUSED' } }
});
assert.equal(plan.capMicro, '10010000000000000');
for (const key of ['cap', 'regular', 'founder', 'warmup', 'development', 'memorial', 'programmeCap']) {
  assert.equal(a[key], plan[key + 'Micro'], key);
}
assert.equal(a.fixed, String(BigInt(a.founder) + BigInt(a.warmup) + BigInt(a.development) + BigInt(a.memorial)));
assert.equal(a.programmeFixed, String(BigInt(a.fixed) - BigInt(a.memorial)));
assert.equal(a.cap, String(BigInt(a.fixed) + BigInt(a.regular) + BigInt(a.existing)));
assert.deepEqual(policy.annualRegular, plan.annualRegularMicro);
assert.deepEqual(policy.mainProgrammeDecades, plan.decadeMicro);
assert.deepEqual(policy.decades, plan.decadeMicro.map((v,i) => String(BigInt(v) + (i === 0 ? BigInt(a.memorial) : 0n))));
assert.equal(policy.decimals, plan.decimals);
assert.equal(policy.issuanceEnabled, plan.issuanceEnabled);
assert.equal(policy.startDate, plan.emissionStart);

// The full main-programme schedule accounts for pilot advances within allocations.
const annual = annualRegularCeilings(0n);
const curve = compileOrdinaryCurve(annual.map(String));
const start = Date.UTC(2027, 0, 1) / 1000;
const end = Date.UTC(2127, 0, 1) / 1000;
const fullBudget = annual.reduce((sum,value) => sum + value, 0n);
assert.equal(curve.cumulative(start), 0n);
let last = 0n;
for (let midnight = start + 86400; midnight <= end; midnight += 86400) {
  const issued = curve.cumulative(midnight);
  assert(issued >= last && issued <= fullBudget, 'ordinary allowance at UTC second ' + midnight);
  last = issued;
}
assert.equal(last, fullBudget);
const rows = readFileSync(calendarFile, 'utf8').trim().split(/\r?\n/);
assert.equal(rows.shift(), 'year_utc,ordinary_budget_DUBYT,cumulative_ordinary_DUBYT');
assert.equal(rows.length, 100);
const format = n => String(n / scale) + '.' + String(n % scale).padStart(6, '0');
let previous = 0n;
for (const [i, row] of rows.entries()) {
  const year = 2027 + i;
  const total = curve.cumulative(Date.UTC(year + 1, 0, 1) / 1000);
  assert.equal(row, [year, format(total - previous), format(total)].join(','), String(year));
  previous = total;
}
assert.equal(previous, 9880000000000000n);
console.log('Verified Server manifest and files, V4 allocations, ten decades, 100 planning years, 100 schedule years and every daily allowance boundary.');
