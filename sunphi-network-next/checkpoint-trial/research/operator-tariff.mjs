// Public terms in integer micro-DUBYT. The same values govern the ballot,
// work admission, daily close and offline replay.
export const OPERATOR_TARIFF = Object.freeze({
 version:'DUEBYTE_VERIFIED_WORK_TARIFF_V1', workerDayMicro:'4000000', witnessDayMicro:'1000000',
 workerSlots:16, witnessSlots:4, settlementPay:'EXISTING_CUSTOMER_FEES_ONLY',
 rounding:'FLOOR_ONCE_PER_NODE_AND_UTC_DAY', remainder:'RETAIN_IN_CLOSED_RESERVE',
 funding:'POSTED_RESERVE_OR_SAME_DAY_NET_ISSUANCE_BEFORE_PAYMENT'
});
export const tariffBudget = BigInt(OPERATOR_TARIFF.workerSlots)*BigInt(OPERATOR_TARIFF.workerDayMicro)
 + BigInt(OPERATOR_TARIFF.witnessSlots)*BigInt(OPERATOR_TARIFF.witnessDayMicro);
export const hasOperatorTariff = calendar => calendar?.closedFund?.tariff===OPERATOR_TARIFF.version;
