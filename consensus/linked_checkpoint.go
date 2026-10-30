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
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)

func verifyLinkedHeader(chain string,h *types.SignedHeader,set *types.ValidatorSet,previous *types.SignedHeader)error{
 if e:=h.ValidateBasic(chain);e!=nil{return e}
 if !bytes.Equal(set.Hash(),h.Header.ValidatorsHash){return fmt.Errorf("validator set hash mismatch")}
 if !bytes.Equal(h.Header.Hash(),h.Commit.BlockID.Hash){return fmt.Errorf("header/commit mismatch")}
 if previous!=nil{
  if h.Height!=previous.Height+1||!h.Header.LastBlockID.Equals(previous.Commit.BlockID)||!h.Time.After(previous.Time){return fmt.Errorf("broken history link")}
  if !bytes.Equal(previous.NextValidatorsHash,set.Hash()){return fmt.Errorf("unauthenticated committee transition")}
 }
 return set.VerifyCommitLight(chain,h.Commit.BlockID,h.Height,h.Commit)
}

// Verify every adjacent signed header. A set fetched from RPC is usable ONLY
// after its hash matches the preceding authenticated NextValidatorsHash.
// A retained hash additionally fixes history against RPC rollback/equivocation.
// This is not forward-secure signing or protection from quorum key compromise.
func verifyLinkedCheckpoint(endpoint,path string,height int64,expected string,anchorHeight int64,anchorHash string)error{
 u,e:=url.Parse(endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"{return fmt.Errorf("isolated loopback RPC required")}
 g,e:=types.GenesisDocFromFile(path);if e!=nil{return e}
 var cfg struct{Governance json.RawMessage `json:"governance"`};if e=json.Unmarshal(g.AppState,&cfg);e!=nil{return e}
 if anchorHeight==0&&anchorHash==""&&len(cfg.Governance)==0{return verifyCheckpoint(endpoint,path,height,expected)}
 if (anchorHeight==0)!=(anchorHash=="")||anchorHeight<0{return fmt.Errorf("both trusted height and hash required")}
 pin,e:=hex.DecodeString(anchorHash);if e!=nil||(anchorHeight>0&&len(pin)!=32){return fmt.Errorf("invalid trusted hash")}
 c,e:=rpc.New(endpoint,"/websocket");if e!=nil{return e}
 ctx,cancel:=context.WithTimeout(context.Background(),120*time.Second);defer cancel()
 if height==0{r,e:=c.Commit(ctx,nil);if e!=nil{return e};height=r.Header.Height}
 start:=g.InitialHeight;if start==0{start=1};if anchorHeight>0{start=anchorHeight}
 if height<start{return fmt.Errorf("checkpoint rollback below retained height")}
 if height-start>5000{return fmt.Errorf("bounded verification window exceeded; retain incremental checkpoints")}
 vals:=make([]*types.Validator,len(g.Validators));for i,v:=range g.Validators{vals[i]=types.NewValidator(v.PubKey,v.Power)}
 set:=types.NewValidatorSet(vals);var prev *types.SignedHeader
 calls,transitions:=0,0;began:=time.Now()
 for batch:=start;batch<=height;batch+=8{
  n:=int64(8);if height-batch+1<n{n=height-batch+1}
  headers:=make([]*types.SignedHeader,n);errs:=make([]error,n);var wg sync.WaitGroup
  // Bounded concurrent I/O, deterministic ordered cryptographic verification.
  for i:=int64(0);i<n;i++{wg.Add(1);go func(i int64){defer wg.Done();at:=batch+i;r,err:=c.Commit(ctx,&at);errs[i]=err;if err==nil{headers[i]=&r.SignedHeader}}(i)};wg.Wait();calls+=int(n)
  for i,h:=range headers{
   if errs[i]!=nil{return errs[i]};if h.Height!=batch+int64(i){return fmt.Errorf("RPC returned wrong height")}
   if prev==nil&&anchorHeight>0&&!bytes.Equal(h.Hash(),pin){return fmt.Errorf("retained checkpoint hash mismatch")}
   if !bytes.Equal(set.Hash(),h.ValidatorsHash){
    if prev==nil&&anchorHeight==0{return fmt.Errorf("untrusted initial validator set")}
    at:=h.Height;page,per:=1,100;r,e:=c.Validators(ctx,&at,&page,&per);calls++;if e!=nil{return e}
    if r.BlockHeight!=at||r.Total!=10||len(r.Validators)!=10{return fmt.Errorf("invalid validator set size")}
    set=types.NewValidatorSet(r.Validators);for _,v:=range set.Validators{if v.VotingPower!=10||v.PubKey.Type()!="ed25519"{return fmt.Errorf("unexpected voting model")}}
    transitions++
   }
   if e=verifyLinkedHeader(g.ChainID,h,set,prev);e!=nil{return e};prev=h
  }
 }
 age:=time.Since(prev.Time);if age>180*time.Second||age < -30*time.Second{return fmt.Errorf("stale or future checkpoint")}
 if expected!=""{b,e:=hex.DecodeString(expected);if e!=nil||len(b)!=32||!bytes.Equal(b,prev.AppHash){return fmt.Errorf("application checkpoint mismatch")}}
 return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"verified":true,"chain":g.ChainID,"headerHeight":prev.Height,"headerHash":hex.EncodeToString(prev.Hash()),"applicationHeight":prev.Height-1,"appHash":hex.EncodeToString(prev.AppHash),"validators":len(set.Validators),"verifiedFrom":start,"headersChecked":height-start+1,"rpcCalls":calls,"setLoads":transitions,"elapsedMs":time.Since(began).Milliseconds(),"trust":"pinned genesis or independently retained header; linked quorum signatures; <1/3 Byzantine per active set; fresh clock"})
}
