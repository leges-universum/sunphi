import test from 'node:test';
import assert from 'node:assert/strict';
import {tariffNoticeSeconds} from '../payment-tariff-governance.mjs';
test('notice exemption closes on any prior funding, tariff or emission activation',()=>{
 const c={initial:{supply:'0',fees:'0'}},s={money:{supply:'0',fees:'0'},rewards:{minted:'0'}};
 assert.equal(tariffNoticeSeconds(s,c),0);
 for(const patch of [{money:{supply:'1',fees:'0'}},{money:{supply:'0',fees:'1'}},{money:{...s.money,paymentTariff:{}}},{centuryFunds:{execution:{}}},{centuryFunds:{support:{}}},{centuryFunds:{founderAdvance:{}}},{centuryWarmup:{}},{centurySubsidy:{}},{networkReserves:{issued:'certificate'}},{launchFund:{issued:'certificate'}},{rewards:{minted:'1'}}])assert.equal(tariffNoticeSeconds({...s,...patch},c),86400);
 for(const initial of [{supply:'1',fees:'0'},{supply:'0',fees:'1'},{}])assert.equal(tariffNoticeSeconds(s,{initial}),86400,'funded or unknown genesis cannot qualify');
 assert.equal(tariffNoticeSeconds({...s,centuryFunds:{manifest:{}}},c),0,'unissued fund preparation does not start circulation');
});
