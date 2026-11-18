package main

import (
 "context"
 "encoding/base64"
 "encoding/json"
 "fmt"
 "testing"
 "github.com/cometbft/cometbft/crypto/ed25519"
 rpctypes "github.com/cometbft/cometbft/rpc/core/types"
 "github.com/cometbft/cometbft/types"
)

func authorityFixture(n,version int)(*types.GenesisDoc,[]*types.Validator){
 g:=&types.GenesisDoc{ChainID:"isolated-proof-authority"};vals:=[]*types.Validator{};members:=[]map[string]interface{}{}
 for i:=0;i<n;i++{key:=ed25519.GenPrivKey().PubKey();power:=int64(10);if version==2{power+=int64(i%3)};g.Validators=append(g.Validators,types.GenesisValidator{PubKey:key,Power:power});vals=append(vals,types.NewValidator(key,power));m:=map[string]interface{}{"key":base64.RawURLEncoding.EncodeToString(key.Bytes())};if version==2{m["power"]=power};members=append(members,m)}
 control:=map[string]interface{}{"validators":members};if version==2{control["version"]=2};g.AppState,_=json.Marshal(map[string]interface{}{"control":control});return g,vals
}
func TestGenesisProofAuthorityVersionBinding(t *testing.T){
 for _,n:=range []int{4,10,11,101,256}{g,vs:=authorityFixture(n,2);set,version,e:=genesisProofAuthority(g);if e!=nil||version!=2||set.TotalVotingPower()!=types.NewValidatorSet(vs).TotalVotingPower(){t.Fatalf("size %d: %v",n,e)};g.Validators[0].Power++;if _,_,e=genesisProofAuthority(g);e==nil{t.Fatal("unbound genesis power")}}
 g,_:=authorityFixture(10,1);if _,v,e:=genesisProofAuthority(g);e!=nil||v!=1{t.Fatal(e)}
 for _,n:=range []int{3,257}{g,_=authorityFixture(n,2);if _,_,e:=genesisProofAuthority(g);e==nil{t.Fatal("accepted out-of-envelope set")}}
 g,_=authorityFixture(11,2);g.AppState=[]byte(`{"control":{"version":1}}`);if _,_,e:=genesisProofAuthority(g);e==nil{t.Fatal("implicit authority upgrade")}
 g,_=authorityFixture(10,1);g.AppState=[]byte(`{"control":{"version":3}}`);if _,_,e:=genesisProofAuthority(g);e==nil{t.Fatal("unknown version")}
 g,vs:=authorityFixture(4,2);vs[1]=vs[0];if validateProofValidators(vs,2)==nil{t.Fatal("duplicate key")};g.Validators[1]=g.Validators[0];if _,_,e:=genesisProofAuthority(g);e==nil{t.Fatal("duplicate genesis")}
}
type proofPages struct{vals []*types.Validator;calls int;fault string}
func(p *proofPages)Validators(_ context.Context,h *int64,page,per *int)(*rpctypes.ResultValidators,error){
 p.calls++;if *h!=42||*per!=100{return nil,fmt.Errorf("unexpected pagination")};start:=(*page-1)*(*per);end:=start+*per;if end>len(p.vals){end=len(p.vals)};r:=&rpctypes.ResultValidators{BlockHeight:*h,Validators:p.vals[start:end],Count:end-start,Total:len(p.vals)}
 if *page==2{switch p.fault{case "total":r.Total--;case "height":r.BlockHeight++;case "short":r.Validators=r.Validators[:len(r.Validators)-1];r.Count--;case "duplicate":r.Validators=append([]*types.Validator{},r.Validators...);r.Validators[0]=p.vals[0];case "error":return nil,fmt.Errorf("disconnected")}};return r,nil
}
func TestProofPaginationAuthenticatesEntireSet(t *testing.T){
 _,vs:=authorityFixture(256,2);digest:=types.NewValidatorSet(vs).Hash();p:=&proofPages{vals:vs};got,e:=fetchProofValidators(context.Background(),p,42,digest,2);if e!=nil||len(got)!=256||p.calls!=3{t.Fatalf("pagination: %d %v",p.calls,e)}
 for _,fault:=range []string{"total","height","short","duplicate","error"}{p=&proofPages{vals:vs,fault:fault};if _,e=fetchProofValidators(context.Background(),p,42,digest,2);e==nil{t.Fatalf("accepted %s",fault)}}
 p=&proofPages{vals:vs};if _,e=fetchProofValidators(context.Background(),p,42,make([]byte,32),2);e==nil{t.Fatal("hash substitution")}
 p=&proofPages{vals:vs};if _,e=fetchProofValidators(context.Background(),p,42,digest,1);e==nil{t.Fatal("legacy silently upgraded")}
}
