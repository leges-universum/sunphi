// Run only with an issued partner key. No orders, deposits, quotes or transfers.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ChangeNowDiscovery} from './exchange-changenow-discovery.mjs';
try {
  const args=process.argv.slice(2);
  assert(args.length===5&&process.env.CHANGENOW_CREDENTIAL_FILE);
  const [fromCurrency,fromNetwork,toCurrency,toNetwork,flow]=args;
  const client=new ChangeNowDiscovery({credentials:async()=>JSON.parse(readFileSync(process.env.CHANGENOW_CREDENTIAL_FILE,'utf8'))});
  console.log(JSON.stringify(await client.inspectRoute({fromCurrency,fromNetwork,toCurrency,toNetwork,flow})));
} catch(e) {
  console.error(JSON.stringify({ready:false,executionEnabled:false,financialCommandsSent:0,httpStatus:e.status??null,
    instruction:'Configure CHANGENOW_CREDENTIAL_FILE securely. Arguments: FROM_CURRENCY FROM_NETWORK TO_CURRENCY TO_NETWORK standard|fixed-rate. Use confirmed provider network codes.'}));
  process.exitCode=1;
}
