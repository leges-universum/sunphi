package main

import (
 "bytes"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "strconv"
 "strings"
 "sync"
 "testing"
 "time"
 "github.com/cometbft/cometbft/crypto/ed25519"
 cjson "github.com/cometbft/cometbft/libs/json"
 proto "github.com/cometbft/cometbft/proto/tendermint/types"
 pv "github.com/cometbft/cometbft/proto/tendermint/version"
 core "github.com/cometbft/cometbft/rpc/core/types"
 "github.com/cometbft/cometbft/types"
)

// Synthetic signed-header fixture. Keys exist only in this TEST process;
// these are not production validators, application executions or witness seals.
type recoveryFixture struct{ g *types.GenesisDoc; keys map[string]ed25519.PrivKey; sets []*types.ValidatorSet; entries []historyEntry }
func newRecoveryFixture()*recoveryFixture{
 f:=&recoveryFixture{keys:map[string]ed25519.PrivKey{}}
 for n:=0;n<3;n++ { vals:=make([]*types.Validator,10);for i:=range vals{k:=ed25519.GenPrivKey();f.keys[string(k.PubKey().Address())]=k;vals[i]=types.NewValidator(k.PubKey(),10)};f.sets=append(f.sets,types.NewValidatorSet(vals)) }
 f.g=&types.GenesisDoc{GenesisTime:time.Now().Add(-10*24*time.Hour),ChainID:"sunphi-lab-long-offline",InitialHeight:1,ConsensusParams:types.DefaultConsensusParams(),AppState:json.RawMessage(`{"mode":"isolated","governance":null}`)}
 for _,v:=range f.sets[0].Validators{f.g.Validators=append(f.g.Validators,types.GenesisValidator{Address:v.Address,PubKey:v.PubKey,Power:10})};return f
}
func(f *recoveryFixture)append(at time.Time){
 h:=int64(len(f.entries)+1);which:=0;if h>4096{which=1};if h>8192{which=2};next:=which;if h==4096||h==8192{next++};set:=f.sets[which]
 header:=&types.Header{Version:pv.Consensus{Block:11},ChainID:f.g.ChainID,Height:h,Time:at,ValidatorsHash:set.Hash(),NextValidatorsHash:f.sets[next].Hash(),ConsensusHash:bytes.Repeat([]byte{7},32),AppHash:bytes.Repeat([]byte{8},32),ProposerAddress:set.Validators[0].Address}
 if h>1{header.LastBlockID=f.entries[h-2].Header.Commit.BlockID}
 id:=types.BlockID{Hash:header.Hash(),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{9},32)}};commit:=&types.Commit{Height:h,Round:0,BlockID:id,Signatures:make([]types.CommitSig,10)}
 for i,v:=range set.Validators{vote:=&types.Vote{Type:proto.PrecommitType,Height:h,Round:0,BlockID:id,Timestamp:at,ValidatorAddress:v.Address,ValidatorIndex:int32(i)};sig,e:=f.keys[string(v.Address)].Sign(types.VoteSignBytes(f.g.ChainID,vote.ToProto()));if e!=nil{panic(e)};vote.Signature=sig;commit.Signatures[i]=vote.CommitSig()}
 f.entries=append(f.entries,historyEntry{Header:&types.SignedHeader{Header:header,Commit:commit},Validators:set.Validators,Txs:[]types.Tx{}})
}
func TestRecoveryPageRejectsForgeryAndNeverGrantsFreshness(t *testing.T){
 f:=newRecoveryFixture();for i:=0;i<130;i++{f.append(time.Unix(1700000000+int64(i),0))}
 a:=&receiptProof{Version:1,Entries:f.entries[:128]};v,e:=checkRecoveryPage(a,f.g,0,"");if e!=nil{t.Fatal(e)}
 if v["verified"]!=false||v["fresh"]!=false||v["historyVerified"]!=true||v["headerHeight"]!=int64(128){t.Fatal("historical result masquerades as freshness")}
 pin:=hex.EncodeToString(f.entries[127].Header.Hash());b:=&receiptProof{Version:1,Entries:f.entries[127:]};if _,e=checkRecoveryPage(b,f.g,128,pin);e!=nil{t.Fatal(e)}
 for _,mutate:=range []func(*receiptProof){
  func(x *receiptProof){x.Entries[0].Header.Header.AppHash[0]^=1},
  func(x *receiptProof){x.Entries[1],x.Entries[2]=x.Entries[2],x.Entries[1]},
  func(x *receiptProof){x.Entries=append(x.Entries[:1],x.Entries[2:]...)},
  func(x *receiptProof){for i:=6;i<10;i++{x.Entries[0].Header.Commit.Signatures[i]=types.NewCommitSigAbsent()}},
  func(x *receiptProof){x.Entries[0].Validators=f.sets[1].Validators},
 }{raw,_:=cjson.Marshal(a);var x receiptProof;if e=cjson.Unmarshal(raw,&x);e!=nil{t.Fatal(e)};mutate(&x);if _,e=checkRecoveryPage(&x,f.g,0,"");e==nil{t.Fatal("forged history accepted")}}
 if _,e=checkRecoveryPage(b,f.g,128,strings.Repeat("00",32));e==nil{t.Fatal("wrong retained pin")}
 if _,e=checkRecoveryPage(&receiptProof{Version:1,Entries:f.entries},f.g,0,"");e==nil{t.Fatal("unbounded page")}
 // Seven valid signatures meet the same 7/10 threshold; six do not.
 raw,_:=cjson.Marshal(a);var seven receiptProof;cjson.Unmarshal(raw,&seven);for i:=7;i<10;i++{seven.Entries[0].Header.Commit.Signatures[i]=types.NewCommitSigAbsent()};if _,e=checkRecoveryPage(&seven,f.g,0,"");e!=nil{t.Fatal(e)}
}

