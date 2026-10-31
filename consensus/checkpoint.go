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
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)
// Static-set laboratory light verification. The trust root is the locally
// retained genesis, not a validator list downloaded from the RPC being checked.
func verifyCheckpoint(endpoint,path string,height int64,expected string)error{
 u,e:=url.Parse(endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"{return fmt.Errorf("isolated loopback RPC required")}
 g,e:=types.GenesisDocFromFile(path);if e!=nil{return e}
 vals:=make([]*types.Validator,len(g.Validators));for i,v:=range g.Validators{vals[i]=types.NewValidator(v.PubKey,v.Power)}
 set:=types.NewValidatorSet(vals)
 client,e:=rpc.New(endpoint,"/websocket");if e!=nil{return e}
 ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second);defer cancel()
 var h *int64;if height>0{h=&height}
 r,e:=client.Commit(ctx,h);if e!=nil{return e}
 if e=r.SignedHeader.ValidateBasic(g.ChainID);e!=nil{return e}
 if !bytes.Equal(set.Hash(),r.Header.ValidatorsHash)||!bytes.Equal(set.Hash(),r.Header.NextValidatorsHash){return fmt.Errorf("unexpected validator set")}
 if e=set.VerifyCommitLight(g.ChainID,r.Commit.BlockID,r.Header.Height,r.Commit);e!=nil{return e}
 if !bytes.Equal(r.Header.Hash(),r.Commit.BlockID.Hash){return fmt.Errorf("header hash mismatch")}
 age:=time.Since(r.Header.Time);if age>180*time.Second||age < -30*time.Second{return fmt.Errorf("stale or future checkpoint")}
 if expected!=""{b,e:=hex.DecodeString(expected);if e!=nil||!bytes.Equal(b,r.Header.AppHash){return fmt.Errorf("application checkpoint mismatch")}}
 signatures:=0;for _,s:=range r.Commit.Signatures{if s.BlockIDFlag==types.BlockIDFlagCommit{signatures++}}
 return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"verified":true,"chain":g.ChainID,"headerHeight":r.Header.Height,"headerHash":hex.EncodeToString(r.Header.Hash()),"applicationHeight":r.Header.Height-1,"appHash":hex.EncodeToString(r.Header.AppHash),"commitSignatures":signatures,"validators":len(vals),"trust":"locally pinned static genesis; <1/3 Byzantine weight; fresh clock"})
}
