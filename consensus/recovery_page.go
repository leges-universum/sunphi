package main

import (
 "bytes"
 "context"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "net/url"
 "os"
 "sync"
 "time"
 cjson "github.com/cometbft/cometbft/libs/json"
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)

// Historical transport only. Unlike -verify this NEVER claims freshness and
// NEVER emits verified:true. The immutable trust root is supplied by the caller.
func checkRecoveryPage(a *receiptProof,g *types.GenesisDoc,height int64,hash string)(map[string]interface{},error){
 if a.Version!=1||len(a.Entries)<1||len(a.Entries)>128{return nil,fmt.Errorf("recovery page bound")}
 if height==0&&hash==""{
  x:=a.Entries[0];if x.Header==nil||x.Header.Header==nil||x.Header.Height!=1{return nil,fmt.Errorf("recovery genesis height")}
  initial:=make([]*types.Validator,len(g.Validators));for i,v:=range g.Validators{initial[i]=types.NewValidator(v.PubKey,v.Power)}
  if !bytes.Equal(types.NewValidatorSet(initial).Hash(),x.Header.ValidatorsHash){return nil,fmt.Errorf("recovery genesis committee")}
  height=1;hash=hex.EncodeToString(x.Header.Hash())
 }
 result,e:=checkReceiptProof(a,g,height,hash);if e!=nil{return nil,e}
 pins:=make([]map[string]interface{},0,len(a.Entries));for _,x:=range a.Entries{pins=append(pins,map[string]interface{}{"height":x.Header.Height,"hash":hex.EncodeToString(x.Header.Hash())})}
 result["verified"]=false;result["historyVerified"]=true;result["fresh"]=false;result["verifiedFrom"]=height;result["anchors"]=pins
 return result,nil
}

func recoveryPageCommand(endpoint,path,file string,anchorHeight int64,anchorHash string)error{
 g,e:=types.GenesisDocFromFile(path);if e!=nil{return e};var a receiptProof
 if endpoint!=""{
  u,e:=url.Parse(endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"||anchorHeight<0{return fmt.Errorf("isolated recovery endpoint")}
  c,e:=rpc.New(endpoint,"/websocket");if e!=nil{return e};ctx,cancel:=context.WithTimeout(context.Background(),6*time.Second);defer cancel()
  tip,e:=c.Commit(ctx,nil);if e!=nil{return e};start:=anchorHeight;if start==0{start=1};end:=start+127;if tip.Header.Height<end{end=tip.Header.Height};if end<start{return fmt.Errorf("recovery RPC rollback")}
  a.Version=1;a.Entries=make([]historyEntry,end-start+1)
  for batch:=start;batch<=end;batch+=4{
   n:=int64(4);if end-batch+1<n{n=end-batch+1};errs:=make([]error,n);var wg sync.WaitGroup
   for i:=int64(0);i<n;i++{wg.Add(1);go func(i int64){defer wg.Done();at:=batch+i;h,err:=c.Commit(ctx,&at);if err!=nil{errs[i]=err;return};page,per:=1,100;v,err:=c.Validators(ctx,&at,&page,&per);if err!=nil{errs[i]=err;return};if h.Header.Height!=at||v.BlockHeight!=at||v.Total!=10||len(v.Validators)!=10{errs[i]=fmt.Errorf("recovery RPC height or committee");return};a.Entries[at-start]=historyEntry{Header:&h.SignedHeader,Validators:v.Validators,Txs:[]types.Tx{}}}(i)}
   wg.Wait();for _,err:=range errs{if err!=nil{return err}}
  }
 }else{
  st,e:=os.Stat(file);if e!=nil{return e};if st.Size()<1||st.Size()>2<<20{return fmt.Errorf("recovery file bound")};b,e:=os.ReadFile(file);if e!=nil{return e};if e=cjson.Unmarshal(b,&a);e!=nil{return e}
 }
 result,e:=checkRecoveryPage(&a,g,anchorHeight,anchorHash);if e!=nil{return e}
 if endpoint!=""{b,e:=cjson.Marshal(a);if e!=nil{return e};if len(b)>2<<20{return fmt.Errorf("recovery export bound")};_,e=os.Stdout.Write(b);return e}
 return json.NewEncoder(os.Stdout).Encode(result)
}
