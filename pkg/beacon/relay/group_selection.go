package relay

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"time"

	relaychain "github.com/keep-network/keep-core/pkg/beacon/relay/chain"
	"github.com/keep-network/keep-core/pkg/beacon/relay/groupselection"
	"github.com/keep-network/keep-core/pkg/chain"
)

// getTicketListInterval is the number of seconds we wait before requesting the
// ordered ticket list (to run ticket verification)from the chain.
const getTicketListInterval = 5 * time.Second

// SubmitTicketsForGroupSelection takes the previous beacon value and attempts to
// generate the appropriate number of tickets for the staker. After ticket
// generation begins an interactive process, where the staker submits tickets
// that fall under the natural threshold, while challenging tickets on chain
// that fail verification. Submission ends at the end of the submission period.
//
// See the group selection protocol specification for more information.
func (n *Node) SubmitTicketsForGroupSelection(
	relayChain relaychain.Interface,
	blockCounter chain.BlockCounter,
	signing chain.Signing,
	newEntry *big.Int,
	startBlockHeight uint64,
) error {
	availableStake, err := n.Staker.Stake()
	if err != nil {
		return err
	}
	tickets, err :=
		groupselection.GenerateTickets(
			newEntry.Bytes(),
			n.Staker.ID(),
			availableStake,
			n.chainConfig.MinimumStake,
		)
	if err != nil {
		return err
	}

	submissionTimeout, err := blockCounter.BlockHeightWaiter(
		startBlockHeight + n.chainConfig.TicketReactiveSubmissionTimeout,
	)
	if err != nil {
		return err
	}

	var (
		errorChannel         = make(chan error, len(tickets))
		quitTicketSubmission = make(chan struct{}, 1)
	)

	// submit all tickets
	go n.submitTickets(
		tickets,
		relayChain,
		quitTicketSubmission,
		errorChannel,
	)

	for {
		select {
		case err := <-errorChannel:
			logger.Errorf(
				"error during ticket submission: [%v]",
				err,
			)
		case submissionEndBlockHeight := <-submissionTimeout:
			quitTicketSubmission <- struct{}{}

			selectedParticipants, err := relayChain.GetSelectedParticipants()
			if err != nil {
				return fmt.Errorf(
					"could not fetch selected participants after submission timeout [%v]",
					err,
				)
			}

			selectedStakers := make([][]byte, len(selectedParticipants))
			for i, participant := range selectedParticipants {
				selectedStakers[i] = participant
				logger.Infof("new group member: [0x%v]", hex.EncodeToString(participant))
			}

			// Read the selected, ordered tickets from the chain,
			// determine if we're eligible for the next group.
			go n.JoinGroupIfEligible(
				relayChain,
				signing,
				&groupselection.Result{SelectedStakers: selectedStakers},
				newEntry,
				submissionEndBlockHeight,
			)
			return nil
		}
	}
}

// submitTickets submits tickets to the chain. It checks to see if the submission
// period is over in between ticket submits.
func (n *Node) submitTickets(
	tickets []*groupselection.Ticket,
	relayChain relaychain.GroupSelectionInterface,
	quit <-chan struct{},
	errCh chan<- error,
) {
	for _, ticket := range tickets {
		select {
		case <-quit:
			// Exit this loop when we get a signal from quit.
			return
		default:
			chainTicket, err := toChainTicket(ticket)
			if err != nil {
				errCh <- err
				continue
			}

			relayChain.SubmitTicket(chainTicket).OnFailure(
				func(err error) { errCh <- err },
			)
		}
	}
}

func toChainTicket(ticket *groupselection.Ticket) (*relaychain.Ticket, error) {
	return &relaychain.Ticket{
		Value: ticket.Value.Int(),
		Proof: &relaychain.TicketProof{
			StakerValue:        new(big.Int).SetBytes(ticket.Proof.StakerValue),
			VirtualStakerIndex: ticket.Proof.VirtualStakerIndex,
		},
	}, nil
}