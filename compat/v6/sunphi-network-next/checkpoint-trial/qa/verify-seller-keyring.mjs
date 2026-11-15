import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifySellerKeyring} from '../research/seller-keyring.mjs';
let password;
try{
 assert.equal(process.argv.length,5);const [file,pin,profilePin]=process.argv.slice(2);
 const st=fs.statSync(file);assert(st.isFile()&&st.size<=32768);
 const bytes=fs.readFileSync(file);assert.equal(createHash('sha256').update(bytes).digest('hex'),pin);
 // Read a bounded stdin, even for malformed or accidentally unbounded input.
 password=Buffer.alloc(4097);let n=0;for await(const chunk of process.stdin){assert(n+chunk.length<=4096);chunk.copy(password,n);n+=chunk.length;chunk.fill(0);}
 assert(n>=16&&n<=4096);
 console.log(JSON.stringify(verifySellerKeyring(JSON.parse(bytes),password.subarray(0,n),profilePin)));
}catch{process.stderr.write('Seller key backup verification failed.\n');process.exitCode=1;}
finally{password?.fill(0);}