func TestRecoveryRPCFixture(t *testing.T){
 dir:=os.Getenv("SUNPHI_RECOVERY_FIXTURE_SERVER");if dir==""{t.Skip("explicit isolated fixture only")}
 f:=newRecoveryFixture();start:=time.Now().Add(-72*time.Hour);for i:=0;i<16001;i++{f.append(start.Add(time.Duration(i)*time.Second))}
 if e:=os.MkdirAll(dir,0700);e!=nil{t.Fatal(e)};if e:=f.g.SaveAs(filepath.Join(dir,"genesis.json"));e!=nil{t.Fatal(e)}
 var mu sync.Mutex;requests:=0;var downloaded int64;mode:="good";stopped:=make(chan struct{});var once sync.Once
 listener,e:=net.Listen("tcp","127.0.0.1:0");if e!=nil{t.Fatal(e)}
 server:=&http.Server{ReadHeaderTimeout:5*time.Second,Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  mu.Lock();defer mu.Unlock();w.Header().Set("Content-Type","application/json")
  if r.URL.Path=="/control"{
   switch r.URL.Query().Get("action"){case "advance":f.append(time.Now());case "good","corrupt","offline":mode=r.URL.Query().Get("action");case "stop":once.Do(func(){close(stopped)})}
   json.NewEncoder(w).Encode(map[string]interface{}{"height":len(f.entries),"requests":requests,"bytes":downloaded,"hash":hex.EncodeToString(f.entries[len(f.entries)-1].Header.Hash())});return
  }
  if mode=="offline"{http.Error(w,"offline",503);return}
  var q struct{ID json.RawMessage `json:"id"`;Method string `json:"method"`;Params map[string]json.RawMessage `json:"params"`};if e:=json.NewDecoder(http.MaxBytesReader(w,r.Body,4096)).Decode(&q);e!=nil{http.Error(w,"request",400);return}
  h:=int64(len(f.entries));if p:=q.Params["height"];len(p)>0&&string(p)!="null"{h,_=strconv.ParseInt(strings.Trim(string(p),"\""),10,64)};if h<1||h>int64(len(f.entries)){http.Error(w,"height",400);return};entry:=f.entries[h-1];requests++
  var result interface{}
  switch q.Method{case "commit":s:=*entry.Header;if mode=="corrupt"{head:=*s.Header;head.AppHash=bytes.Repeat([]byte{1},32);s.Header=&head};result=&core.ResultCommit{SignedHeader:s,CanonicalCommit:true};case "validators":result=&core.ResultValidators{BlockHeight:h,Validators:entry.Validators,Count:10,Total:10};default:http.Error(w,"method",400);return}
  b,e:=cjson.Marshal(result);if e!=nil{http.Error(w,"encoding",500);return};reply,_:=json.Marshal(map[string]interface{}{"jsonrpc":"2.0","id":q.ID,"result":json.RawMessage(b)});downloaded+=int64(len(reply));w.Write(reply)
 })}
 info:=map[string]interface{}{"url":"http://"+listener.Addr().String(),"height":len(f.entries),"initialHash":hex.EncodeToString(f.entries[0].Header.Hash()),"genesis":filepath.Join(dir,"genesis.json")};b,_:=json.Marshal(info);if e=os.WriteFile(filepath.Join(dir,"ready.json"),b,0600);e!=nil{t.Fatal(e)}
 go server.Serve(listener);select{case <-stopped:case <-time.After(30*time.Minute):t.Error("fixture lifetime exceeded")};server.Close();fmt.Println("isolated signed-header fixture stopped")
}
