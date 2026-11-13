// Explicit signed clock selection. Heights remain identifiers, never elapsed time.
import assert from 'node:assert/strict';
import {integer} from './crypto.mjs';
import {UTC_OBLIGATIONS} from './obligation-clock.mjs';
export const UTC_REWARDS='DUEBYTE_UTC_REWARDS_V1';
export const REWARD_NOTICE_SECONDS=20;
export const utcRewards=c=>c?.timeBasis===UTC_REWARDS;
export const rewardClock=(s,c=s.rewards?.coefficients??s.authority?.nodeRewards?.coefficients)=>utcRewards(c)?s.money.time:s.height;
export function checkRewardClock(config,c){
 assert.equal(utcRewards(c),config.obligationClock===UTC_OBLIGATIONS,'reward genesis clock');
 if(utcRewards(c)){
  assert.equal(c.alphaPPM,0,'UTC legacy emission disabled');
  assert.equal(c.periodMintLimit,'0');assert.equal(c.lifetimeMintLimit,'0');
  assert(!c.calendar,'UTC issuance uses the separately qualified century controller');
 }
}
export function rewardNotice(s,activation,expires,c){
 integer(activation,1);
 const now=rewardClock(s,c),minimum=utcRewards(c)?now+REWARD_NOTICE_SECONDS:expires+2;
 assert(activation>=minimum,'coefficient notice');
 assert(activation<=(utcRewards(c)?now+432000:expires+10000),'activation too distant');
}
