package main

import (
 "fmt"
 "os"
 "path/filepath"
 cfg "github.com/cometbft/cometbft/config"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/store"
 "github.com/cometbft/cometbft/types"
)

// A failed first state sync leaves initialized LevelDB directories. Their
// existence alone is not committed history. Inspect existing stores under their
// normal exclusive database locks; never create, reset or remove a store.
func inspectEmptyBootstrap(c *cfg.Config) error {
 if !c.StateSync.Enable { return fmt.Errorf("state sync is not configured") }
 genesis,e:=types.GenesisDocFromFile(c.GenesisFile());if e!=nil{return e}
 for _,id:=range []string{"state","blockstore"}{
  file:=filepath.Join(c.DBDir(),id+".db");s,e:=os.Lstat(file)
  if os.IsNotExist(e){continue};if e!=nil{return e};if !s.IsDir()||s.Mode()&os.ModeSymlink!=0{return fmt.Errorf("unsafe consensus store")}
  db,e:=cfg.DefaultDBProvider(&cfg.DBContext{ID:id,Config:c});if e!=nil{return e}
  if id=="blockstore"{blocks:=store.NewBlockStore(db);e=emptyBootstrapBlocks(blocks);blocks.Close();if e!=nil{return e}}else{
   // Comet v0.38.26 returns an untyped error for an absent offline marker.
   // Check key presence explicitly; never suppress a decoding/storage error.
   present,err:=db.Has([]byte("offlineStateSyncHeightKey"));if err!=nil{db.Close();return err}
   states:=sm.NewStore(db,sm.StoreOptions{DiscardABCIResponses:c.Storage.DiscardABCIResponses});e=emptyBootstrapState(states,genesis.ChainID,present);states.Close();if e!=nil{return e}
  }
 }
 return nil
}
func emptyBootstrapBlocks(blocks *store.BlockStore)error{
 if blocks.Height()!=0||blocks.Base()!=0{return fmt.Errorf("committed block history exists")};return nil
}
func emptyBootstrapState(states sm.Store,chain string,offlinePresent bool)error{
 s,e:=states.Load();if e!=nil{return e};if s.LastBlockHeight!=0||(s.ChainID!=""&&s.ChainID!=chain){return fmt.Errorf("committed or foreign consensus state exists")}
 if offlinePresent{height,e:=states.GetOfflineStateSyncHeight();if e!=nil{return e};if height!=0{return fmt.Errorf("installed state sync history exists")}};return nil
}
