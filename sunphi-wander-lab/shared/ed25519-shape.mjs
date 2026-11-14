// Public-data encoding guards matching the guest's ed25519-dalek verify_strict.
// These are NOT a replacement for the platform's curve/equation verification.
// Low-order y coordinates cross-checked against libsodium1.0.18 ref10:
// https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c
const hex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
const lowY=[
 '00'.repeat(32),'01'+'00'.repeat(31),
 '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
 ...['ec','ed','ee'].map(x=>x+'ff'.repeat(30)+'7f')
].map(hex);
const field=hex('ed'+'ff'.repeat(30)+'7f');
const order=hex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
function below(a,b,mask=255){for(let i=31;i>=0;i--){const x=a[i]&(i===31?mask:255);if(x!==b[i])return x<b[i];}return false;}
export function smallOrderEncoding(a){if(a.length!==32)return true;return lowY.some(y=>{for(let i=0;i<32;i++)if((a[i]&(i===31?127:255))!==y[i])return false;return true;});}
export function strictSignatureShape(key,signature){
 if(key.length!==32||signature.length!==64||smallOrderEncoding(key))return false;
 const r=signature.subarray(0,32);
 return !smallOrderEncoding(r)&&below(r,field,127)&&below(signature.subarray(32),order);
}
