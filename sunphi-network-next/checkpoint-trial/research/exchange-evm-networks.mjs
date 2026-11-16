// Explicit network identities. These constants do not authorize a live route.
// Native USDC contracts: https://developers.circle.com/stablecoins/usdc-contract-addresses
// Ethereum genesis: ethereum/go-ethereum params/config.go.
import assert from 'node:assert/strict';
export const ETHEREUM_USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const ETHEREUM_GENESIS='d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3';
const networks=Object.freeze({
 ETHEREUM:Object.freeze({network:'ethereum-mainnet',chainId:'0x1',genesis:ETHEREUM_GENESIS,contract:ETHEREUM_USDC}),
 BASE:Object.freeze({network:'base-mainnet',chainId:'0x2105',genesis:'f712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd',contract:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'})
});
export function evmNetwork(chain){assert(Object.hasOwn(networks,chain),'explicit supported EVM network required');return networks[chain];}
