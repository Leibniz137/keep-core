// Package dkgtest provides a full roundtrip DKG test engine including all
// the phases. It is executed against local chain and broadcast channel.
package dkgtest

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"
	"time"

	relaychain "github.com/keep-network/keep-core/pkg/beacon/relay/chain"
	"github.com/keep-network/keep-core/pkg/beacon/relay/dkg"
	"github.com/keep-network/keep-core/pkg/beacon/relay/event"
	"github.com/keep-network/keep-core/pkg/beacon/relay/group"
	chainLocal "github.com/keep-network/keep-core/pkg/chain/local"
	"github.com/keep-network/keep-core/pkg/internal/interception"
	"github.com/keep-network/keep-core/pkg/net/key"
	netLocal "github.com/keep-network/keep-core/pkg/net/local"
	"github.com/keep-network/keep-core/pkg/operator"
)

var minimumStake = big.NewInt(20)

// Result of a DKG test execution.
type Result struct {
	dkgResult           *relaychain.DKGResult
	dkgResultSignatures map[group.MemberIndex][]byte
	Signers             []*dkg.ThresholdSigner
	memberFailures      []error
}

// RunTest executes the full DKG roundrip test for the provided group size
// and threshold. The provided interception rules are applied in the broadcast
// channel for the time of DKG execution.
func RunTest(
	groupSize int,
	threshold int,
	rules interception.Rules,
) (*Result, error) {
	privateKey, publicKey, err := operator.GenerateKeyPair()
	if err != nil {
		return nil, err
	}

	_, networkPublicKey := key.OperatorKeyToNetworkKey(privateKey, publicKey)

	network := interception.NewNetwork(
		netLocal.ConnectWithKey(networkPublicKey),
		rules,
	)

	chain := chainLocal.ConnectWithKey(groupSize, threshold, minimumStake, privateKey)

	return executeDKG(groupSize, threshold, chain, network)
}

func executeDKG(
	groupSize int,
	threshold int,
	chain chainLocal.Chain,
	network interception.Network,
) (*Result, error) {
	blockCounter, err := chain.BlockCounter()
	if err != nil {
		return nil, err
	}

	seed, err := rand.Int(rand.Reader, big.NewInt(100000))
	if err != nil {
		return nil, err
	}

	broadcastChannel, err := network.ChannelFor(fmt.Sprintf("dkg-test-%v", seed))
	if err != nil {
		return nil, err
	}

	resultSubmissionChan := make(chan *event.DKGResultSubmission)
	chain.ThresholdRelay().OnDKGResultSubmitted(
		func(event *event.DKGResultSubmission) {
			resultSubmissionChan <- event
		},
	)

	var signersMutex sync.Mutex
	var signers []*dkg.ThresholdSigner

	var memberFailuresMutex sync.Mutex
	var memberFailures []error

	var wg sync.WaitGroup
	wg.Add(groupSize)

	currentBlockHeight, err := blockCounter.CurrentBlock()
	if err != nil {
		return nil, err
	}

	// Wait for 3 blocks before starting DKG to
	// make sure all members are up.
	startBlockHeight := currentBlockHeight + 3

	for i := 0; i < groupSize; i++ {
		i := i // capture for goroutine
		go func() {
			signer, err := dkg.ExecuteDKG(
				seed,
				i,
				groupSize,
				threshold,
				startBlockHeight,
				blockCounter,
				chain.ThresholdRelay(),
				chain.Signing(),
				broadcastChannel,
			)
			if signer != nil {
				signersMutex.Lock()
				signers = append(signers, signer)
				signersMutex.Unlock()
			}
			if err != nil {
				fmt.Printf("failed with: [%v]\n", err)
				memberFailuresMutex.Lock()
				memberFailures = append(memberFailures, err)
				memberFailuresMutex.Unlock()
			}
			wg.Done()
		}()
	}
	wg.Wait()

	// We give 5 seconds so that OnDKGResultSubmitted async handler
	// is fired. If it's not, than it means no result was published
	// to the chain.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	select {
	case <-resultSubmissionChan:
		// result was published to the chain, let's fetch it
		dkgResult, dkgResultSignatures := chain.GetLastDKGResult()
		return &Result{
			dkgResult,
			dkgResultSignatures,
			signers,
			memberFailures,
		}, nil

	case <-ctx.Done():
		// no result published to the chain
		return &Result{
			nil,
			nil,
			signers,
			memberFailures,
		}, nil
	}
}
