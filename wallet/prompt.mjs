import { emitKeypressEvents } from 'node:readline';

export function prompt(label,{secret=false,input=process.stdin,output=process.stdout}={}) {
  if(!input.isTTY||!output.isTTY)throw Error('An interactive terminal is required; passwords are not accepted as arguments or piped input');
  output.write(label);
  return new Promise((resolve,reject)=>{
    let value='',done=false;
    const wasRaw=!!input.isRaw;
    const finish=(error)=>{
      if(done)return;done=true;clearTimeout(timer);input.removeListener('keypress',onKey);
      input.setRawMode(wasRaw);input.pause();output.write('\n');
      if(error)reject(error);else resolve(value);value='';
    };
    const onKey=(text,key={})=>{
      if(key.ctrl&&key.name==='c')return finish(Error('Cancelled'));
      if(key.name==='return'||key.name==='enter')return finish();
      if(key.name==='backspace'){value=Array.from(value).slice(0,-1).join('');if(!secret)output.write('\b \b');return;}
      if(key.ctrl||key.meta||!text||/[\x00-\x1f\x7f]/.test(text))return;
      if(value.length+text.length>1024)return finish(Error('Input too long'));
      value+=text;if(!secret)output.write(text);
    };
    const timer=setTimeout(()=>finish(Error('Prompt expired')),300000);
    emitKeypressEvents(input);input.setRawMode(true);input.on('keypress',onKey);input.resume();
  });
}
