// Isolated fault-injection utility. Not included in release packages.
package main

import (
 "bytes"
 "context"
 "flag"
 "fmt"
 "net/url"
 "os"
 "path/filepath"
 "time"
 cjson "github.com/cometbft/cometbft/libs/json"
 "github.com/cometbft/cometbft/privval"
 proto "github.com/cometbft/cometbft/proto/tendermint/types"
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 "github.com/cometbft/cometbft/types"
)

func main(){
 home:=flag.String("home","","synthetic laboratory node directory");endpoint:=flag.String("rpc","","loopback laboratory RPC");height:=flag.Int64("height",0,"committed laboratory infraction height");output:=flag.String("output","","new public evidence file");flag.Parse()
 u,e:=url.Parse(*endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"||*height<1{panic("loopback laboratory required")}
 g,e:=types.GenesisDocFromFile(filepath.Join(*home,"config","genesis.json"));if e!=nil{panic(e)};if g.ChainID!="duebyte-trial-pos-slashing-lab"{panic("synthetic PoS lab chain only")}
 raw,e:=os.ReadFile(filepath.Join(*home,"config","priv_validator_key.json"));if e!=nil{panic(e)};var key privval.FilePVKey;if e=cjson.Unmarshal(raw,&key);e!=nil{panic(e)}
 c,e:=rpc.New(*endpoint,"/websocket");if e!=nil{panic(e)};ctx,cancel:=context.WithTimeout(context.Background(),15*time.Second);defer cancel()
 b,e:=c.Block(ctx,height);if e!=nil{panic(e)};if b.Block.ChainID!=g.ChainID{panic("RPC chain mismatch")};page,per:=1,100;v,e:=c.Validators(ctx,height,&page,&per);if e!=nil{panic(e)};if v.Total!=len(v.Validators)||v.Total!=10{panic("ten synthetic lab signers required")}
 set:=types.NewValidatorSet(v.Validators);index,validator:=set.GetByAddress(key.PubKey.Address());if validator==nil{panic("lab signer absent")}
 a:=&types.Vote{Type:proto.PrecommitType,Height:*height,Round:0,BlockID:b.BlockID,Timestamp:b.Block.Time,ValidatorAddress:validator.Address,ValidatorIndex:index}
 second:=*a;second.BlockID=types.BlockID{Hash:bytes.Repeat([]byte{42},32),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{43},32)}}
 for _,vote:=range []*types.Vote{a,&second}{p:=vote.ToProto();vote.Signature,e=key.PrivKey.Sign(types.VoteSignBytes(g.ChainID,p));if e!=nil{panic(e)}}
 evidence,e:=types.NewDuplicateVoteEvidence(a,&second,b.Block.Time,set);if e!=nil{panic(e)};if e=evidence.ValidateBasic();e!=nil{panic(e)}
 data,e:=cjson.Marshal(evidence);if e!=nil{panic(e)};file,e:=os.OpenFile(*output,os.O_CREATE|os.O_EXCL|os.O_WRONLY,0600);if e!=nil{panic(e)};if _,e=file.Write(data);e!=nil{panic(e)};if e=file.Close();e!=nil{panic(e)}
 fmt.Println("Prepared signed duplicate-vote evidence for synthetic lab only")
}
