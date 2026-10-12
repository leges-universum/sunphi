import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { canonical } from './crypto.mjs';

const MAX_BYTES=128*1024;
export async function readRecord(path) {
  if(!(await lstat(path)).isFile())throw Error('Expected a regular file, not a link or directory');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    if(!(await handle.stat()).isFile())throw Error('Expected a regular file');
    const buffer=Buffer.alloc(MAX_BYTES+1);
    let size=0;
    while(size<buffer.length) {
      const {bytesRead}=await handle.read(buffer,size,buffer.length-size,null);
      if(!bytesRead)break;size+=bytesRead;
    }
    if(size>MAX_BYTES)throw Error('File exceeds 128 KiB');
    const text=buffer.subarray(0,size).toString('utf8').trim();
    const value=JSON.parse(text);
    // Also rejects duplicate JSON keys, ambiguous numbers and alternate encodings.
    if(canonical(value)!==text)throw Error('Expected canonical SunPhi JSON; do not edit package files');
    return value;
  } finally { await handle.close(); }
}
export async function writeNew(path,value) {
  const bytes=Buffer.from(canonical(value)+'\n');
  if(bytes.length>MAX_BYTES)throw Error('File exceeds 128 KiB');
  // Exclusive creation: never overwrite a wallet, backup, package or symlink.
  const handle=await open(path,'wx',0o600);
  try { await handle.writeFile(bytes);await handle.sync(); }
  finally { await handle.close(); }
}
