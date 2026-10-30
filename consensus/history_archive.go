package main

import (
 "bytes"
 "context"
 "encoding/hex"
 "encoding/base64"
 "encoding/json"
 "fmt"
 "net/url"
 "os"
 "time"
 cjson "github.com/cometbft/cometbft/libs/json"
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)

// Each bounded archive has eight executed blocks plus the ninth signed header
// committing their resulting application state. No snapshot is trusted here.
type historyEntry struct {
 Header *types.SignedHeader `json:"header"`
 Validators []*types.Validator `json:"validators"`
 Txs []types.Tx `json:"txs"`
}
type historyArchive struct { Version int `json:"version"`; Entries []historyEntry `json:"entries"` }
func checkHistoryArchive(a *historyArchive,g *types.GenesisDoc,anchorHeight int64,anchorHash string)(map[string]interface{},error){
 if a.Version!=1||len(a.Entries)!=9{return nil,fmt.Errorf("bounded nine-header archive required")}
 pin,e:=hex.DecodeString(anchorHash);if e!=nil||(anchorHeight>0&&len(pin)!=32)||(anchorHeight==0&&anchorHash!=""){return nil,fmt.Errorf("invalid retained anchor")}
 var prev *types.SignedHeader
 initial:=make([]*types.Validator,len(g.Validators));for i,v:=range g.Validators{initial[i]=types.NewValidator(v.PubKey,v.Power)}
 for i,x:=range a.Entries{
  if x.Header==nil||x.Header.Header==nil||x.Header.Commit==nil||len(x.Validators)!=10{return nil,fmt.Errorf("invalid archive header or committee")}
  seen:=map[string]bool{};for _,v:=range x.Validators{if v==nil||v.PubKey==nil||v.VotingPower!=10||v.PubKey.Type()!="ed25519"||!bytes.Equal(v.Address,v.PubKey.Address())||seen[string(v.Address)]{return nil,fmt.Errorf("invalid archive validator")};seen[string(v.Address)]=true}
  set:=types.NewValidatorSet(x.Validators)
  if i==0{
   if anchorHeight==0{if x.Header.Height!=1||!bytes.Equal(set.Hash(),types.NewValidatorSet(initial).Hash()){return nil,fmt.Errorf("untrusted genesis start")}}else if x.Header.Height!=anchorHeight||!bytes.Equal(x.Header.Hash(),pin){return nil,fmt.Errorf("retained anchor mismatch")}
   if (x.Header.Height-1)%8!=0{return nil,fmt.Errorf("epoch alignment")}
  }
  if e=verifyLinkedHeader(g.ChainID,x.Header,set,prev);e!=nil{return nil,e}
  if i<8{
   if len(x.Txs)>16{return nil,fmt.Errorf("transaction count")};size:=0;for _,tx:=range x.Txs{size+=len(tx)};if size>1<<20{return nil,fmt.Errorf("block size")}
   data:=types.Data{Txs:types.Txs(x.Txs)};if !bytes.Equal(data.Hash(),x.Header.DataHash){return nil,fmt.Errorf("archive transaction commitment mismatch")}
  }else if len(x.Txs)!=0{return nil,fmt.Errorf("checkpoint header cannot contain replay payload")}
  prev=x.Header
 }
 entries:=make([]map[string]interface{},0,9)
 for _,x:=range a.Entries{txs:=make([]string,0,len(x.Txs));for _,tx:=range x.Txs{txs=append(txs,base64.StdEncoding.EncodeToString(tx))};entries=append(entries,map[string]interface{}{"height":x.Header.Height,"hash":hex.EncodeToString(x.Header.Hash()),"appHash":hex.EncodeToString(x.Header.AppHash),"txs":txs})}
 return map[string]interface{}{"verified":true,"chainId":g.ChainID,"fromHeight":a.Entries[0].Header.Height,"endHeight":prev.Height-1,"headerHeight":prev.Height,"headerHash":hex.EncodeToString(prev.Hash()),"appHash":hex.EncodeToString(prev.AppHash),"payload":map[string]interface{}{"version":2,"chainId":g.ChainID,"entries":entries}},nil
}
func historyCommand(endpoint,path,file string,end,anchorHeight int64,anchorHash string)error{
 g,e:=types.GenesisDocFromFile(path);if e!=nil{return e}
 var a historyArchive
 if endpoint!=""{
  u,e:=url.Parse(endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"||end<8||end%8!=0{return fmt.Errorf("isolated aligned archive export required")}
  c,e:=rpc.New(endpoint,"/websocket");if e!=nil{return e};ctx,cancel:=context.WithTimeout(context.Background(),60*time.Second);defer cancel()
  a.Version=1
  for at:=end-7;at<=end+1;at++{
   h,e:=c.Commit(ctx,&at);if e!=nil{return e};page,per:=1,100;v,e:=c.Validators(ctx,&at,&page,&per);if e!=nil{return e};if v.BlockHeight!=at||v.Total!=10{return fmt.Errorf("archive validator response")}
   x:=historyEntry{Header:&h.SignedHeader,Validators:v.Validators,Txs:[]types.Tx{}}
   if at<=end{b,e:=c.Block(ctx,&at);if e!=nil{return e};if b.Block.Height!=at||!bytes.Equal(b.Block.Hash(),h.Header.Hash()){return fmt.Errorf("archive block/header mismatch")};for _,tx:=range b.Block.Txs{x.Txs=append(x.Txs,tx)}}
   a.Entries=append(a.Entries,x)
  }
 }else{
  st,e:=os.Stat(file);if e!=nil{return e};if st.Size()<1||st.Size()>16<<20{return fmt.Errorf("archive file bound")}
  b,e:=os.ReadFile(file);if e!=nil{return e};if e=cjson.Unmarshal(b,&a);e!=nil{return e}
 }
 result,e:=checkHistoryArchive(&a,g,anchorHeight,anchorHash);if e!=nil{return e}
 if endpoint!=""{b,e:=cjson.Marshal(a);if e!=nil{return e};if len(b)>16<<20{return fmt.Errorf("archive too large")};_,e=os.Stdout.Write(b);return e}
 return json.NewEncoder(os.Stdout).Encode(result)
}
