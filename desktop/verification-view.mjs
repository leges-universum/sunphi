// Presentation only. Neither animation nor cached display data grants authority.
export function verificationView(state,{last=null,attention=false}={}){
 const epoch=state?.network?.checkpointEpoch;
 const initial=!last;
 const incoming=initial&&!!state?.network?.ready;
 return {
  epoch:Number.isSafeInteger(epoch)&&epoch>=0?String(epoch):'—',
  phase:attention?'attention':initial?(incoming?'incoming':'history'):'automatic',
  animated:!attention&&!state?.locked,
  title:attention?'Check your connection':initial?(incoming?'Checking incoming transfers':'Verifying your wallet'):'Automatic balance checks',
  message:attention?'Verification is taking longer than expected. Check your node connection; automatic retries continue.':initial?(incoming?'History is verified. Your wallet is checking incoming transfers before showing your balance.':"Your wallet is checking its place in the network’s history. Your balance will appear once verification is complete."):'Your wallet keeps checking the network in the background. Every payment requires a fresh check.',
  indicator:attention?'Connection needs attention':'Automatic verification',
  detail:attention?'Open Overview for details':'History checked in the background'
 };
}
