import test from 'node:test';
import assert from 'node:assert/strict';
import { readReserveAsset } from '../src/reserve-reader.mjs';
const response = data => ({ ok: true, json: async () => data });
const btc = { asset: 'BTC', network: 'Bitcoin', address: 'bc1' + 'a'.repeat(39) };
const usdc = { asset: 'USDC', network: 'Ethereum', address: '0x' + '1'.repeat(40) };
test('unconfigured reserves never fabricate zero balances or query providers', async () => {
  const result = await readReserveAsset({ ...btc, address: null }, () => { throw Error('Unexpected request'); });
  assert.equal(result.status,'not_configured');assert.equal(result.amount,undefined);
});
test('BTC confirmed balance excludes pending receipts; a price failure stays unknown', async () => {
  const result=await readReserveAsset(btc,async url => {
    if(url.includes('/prices/')) throw Error('offline');
    return response({chain_stats:{funded_txo_sum:150000000,spent_txo_sum:50000000},mempool_stats:{funded_txo_sum:900000000}});
  });
  assert.equal(result.amount,1);assert.equal(result.usdValue,null);assert.equal(result.priceStatus,'unavailable');
  await assert.rejects(()=>readReserveAsset(btc,async()=>response({})));
});
test('USDC reader requires mainnet and pins balance to a finalized block hash', async () => {
  const blockHash='0x'+'a'.repeat(64);
  const result=await readReserveAsset(usdc,async(url,options)=>{
    if(url.includes('/prices/'))return response({data:{base:'USDC',currency:'USD',amount:'0.99'}});
    const call=JSON.parse(options.body);let value;
    if(call.method==='eth_chainId')value='0x1';
    else if(call.method==='eth_getBlockByNumber')value={number:'0x20',hash:blockHash};
    else { assert.deepEqual(call.params[1],{blockHash,requireCanonical:true});value='0x1e8480'; }
    return response({jsonrpc:'2.0',id:1,result:value});
  });
  assert.equal(result.amount,2);assert.equal(result.usdValue,1.98);
  await assert.rejects(()=>readReserveAsset(usdc,async()=>response({jsonrpc:'2.0',id:1,result:'0x89'})),/Wrong Ethereum network/);
});
test('provider errors and invalid addresses are not reported as empty wallets', async () => {
  await assert.rejects(()=>readReserveAsset(btc,async()=>({ok:false})));
  await assert.rejects(()=>readReserveAsset({...usdc,address:'not-an-address'}));
});
