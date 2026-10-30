package main

import (
 "bytes"
 "context"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "net/url"
 "os"
 "time"
 cjson "github.com/cometbft/cometbft/libs/json"
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)

// Historical payment evidence is portable, but NEVER supplies its own trust
// anchor. The caller pins a separately authenticated retained witness seal.
type receiptProof struct { Version int `json:"version"`; Entries []historyEntry `json:"entries"` }
func checkReceiptProof(a *receiptProof,g *types.GenesisDoc,height int64,hash string)(map[string]interface{},error){
 pin,e:=hex.DecodeString(hash)
 if e!=nil||len(pin)!=32||height<1||(a.Version!=1&&a.Version!=2)||len(a.Entries)<1||len(a.Entries)>128{return nil,fmt.Errorf("receipt proof bounds or anchor")}
 var prev *types.SignedHeader
 for i,x:=range a.Entries{
  if x.Header==nil||x.Header.Header==nil||x.Header.Commit==nil||len(x.Validators)!=10||len(x.Txs)!=0{return nil,fmt.Errorf("receipt header shape")}
  seen:=map[string]bool{}
  for _,v:=range x.Validators{if v==nil||v.PubKey==nil||v.VotingPower!=10||v.PubKey.Type()!="ed25519"||!bytes.Equal(v.Address,v.PubKey.Address())||seen[string(v.Address)]{return nil,fmt.Errorf("receipt committee")};seen[string(v.Address)]=true}
  if a.Version==1&&i==0&&(x.Header.Height!=height||!bytes.Equal(x.Header.Hash(),pin)){return nil,fmt.Errorf("receipt retained anchor mismatch")}
  if e=verifyLinkedHeader(g.ChainID,x.Header,types.NewValidatorSet(x.Validators),prev);e!=nil{return nil,e};prev=x.Header
 }
 if a.Version==2{
  // The FINAL independently sealed hash authenticates all preceding linked
  // headers. Reusing stolen old validator keys cannot replace that hash chain.
  if prev.Height!=height||!bytes.Equal(prev.Hash(),pin){return nil,fmt.Errorf("receipt final sealed anchor mismatch")}
  prev=a.Entries[0].Header
 }
 return map[string]interface{}{"verified":true,"chain":g.ChainID,"headerHeight":prev.Height,"headerHash":hex.EncodeToString(prev.Hash()),"applicationHeight":prev.Height-1,"appHash":hex.EncodeToString(prev.AppHash)},nil
}
func receiptCommand(endpoint,path,file string,end,anchorHeight int64,anchorHash string)error{
 g,e:=types.GenesisDocFromFile(path);if e!=nil{return e};var a receiptProof
 if endpoint!=""{
  u,e:=url.Parse(endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"||anchorHeight<1||end<anchorHeight||end-anchorHeight>=128{return fmt.Errorf("bounded isolated receipt export required")}
  c,e:=rpc.New(endpoint,"/websocket");if e!=nil{return e};ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second);defer cancel();a.Version=1
  for at:=anchorHeight;at<=end;at++{
   h,e:=c.Commit(ctx,&at);if e!=nil{return e};page,per:=1,100;v,e:=c.Validators(ctx,&at,&page,&per);if e!=nil{return e}
   if h.Header.Height!=at||v.BlockHeight!=at||v.Total!=10{return fmt.Errorf("receipt RPC height or committee")}
   a.Entries=append(a.Entries,historyEntry{Header:&h.SignedHeader,Validators:v.Validators,Txs:[]types.Tx{}})
  }
 }else{
  st,e:=os.Stat(file);if e!=nil{return e};if st.Size()<1||st.Size()>2<<20{return fmt.Errorf("receipt file bound")}
  b,e:=os.ReadFile(file);if e!=nil{return e};if e=cjson.Unmarshal(b,&a);e!=nil{return e}
 }
 result,e:=checkReceiptProof(&a,g,anchorHeight,anchorHash);if e!=nil{return e}
 if endpoint!=""{b,e:=cjson.Marshal(a);if e!=nil{return e};if len(b)>2<<20{return fmt.Errorf("receipt export bound")};_,e=os.Stdout.Write(b);return e}
 return json.NewEncoder(os.Stdout).Encode(result)
}
