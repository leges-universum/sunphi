// Preserve complete Comet block bodies from the pinned DueByte peer RPC.
// The terminal hash must come from the synchronized local candidate.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/types"
)

const network = "duebyte-trial-fresh-20261109-v45"
const pageSize = 128
const maxBody = 4 << 20

type blockResult struct {
	ID    types.BlockID `json:"block_id"`
	Block *types.Block  `json:"block"`
}

func check(body []byte, height int64, previous types.BlockID) (types.BlockID, error) {
	var result blockResult
	if err := cmtjson.Unmarshal(body, &result); err != nil {
		return previous, err
	}
	b := result.Block
	if b == nil || b.Height != height || b.ChainID != network || !b.LastBlockID.Equals(previous) {
		return previous, errors.New("height, network or parent mismatch")
	}
	if err := b.ValidateBasic(); err != nil {
		return previous, err
	}
	if !b.LastCommit.BlockID.Equals(previous) {
		return previous, errors.New("commit parent mismatch")
	}
	parts, err := b.MakePartSet(types.BlockPartSizeBytes)
	if err != nil {
		return previous, err
	}
	actual := types.BlockID{Hash: b.Hash(), PartSetHeader: parts.Header()}
	if !result.ID.Equals(actual) {
		return previous, errors.New("invalid block ID")
	}
	return actual, nil
}

func fetch(client *http.Client, endpoint string, h int64) ([]byte, error) {
	for attempt := 0; attempt < 5; attempt++ {
		r, err := client.Get(fmt.Sprintf("%s/block?height=%d", endpoint, h))
		if err == nil {
			body, e := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
			r.Body.Close()
			if r.StatusCode == 200 && e == nil && len(body) <= maxBody {
				var envelope struct{ Result json.RawMessage }
				if json.Unmarshal(body, &envelope) == nil && len(envelope.Result) > 0 {
					var compact bytes.Buffer
					if err = json.Compact(&compact, envelope.Result); err == nil {
						return compact.Bytes(), nil
					}
				}
			}
			if r.StatusCode >= 400 && r.StatusCode < 500 && r.StatusCode != 429 {
				return nil, fmt.Errorf("peer returned HTTP %d", r.StatusCode)
			}
		}
		time.Sleep(time.Second << attempt)
	}
	return nil, fmt.Errorf("peer block %d unavailable", h)
}

func readSegment(file string, start, target int64, previous types.BlockID) (int64, types.BlockID, error) {
	f, err := os.Open(file)
	if err != nil {
		return start, previous, err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return start, previous, err
	}
	defer z.Close()
	scanner := bufio.NewScanner(z)
	scanner.Buffer(make([]byte, 65536), maxBody)
	h := start
	for scanner.Scan() {
		if h > target || h-start >= pageSize {
			return h, previous, errors.New("segment exceeds requested range")
		}
		previous, err = check(scanner.Bytes(), h, previous)
		if err != nil {
			return h, previous, err
		}
		h++
	}
	if h == start {
		return h, previous, errors.New("empty segment")
	}
	return h, previous, scanner.Err()
}

func download(file, endpoint string, start, target int64, previous types.BlockID, client *http.Client) (int64, types.BlockID, error) {
	f, err := os.CreateTemp(filepath.Dir(file), ".partial-")
	if err != nil {
		return start, previous, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	z, err := gzip.NewWriterLevel(f, gzip.BestSpeed)
	if err != nil {
		return start, previous, err
	}
	h := start
	for h <= target && h-start < pageSize {
		b, e := fetch(client, endpoint, h)
		if e != nil {
			return h, previous, e
		}
		previous, e = check(b, h, previous)
		if e != nil {
			return h, previous, fmt.Errorf("block %d: %w", h, e)
		}
		if _, e = z.Write(b); e != nil {
			return h, previous, e
		}
		if _, e = z.Write([]byte{'\n'}); e != nil {
			return h, previous, e
		}
		h++
	}
	if err = z.Close(); err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = f.Close()
	}
	if err == nil {
		err = os.Rename(f.Name(), file)
	}
	return h, previous, err
}

func run() error {
	endpoint := flag.String("rpc", "http://127.0.0.1:28111", "authenticated peer RPC in the DueByte profile")
	target := flag.Int64("height", 0, "confirmed candidate status height")
	hash := flag.String("hash", "", "blockHash from the same candidate status")
	output := flag.String("out", "", "private archive directory")
	flag.Parse()
	want, err := hex.DecodeString(*hash)
	if err != nil || len(want) != 32 || *target < 1 || *output == "" {
		return errors.New("provide -height, -hash and -out")
	}
	u, err := url.Parse(*endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return errors.New("use a loopback peer RPC URL")
	}
	if err = os.MkdirAll(*output, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(*output, "archive.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("archive is already in use")
	}
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	var previous types.BlockID
	for h := int64(1); h <= *target; {
		file := filepath.Join(*output, fmt.Sprintf("blocks-%09d.jsonl.gz", h))
		if _, e := os.Stat(file); e == nil {
			h, previous, err = readSegment(file, h, *target, previous)
		} else if os.IsNotExist(e) {
			h, previous, err = download(file, *endpoint, h, *target, previous, client)
		} else {
			return e
		}
		if err != nil {
			return err
		}
		if h%2048 == 1 || h > *target {
			fmt.Fprintf(os.Stderr, "Checked through %d\n", h-1)
		}
	}
	if !bytes.Equal(previous.Hash, want) {
		return errors.New("archive differs from the authenticated terminal hash")
	}
	data, err := json.Marshal(map[string]any{"network": network, "from": 1, "through": *target, "blockHash": strings.ToUpper(*hash), "passed": true})
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
