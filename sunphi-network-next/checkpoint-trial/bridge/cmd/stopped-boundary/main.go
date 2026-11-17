// Offline operator tool. Opens existing Comet stores read-only; never starts a node.
package main

import (
 "bytes"
 "encoding/hex"
 "encoding/base64"
 "encoding/json"
 "flag"
 "fmt"
 "io"
 "os"
 "path/filepath"
 "strconv"

 dbm "github.com/cometbft/cometbft-db"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/store"
 "github.com/syndtr/goleveldb/leveldb/opt"
)

type request struct {
 Home string `json:"home"`
 Network string `json:"network"`
 Height int64 `json:"height"`
 AppHash string `json:"appHash"`
 BlockHash string `json:"blockHash"`
 DiscoverBlock bool `json:"discoverBlock,omitempty"`
 Validators []member `json:"validators"`
}
type member struct { Key string `json:"key"`; Power int64 `json:"power"` }
func inspect(q request) (map[string]interface{}, error) {
 if q.Height < 1 || q.Network == "" { return nil, fmt.Errorf("invalid stopped boundary") }
 if q.DiscoverBlock && q.BlockHash!="" {return nil,fmt.Errorf("discovery cannot replace a supplied block hash")}
 hashes:=[]string{q.AppHash};if !q.DiscoverBlock{hashes=append(hashes,q.BlockHash)}
 for _, s := range hashes { b,e:=hex.DecodeString(s); if e!=nil || len(b)!=32 {return nil,fmt.Errorf("invalid trusted hash")} }
 expected:=map[string]int64{}
 if len(q.Validators)==0||len(q.Validators)>256{return nil,fmt.Errorf("trusted validator set required")}
 for _,v:=range q.Validators{key,e:=base64.RawURLEncoding.DecodeString(v.Key);if e!=nil||len(key)!=32||v.Power<1||v.Power>1000000{return nil,fmt.Errorf("invalid trusted validator")};if _,ok:=expected[v.Key];ok{return nil,fmt.Errorf("duplicate trusted validator")};expected[v.Key]=v.Power}
 watermark,e:=os.ReadFile(filepath.Join(q.Home,"data","priv_validator_state.json"));if e!=nil{return nil,fmt.Errorf("missing signing watermark")}
 var signed struct{Height string `json:"height"`}
 if e=json.Unmarshal(watermark,&signed);e!=nil{return nil,fmt.Errorf("invalid signing watermark")}
 signedHeight,e:=strconv.ParseInt(signed.Height,10,64)
 if e!=nil||signedHeight<0||signedHeight>q.Height{return nil,fmt.Errorf("signing watermark exceeds stopped boundary; forward reconciliation required")}
 // A missing database must fail, never create a new state or repair corruption.
 data:=filepath.Join(q.Home,"data")
 for _, name:=range []string{"state.db","blockstore.db"} { p:=filepath.Join(data,name); st,e:=os.Lstat(p); if e!=nil || !st.IsDir() || st.Mode()&os.ModeSymlink!=0 {return nil,fmt.Errorf("missing regular database directory")} }
 options:=&opt.Options{ReadOnly:true,ErrorIfMissing:true,Strict:opt.StrictAll}
 stateDB,e:=dbm.NewGoLevelDBWithOpts("state",data,options); if e!=nil{return nil,e}; defer stateDB.Close()
 blockDB,e:=dbm.NewGoLevelDBWithOpts("blockstore",data,options); if e!=nil{return nil,e}; defer blockDB.Close()
 states:=sm.NewStore(stateDB,sm.StoreOptions{}); state,e:=states.Load(); if e!=nil{return nil,e}
 blocks:=store.NewBlockStore(blockDB)
 if state.ChainID!=q.Network || state.LastBlockHeight!=q.Height || blocks.Height()!=q.Height {return nil,fmt.Errorf("stored commit/application boundary requires forward reconciliation")}
 if q.DiscoverBlock {q.BlockHash=hex.EncodeToString(state.LastBlockID.Hash)}
 if hex.EncodeToString(state.AppHash)!=q.AppHash || hex.EncodeToString(state.LastBlockID.Hash)!=q.BlockHash {return nil,fmt.Errorf("stopped state differs from trusted boundary")}
 block:=blocks.LoadBlock(q.Height); if block==nil || hex.EncodeToString(block.Hash())!=q.BlockHash || block.ChainID!=q.Network {return nil,fmt.Errorf("stopped block mismatch")}
 validators,e:=states.LoadValidators(q.Height); if e!=nil{return nil,e}
 if len(validators.Validators)!=len(expected){return nil,fmt.Errorf("native validator count differs from trusted set")}
 for _,v:=range validators.Validators{if expected[base64.RawURLEncoding.EncodeToString(v.PubKey.Bytes())]!=v.VotingPower{return nil,fmt.Errorf("native voting authority differs from trusted set")}}
 if hex.EncodeToString(validators.Hash())!=hex.EncodeToString(block.ValidatorsHash) {return nil,fmt.Errorf("validator set mismatch")}
 commit:=blocks.LoadSeenCommit(q.Height); if commit==nil {commit=blocks.LoadBlockCommit(q.Height)}
 if commit==nil || !commit.BlockID.Equals(state.LastBlockID) {return nil,fmt.Errorf("missing matching commit")}
 if e=validators.VerifyCommitLight(q.Network,commit.BlockID,q.Height,commit);e!=nil{return nil,e}
 return map[string]interface{}{"network":q.Network,"committedHeight":blocks.Height(),"appliedHeight":state.LastBlockHeight,"appHash":q.AppHash,"blockHash":q.BlockHash,"commitVerified":true,"readOnly":true},nil
}
func readRequest(r io.Reader) (request,error) {
 var q request
 data,e:=io.ReadAll(io.LimitReader(r,65537));if e!=nil||len(data)>65536{return q,fmt.Errorf("request too large")}
 d:=json.NewDecoder(bytes.NewReader(data)); d.DisallowUnknownFields()
 if e:=d.Decode(&q);e!=nil{return q,fmt.Errorf("invalid request")}
 var extra interface{}
 if e:=d.Decode(&extra);e!=io.EOF{return q,fmt.Errorf("trailing request data")}
 return q,nil
}
func main(){flag.Parse();if flag.NArg()!=0{fmt.Fprintln(os.Stderr,"input must be supplied on stdin");os.Exit(1)};q,e:=readRequest(os.Stdin);if e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)};result,e:=inspect(q);if e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)};if e=json.NewEncoder(os.Stdout).Encode(result);e!=nil{os.Exit(1)}}
