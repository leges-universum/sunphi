// Diagnostic output is expendable; wallet databases and verified history are
// never handled here. Pipe readers drain even when diagnostic storage fails.
import fs from 'node:fs';
import assert from 'node:assert/strict';
export class BoundedProcessLog{
 constructor(file,{bytes=2*1024*1024,copies=2,onError=()=>{}}={}){
  assert(Number.isSafeInteger(bytes)&&bytes>=1024&&bytes<=8*1024*1024);assert(Number.isInteger(copies)&&copies>=1&&copies<=4);Object.assign(this,{file,bytes,copies,onError,fd:null,closed:false,used:0});
  for(let i=0;i<=copies;i++){const name=file+(i?'.'+i:'');if(!fs.existsSync(name))continue;const s=fs.lstatSync(name);assert(s.isFile()&&!s.isSymbolicLink(),'regular diagnostic log required');if(s.size>bytes){const fd=fs.openSync(name,'r'),tail=Buffer.alloc(bytes);try{assert.equal(fs.readSync(fd,tail,0,bytes,s.size-bytes),bytes);}finally{fs.closeSync(fd);}fs.writeFileSync(name,tail,{mode:0o600});}}
  this.open();
 }
 open(){this.fd=fs.openSync(this.file,'a',0o600);this.used=fs.fstatSync(this.fd).size;}
 rotate(){fs.closeSync(this.fd);this.fd=null;for(let i=this.copies;i>=1;i--){const to=this.file+'.'+i,from=this.file+(i===1?'':'.'+(i-1));if(fs.existsSync(to))fs.unlinkSync(to);if(fs.existsSync(from))fs.renameSync(from,to);}this.open();}
 write(data){if(this.closed)return;try{const b=Buffer.isBuffer(data)?data:Buffer.from(data);let offset=0;while(offset<b.length){if(this.used===this.bytes)this.rotate();const length=Math.min(b.length-offset,this.bytes-this.used,65536),written=fs.writeSync(this.fd,b,offset,length);assert(written>0,'diagnostic write failed');offset+=written;this.used+=written;}}catch(e){this.close();this.onError(e);}}
 close(){if(this.closed)return;this.closed=true;if(this.fd!==null){fs.closeSync(this.fd);this.fd=null;}}
}
export function captureChildLog(child,log){child.stdout.on('data',b=>log.write(b));child.stderr.on('data',b=>log.write(b));child.once('close',()=>log.close());child.once('error',()=>log.close());}
