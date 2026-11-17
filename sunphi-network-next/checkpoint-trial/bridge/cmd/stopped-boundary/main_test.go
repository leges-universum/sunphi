package main

import (
 "bytes"
 "crypto/sha256"
 "encoding/hex"
 "encoding/base64"
 "os"
 "path/filepath"
 "reflect"
 "strings"
 "testing"
 "time"

 dbm "github.com/cometbft/cometbft-db"
 "github.com/cometbft/cometbft/crypto/ed25519"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/store"
 "github.com/cometbft/cometbft/types"
)

// Synthetic signed native stores; no production keys or network connections.
func fixture(t *testing.T, mode string) request {
 t.Helper()
 home:=t.TempDir(); data:=filepath.Join(home,"data")
 if e:=os.Mkdir(data,0700);e!=nil{t.Fatal(e)}
 watermark:=`{"height":"1","round":0,"step":3}`
 if mode=="future-signature"{watermark=`{"height":"2","round":0,"step":1}`}
 if e:=os.WriteFile(filepath.Join(data,"priv_validator_state.json"),[]byte(watermark),0600);e!=nil{t.Fatal(e)}
 sdb,e:=dbm.NewGoLevelDB("state",data);if e!=nil{t.Fatal(e)};defer sdb.Close()
 bdb,e:=dbm.NewGoLevelDB("blockstore",data);if e!=nil{t.Fatal(e)};defer bdb.Close()
 key:=ed25519.GenPrivKey()
 state,e:=sm.MakeGenesisState(&types.GenesisDoc{ChainID:"duebyte-boundary-test",GenesisTime:time.Unix(1700000000,0).UTC(),InitialHeight:1,ConsensusParams:types.DefaultConsensusParams(),Validators:[]types.GenesisValidator{{PubKey:key.PubKey(),Power:10}},AppHash:bytes.Repeat([]byte{1},32)})
 if e!=nil{t.Fatal(e)}
 states:=sm.NewStore(sdb,sm.StoreOptions{});if e=states.Save(state);e!=nil{t.Fatal(e)}
 block,e:=state.MakeBlock(1,nil,&types.Commit{},nil,key.PubKey().Address());if e!=nil{t.Fatal(e)}
 parts,e:=block.MakePartSet(types.BlockPartSizeBytes);if e!=nil{t.Fatal(e)}
 id:=types.BlockID{Hash:block.Hash(),PartSetHeader:parts.Header()}
 commit:=&types.Commit{Height:1,Round:0,BlockID:id,Signatures:[]types.CommitSig{{BlockIDFlag:types.BlockIDFlagCommit,ValidatorAddress:key.PubKey().Address(),Timestamp:state.LastBlockTime}}}
 commit.Signatures[0].Signature,e=key.Sign(commit.VoteSignBytes(state.ChainID,0));if e!=nil{t.Fatal(e)}
 if mode=="bad-signature"{commit.Signatures[0].Signature[0]^=1}
 blocks:=store.NewBlockStore(bdb);blocks.SaveBlock(block,parts,commit)
 state.LastBlockHeight=1;state.LastBlockID=id;state.LastBlockTime=block.Time;state.LastValidators=state.Validators.Copy();state.AppHash=bytes.Repeat([]byte{2},32)
 if mode!="pending-application"{if e=states.Save(state);e!=nil{t.Fatal(e)}}
 return request{Home:home,Network:state.ChainID,Height:1,AppHash:hex.EncodeToString(state.AppHash),BlockHash:hex.EncodeToString(id.Hash),Validators:[]member{{Key:base64.RawURLEncoding.EncodeToString(key.PubKey().Bytes()),Power:10}}}
}
func digests(t *testing.T,home string) map[string][32]byte {
 t.Helper();out:=map[string][32]byte{}
 e:=filepath.WalkDir(home,func(p string,d os.DirEntry,e error)error{if e!=nil{return e};if !d.IsDir(){b,e:=os.ReadFile(p);if e!=nil{return e};out[p]=sha256.Sum256(b)};return nil});if e!=nil{t.Fatal(e)};return out
}
func TestStoppedBoundaryReadOnly(t *testing.T){q:=fixture(t,"");before:=digests(t,q.Home);for i:=0;i<3;i++{r,e:=inspect(q);if e!=nil{t.Fatal(e)};if r["commitVerified"]!=true||r["appliedHeight"]!=int64(1){t.Fatal(r)}};if !reflect.DeepEqual(before,digests(t,q.Home)){t.Fatal("read-only inspection changed native files")}}
func TestDiscoverAndPinVotingAuthority(t *testing.T){q:=fixture(t,"");want:=q.BlockHash;q.BlockHash="";q.DiscoverBlock=true;r,e:=inspect(q);if e!=nil||r["blockHash"]!=want{t.Fatal(r,e)};q.Validators[0].Power=11;if _,e=inspect(q);e==nil{t.Fatal("accepted wrong voting power")};q.Validators=nil;if _,e=inspect(q);e==nil{t.Fatal("accepted absent trusted authority")};q.DiscoverBlock=false;if _,e=inspect(q);e==nil{t.Fatal("accepted missing pinned block")}}
func TestRejectWrongBoundary(t *testing.T){q:=fixture(t,"");for _,field:=range []string{"height","network","root","block"}{t.Run(field,func(t *testing.T){v:=q;switch field{case "height":v.Height=2;case "network":v.Network="foreign";case "root":v.AppHash=strings.Repeat("0",64);case "block":v.BlockHash=strings.Repeat("0",64)};if _,e:=inspect(v);e==nil{t.Fatal("accepted wrong boundary")}})}}
func TestRejectUncommittedOrForgedState(t *testing.T){for _,mode:=range []string{"bad-signature","pending-application","future-signature"}{t.Run(mode,func(t *testing.T){q:=fixture(t,mode);before:=digests(t,q.Home);if _,e:=inspect(q);e==nil{t.Fatal("accepted unsafe state")};if !reflect.DeepEqual(before,digests(t,q.Home)){t.Fatal("changed rejected state")}})}}
func TestMissingStoreDoesNotCreateFiles(t *testing.T){q:=request{Home:t.TempDir(),Network:"test",Height:1,AppHash:strings.Repeat("0",64),BlockHash:strings.Repeat("0",64)};if _,e:=inspect(q);e==nil{t.Fatal("accepted missing stores")};entries,e:=os.ReadDir(q.Home);if e!=nil||len(entries)!=0{t.Fatal("created database")}}
func TestStrictRequest(t *testing.T){for _,s:=range []string{`{} {}`,`{"unknown":1}`,`{} garbage`,strings.Repeat(" ",65537)+`{}`}{if _,e:=readRequest(strings.NewReader(s));e==nil{t.Fatal("accepted invalid request")}};if _,e:=readRequest(strings.NewReader(`{} `));e!=nil{t.Fatal(e)}}
