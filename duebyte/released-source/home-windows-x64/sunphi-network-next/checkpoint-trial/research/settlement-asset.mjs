import assert from 'node:assert/strict';
import {exact,hex,integer} from '../crypto.mjs';

export function validateSettlementAsset(asset){
 exact(asset,['symbol','decimals','network','genesis','assetId','addressFormat']);
 assert(typeof asset.symbol==='string'&&/^[A-Z][A-Z0-9]{1,11}$/.test(asset.symbol));
 integer(asset.decimals);assert(asset.decimals<=18);
 assert(typeof asset.network==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(asset.network));
 hex(asset.genesis);
 assert(typeof asset.assetId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(asset.assetId));
 assert(['account','hex20'].includes(asset.addressFormat));
 return asset;
}

export function seriesAsset(policy){
 if(policy.reserve.series.settlement)return validateSettlementAsset(policy.reserve.series.settlement);
 return reserveAsset(policy);
}

export function reserveAsset(policy){
 if(policy.reserve?.settlement)return validateSettlementAsset(policy.reserve.settlement);
 const route=policy.routes.USDC;
 return {symbol:'USDC',decimals:route.decimals,network:route.network,genesis:route.genesis,assetId:route.contract,addressFormat:'hex20'};
}

export const reserveSymbol=policy=>policy?.reserve?.settlement?.symbol??'USDC';

export function parseSettlement(value,asset){
 assert(typeof value==='string'&&value.length<=40&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value),'Invalid settlement amount.');
 const [whole,fraction='']=value.split('.');
 assert(fraction.length<=asset.decimals,'Settlement precision exceeded.');
 return String(BigInt(whole)*10n**BigInt(asset.decimals)+BigInt(fraction.padEnd(asset.decimals,'0')||'0'));
}

export function settlementAddress(value,format){
 assert(typeof value==='string');
 if(format==='hex20')assert(/^0x[0-9a-f]{40}$/.test(value)&&value!=='0x'+'0'.repeat(40),'Invalid external address.');
 else assert(format==='account'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value),'Invalid settlement account.');
 return value;
}

export function displaySettlement(value,asset){
 const units=BigInt(value),scale=10n**BigInt(asset.decimals);
 assert(units>=0n);
 const fraction=String(units%scale).padStart(asset.decimals,'0').replace(/0+$/,'');
 return String(units/scale)+(fraction?'.'+fraction:'');
}
