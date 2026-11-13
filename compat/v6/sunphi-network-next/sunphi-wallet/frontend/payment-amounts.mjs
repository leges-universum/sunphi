// Shared browser/edge denomination contract. Never convert money through Number.
export function paymentAmount(value, unitScale = '1') {
 if (!['1','1000000'].includes(unitScale) || typeof value !== 'string' ||
     !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) >= (1n << 64n))
  throw Error('Unsupported payment amount or denomination.');
 if (unitScale === '1') return value;
 const n=BigInt(value),fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');
 return String(n/1000000n)+(fraction?'.'+fraction:'');
}
export function paymentDisplay(intent) {
 const scale=intent.unitScale===undefined?'1':intent.unitScale;
 return {value:paymentAmount(intent.value,scale),fee:paymentAmount(intent.fee,scale),
  abortFee:paymentAmount(intent.abortFee,scale)};
}
