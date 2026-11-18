package main
import (
 "testing"
 dbm "github.com/cometbft/cometbft-db"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/store"
)
func TestEmptyBootstrapInspection(t *testing.T){
 states,blocks,s,_:=recoveryFixture(t)
 if e:=emptyBootstrapState(states,s.ChainID,false);e!=nil{t.Fatal(e)}
 if e:=emptyBootstrapBlocks(blocks);e!=nil{t.Fatal(e)}
 if e:=emptyBootstrapState(states,"foreign-chain",false);e==nil{t.Fatal("accepted foreign consensus state")}
 if e:=states.Save(s);e!=nil{t.Fatal(e)}
 if e:=emptyBootstrapState(states,s.ChainID,false);e==nil{t.Fatal("accepted committed consensus state")}
 empty:=sm.NewStore(dbm.NewMemDB(),sm.StoreOptions{});defer empty.Close()
 if e:=emptyBootstrapState(empty,s.ChainID,false);e!=nil{t.Fatal(e)}
 if e:=empty.SetOfflineStateSyncHeight(10);e!=nil{t.Fatal(e)}
 if e:=emptyBootstrapState(empty,s.ChainID,true);e==nil{t.Fatal("accepted installed state sync height")}
 db:=dbm.NewMemDB();bs:=store.NewBlockStore(db);defer bs.Close();if e:=emptyBootstrapBlocks(bs);e!=nil{t.Fatal(e)}
}
