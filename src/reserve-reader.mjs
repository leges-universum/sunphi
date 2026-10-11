// Public, read-only observations. Never requests wallet access or signs a transaction.
export const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const SOURCES = Object.freeze({
  BTC: 'https://mempool.space/api',
  USDC: 'https://ethereum-rpc.publicnode.com',
  prices: 'https://api.coinbase.com/v2/prices',
});
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid integer balance from provider');
  return BigInt(value);
}
function hex(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw Error('Invalid RPC value');
  return BigInt(value);
}
export async function readReserveAsset(entry, fetcher = fetch) {
  if (!entry.address) return { ...entry, status: 'not_configured', observedAt: null };
  const request = async (url, options) => {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error('Reserve data source unavailable');
    return response.json();
  };
  let amount, block, explorer;
  if (entry.asset === 'BTC' && entry.network === 'Bitcoin') {
    if (!/^(bc1[a-z0-9]{20,90}|[13][a-zA-HJ-NP-Z0-9]{25,34})$/.test(entry.address)) throw Error('Invalid Bitcoin address format');
    const result = await request(SOURCES.BTC + '/address/' + entry.address);
    const balance = integer(result.chain_stats?.funded_txo_sum) - integer(result.chain_stats?.spent_txo_sum);
    if (balance < 0n) throw Error('Negative balance from provider');
    amount = Number(balance) / 1e8;
    // Esplora address totals are confirmed-chain observations, not pinned to one block.
    block = 'Confirmed-chain aggregate; block not pinned';
    explorer = 'https://mempool.space/address/' + entry.address;
  } else if (entry.asset === 'USDC' && entry.network === 'Ethereum') {
    if (!/^0x[0-9a-f]{40}$/i.test(entry.address)) throw Error('Invalid Ethereum address format');
    const rpc = async (method, params) => {
      const body = await request(SOURCES.USDC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (body.error || body.jsonrpc !== '2.0' || body.id !== 1 || body.result === undefined) throw Error('Invalid RPC response');
      return body.result;
    };
    if (hex(await rpc('eth_chainId', [])) !== 1n) throw Error('Wrong Ethereum network');
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
    hex(finalized?.number);
    if (typeof finalized?.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(finalized.hash)) throw Error('Missing finalized block evidence');
    const data = '0x70a08231' + entry.address.slice(2).toLowerCase().padStart(64, '0');
    const raw = hex(await rpc('eth_call', [{ to: USDC_ETHEREUM, data }, { blockHash: finalized.hash, requireCanonical: true }]));
    amount = Number(raw) / 1e6;
    block = finalized.number + ' / ' + finalized.hash;
    explorer = 'https://etherscan.io/token/' + USDC_ETHEREUM + '?a=' + entry.address;
  } else throw Error('Unsupported reserve asset or network');
  if (!Number.isFinite(amount)) throw Error('Balance exceeds display range');
  let usdPrice = null, priceStatus = 'unavailable';
  try {
    const quote = await request(SOURCES.prices + '/' + entry.asset + '-USD/spot');
    if (quote.data?.base !== entry.asset || quote.data?.currency !== 'USD' || !/^\d+(\.\d+)?$/.test(quote.data.amount)) throw Error('Invalid quote');
    usdPrice = Number(quote.data.amount);
    if (!Number.isFinite(usdPrice) || usdPrice <= 0) throw Error('Invalid price');
    priceStatus = 'observed';
  } catch { usdPrice = null; }
  return { ...entry, status: 'observed', amount, usdPrice, priceStatus,
    usdValue: usdPrice === null ? null : amount * usdPrice, block, explorer,
    balanceSource: SOURCES[entry.asset], priceSource: SOURCES.prices,
    observedAt: new Date().toISOString() };
}
