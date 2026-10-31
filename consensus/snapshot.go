package main

import (
 "context"
 "encoding/hex"
 "fmt"
 "os"
 "path/filepath"
 dbm "github.com/cometbft/cometbft-db"
 abci "github.com/cometbft/cometbft/abci/types"
 sm "github.com/cometbft/cometbft/state"
)

type snapshotDescriptor struct { Height uint64 `json:"height"`; Format uint32 `json:"format"`; Chunks uint32 `json:"chunks"`; Hash []byte `json:"hash"` }
func(b *bridge) ListSnapshots(c context.Context,_ *abci.RequestListSnapshots)(*abci.ResponseListSnapshots,error){
 r,e:=b.call(c,request{Method:"listSnapshots"});if e!=nil{return nil,e};out:=&abci.ResponseListSnapshots{}
 for _,s:=range r.Snapshots{out.Snapshots=append(out.Snapshots,&abci.Snapshot{Height:s.Height,Format:s.Format,Chunks:s.Chunks,Hash:s.Hash})};return out,nil
}
func(b *bridge) OfferSnapshot(c context.Context,q *abci.RequestOfferSnapshot)(*abci.ResponseOfferSnapshot,error){
 out:=&abci.ResponseOfferSnapshot{Result:abci.ResponseOfferSnapshot_REJECT};s:=q.Snapshot
 if s==nil||s.Height>4096||s.Format!=1||s.Chunks<1||s.Chunks>256||len(s.Hash)!=32||len(s.Metadata)!=0{return out,nil}
 r,e:=b.call(c,request{Method:"offerSnapshot",Snapshot:&snapshotDescriptor{s.Height,s.Format,s.Chunks,s.Hash},AppHash:hex.EncodeToString(q.AppHash)})
 if e==nil&&r.Accept{out.Result=abci.ResponseOfferSnapshot_ACCEPT};return out,nil
}
func(b *bridge) LoadSnapshotChunk(c context.Context,q *abci.RequestLoadSnapshotChunk)(*abci.ResponseLoadSnapshotChunk,error){
 r,e:=b.call(c,request{Method:"loadSnapshotChunk",Height:int64(q.Height),Format:q.Format,Index:q.Chunk});if e!=nil{return &abci.ResponseLoadSnapshotChunk{},nil};return &abci.ResponseLoadSnapshotChunk{Chunk:r.Chunk},nil
}
func(b *bridge) ApplySnapshotChunk(c context.Context,q *abci.RequestApplySnapshotChunk)(*abci.ResponseApplySnapshotChunk,error){
 out:=&abci.ResponseApplySnapshotChunk{Result:abci.ResponseApplySnapshotChunk_ABORT};if len(q.Chunk)>256*1024{return out,nil}
 r,e:=b.call(c,request{Method:"applySnapshotChunk",Index:q.Index,Chunk:q.Chunk});if e==nil&&r.Accept{out.Result=abci.ResponseApplySnapshotChunk_ACCEPT};return out,nil
}
// Called before Comet starts under the node's ownership lock. Never opens a
// validator signer or resets a store. The isolated launcher pins goleveldb.
func printBootstrapStateHeight(home string) error {
 if _,e:=os.Stat(filepath.Join(home,"data","state.db"));os.IsNotExist(e){fmt.Println(0);return nil}else if e!=nil{return e}
 db,e:=dbm.NewDB("state",dbm.GoLevelDBBackend,filepath.Join(home,"data"));if e!=nil{return e};defer db.Close()
 s,e:=sm.NewStore(db,sm.StoreOptions{}).Load();if e!=nil{return e};fmt.Println(s.LastBlockHeight);return nil
}
