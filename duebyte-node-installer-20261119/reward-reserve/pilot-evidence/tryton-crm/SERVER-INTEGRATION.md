# Verify a DueByte invoice receipt

On the host running the verifying DueByte Server, set `DUEBYTE_SETTLEMENT_SNAPSHOT` to the path of its indexed state SQLite database and `DUEBYTE_SETTLEMENT_RPC` to the HTTP loopback RPC URL of the synced full node. The full node must have the commit following the snapshot height. The snapshot must retain the payment record. Run from the extracted Server directory.

```sh
runtime/node sunphi-network-next/checkpoint-trial/invoice-settlement-reader.mjs < receipt.json
```

The reader checks the Home export, both parties' invoice signatures, the settled payment record and its inclusion under the committed application hash. A successful run writes a JSON object identifying the network, payment, invoice, parties, principal and fee. Monetary fields use millionths of DUBYT. The disputed amount belongs to the invoice record and stays outside the supplier credit. An unavailable commit or payment proof prevents import. Retry once the node and its snapshot agree.

## Connect a Tryton book

The bundled Tryton modules target Tryton 7.8. An accounting administrator must install them in a dedicated database with an approved DUBYT chart, an open fiscal period, a journal and authenticated integration access. Set `DUEBYTE_SERVER_ROOT` to the extracted Server directory. Set `DUEBYTE_LEDGER_BOOK` to an administrator-controlled JSON configuration file containing the Tryton company ID, journal ID and account IDs. Supply a participant object with the role (buyer or supplier), wallet address and exactly matching company name. The buyer account mapping uses wallet, payable and fee. The supplier mapping uses wallet and receivable. Keep the book configuration read-only for the integration user.

Import the buyer and supplier exports through `model.duebyte.settlement.import_receipt`. The first verified role returns `awaiting_counterparty`. The matching second role posts the move. Resending the same role returns `duplicate`. Check the posted move by network and payment ID. Working-book imports use the current accounting date and its fiscal period. Keep test book and test observation variables out of the working configuration.
