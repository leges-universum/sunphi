import json
import os
from pathlib import Path
import subprocess

from trytond.exceptions import UserError
from trytond import backend
from trytond.model import ModelSQL, ModelView, Unique, fields
from trytond.pool import Pool
from trytond.rpc import RPC
from trytond.transaction import Transaction


class Settlement(ModelSQL, ModelView):
    "DueByte invoice settlement"
    __name__ = 'duebyte.settlement'
    payment_key = fields.Char("Network and payment ID", required=True)
    invoice_hash = fields.Char("Signed invoice hash", required=True)
    reference = fields.Char("Invoice reference", required=True)
    face = fields.Char("Invoice in micro-DUBYT", required=True)
    outstanding = fields.Char("Outstanding micro-DUBYT", required=True)
    disputed = fields.Char("Disputed micro-DUBYT", required=True)
    posted = fields.Boolean("Posted")

    @classmethod
    def __setup__(cls):
        super().__setup__()
        table = cls.__table__()
        cls._sql_constraints.append(('payment_key', Unique(table, table.payment_key), 'Payment already imported.'))
        cls.__rpc__['import_receipt'] = RPC(readonly=False)

    @classmethod
    def import_receipt(cls, export):
        raw = json.dumps(export, ensure_ascii=True)
        if len(raw) > 131072:
            raise UserError("Receipt too large.")
        # A working book always checks its own full node. Fixture evidence is
        # an explicit, separate configuration used by isolated test books.
        working = bool(os.environ.get('DUEBYTE_LEDGER_BOOK'))
        if working:
            if os.environ.get('DUEBYTE_TEST_BOOK') or os.environ.get('DUEBYTE_TEST_OBSERVATION'):
                raise UserError("Remove test settings before opening a working book.")
            root = Path(os.environ['DUEBYTE_SERVER_ROOT'])
            verifier = root / 'sunphi-network-next/checkpoint-trial/invoice-settlement-reader.mjs'
            command = [str(root / 'runtime/node'), str(verifier)]
        else:
            command = [os.environ['DUEBYTE_NODE'], os.environ['DUEBYTE_RECEIPT_VERIFIER']]
        proc = subprocess.run(command, input=raw, text=True, capture_output=True, timeout=12)
        if proc.returncode:
            raise UserError("Home receipt verification failed.")
        data = json.loads(proc.stdout)
        if not working:
            witness = json.loads(Path(os.environ['DUEBYTE_TEST_OBSERVATION']).read_bytes())
            if isinstance(witness, list):
                matches = [item for item in witness if (item['network'], item['paymentId']) ==
                           (data['network'], data['pid'])]
                if len(matches) != 1:
                    raise UserError("No unique trusted test observation for payment.")
                witness = matches[0]
            authenticated = {'network': 'network', 'pid': 'paymentId', 'invoiceHash': 'invoiceHash',
                             'buyer': 'buyerWallet', 'supplier': 'supplierWallet',
                             'principal': 'supplierCreditMicro', 'fee': 'feeMicro'}
            if any(data[key] != witness[field] for key, field in authenticated.items()):
                raise UserError("Payment differs from the trusted test observation.")
        Receipt = Pool().get('duebyte.evidence')
        Movement = Pool().get('duebyte.movement')
        key = data['network'] + '/' + data['pid']
        if backend.name == 'sqlite':
            # The Tryton SQLite backend implements table locking as a no-op.
            # Reserve the database writer before reading, even for the first import.
            # A busy writer retries the complete RPC in a fresh Tryton transaction.
            Transaction().connection.cursor().execute(
                'UPDATE duebyte_settlement SET posted = posted WHERE 0')
        else:
            cls.lock()
        rows = cls.search([('payment_key', '=', key)], limit=1)
        if rows:
            settlement, = rows
            if settlement.invoice_hash != data['invoiceHash']:
                raise UserError("A different signed invoice is already recorded for this payment.")
        else:
            settlement, = cls.create([{'payment_key': key, 'invoice_hash': data['invoiceHash'],
                                       'reference': data['reference'], 'face': data['face'],
                                       'outstanding': data['outstanding'], 'disputed': data['disputed']}])
        if Receipt.search([('settlement', '=', settlement.id), ('role', '=', data['role'])], limit=1):
            return {'status': 'duplicate', 'settlement': settlement.id}
        Receipt.create([{'settlement': settlement.id, 'role': data['role'], 'payload': raw}])
        if Receipt.search_count([('settlement', '=', settlement.id)]) == 1:
            return {'status': 'awaiting_counterparty', 'settlement': settlement.id}
        principal, fee = int(data['principal']), int(data['fee'])
        entries = [('buyer', -(principal + fee)), ('supplier', principal), ('network-fee', fee)]
        Movement.create([{'settlement': settlement.id, 'role': role, 'micro': str(amount)}
                         for role, amount in entries])
        cls.write([settlement], {'posted': True})
        return {'status': 'posted', 'settlement': settlement.id}


class Evidence(ModelSQL, ModelView):
    "Verified Home export"
    __name__ = 'duebyte.evidence'
    settlement = fields.Many2One('duebyte.settlement', "Settlement", required=True)
    role = fields.Char("Wallet role", required=True)
    payload = fields.Text("Receipt JSON", required=True)

    @classmethod
    def __setup__(cls):
        super().__setup__()
        table = cls.__table__()
        cls._sql_constraints.append(('source', Unique(table, table.settlement, table.role), 'Receipt already recorded.'))


class Movement(ModelSQL, ModelView):
    "DueByte settlement posting"
    __name__ = 'duebyte.movement'
    settlement = fields.Many2One('duebyte.settlement', "Settlement", required=True)
    role = fields.Char("Entry role", required=True)
    micro = fields.Char("Signed micro-DUBYT", required=True)

    @classmethod
    def __setup__(cls):
        super().__setup__()
        table = cls.__table__()
        cls._sql_constraints.append(('entry', Unique(table, table.settlement, table.role), 'Movement already recorded.'))
