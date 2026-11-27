import datetime
from decimal import Decimal
import json
import os
import re
from pathlib import Path

from trytond.exceptions import UserError
from trytond.model import Unique, fields
from trytond.pool import Pool, PoolMeta
from trytond.transaction import Transaction


class Settlement(metaclass=PoolMeta):
    __name__ = 'duebyte.settlement'
    move = fields.Many2One('account.move', "Posted settlement move", readonly=True, ondelete='RESTRICT')
    resolution_of = fields.Many2One('duebyte.settlement', "Dispute settled in full", readonly=True,
                                    ondelete='RESTRICT')
    disputed_now = fields.Function(fields.Char("Current disputed micro-DUBYT"), 'current_balance')
    outstanding_now = fields.Function(fields.Char("Current outstanding micro-DUBYT"), 'current_balance')

    @classmethod
    def __setup__(cls):
        super().__setup__()
        table = cls.__table__()
        cls._sql_constraints.append(('resolution_once', Unique(table, table.resolution_of),
                                     'This dispute already has a settlement.'))

    def current_balance(self, name):
        opening = self.disputed if name == 'disputed_now' else self.outstanding
        released = type(self).search([('resolution_of', '=', self.id), ('move', '!=', None)])
        return str(int(opening) - sum(int(row.face) for row in released))

    @classmethod
    def resolution_parent(cls, settlement, export):
        pid = settlement.reference.removeprefix('RESOLVE-')
        network = settlement.payment_key.split('/')[0]
        parents = cls.search([('payment_key', '=', network + '/' + pid), ('move', '!=', None)])
        if not re.fullmatch('[a-f0-9]{64}', pid) or len(parents) != 1:
            raise UserError("Original posted payment required.")
        parent, = parents
        evidence, = Pool().get('duebyte.evidence').search([
            ('settlement', '=', parent.id), ('role', '=', 'supplier')])
        original = json.loads(evidence.payload)['receipt']['invoiceAdvice']['bill']['body']
        bill = export['receipt']['invoiceAdvice']['bill']['body']
        expected = [dict(description=line['description'], unitPrice=line['unitPrice'],
                         quantity=line['disputed'], accepted=line['disputed'])
                    for line in original.get('lines', []) if line.get('disputed')]
        parties = ('buyer', 'supplier', 'buyerCompany', 'supplierCompany')
        if (not expected or bill.get('lines') != expected or any(bill[k] != original[k] for k in parties)
                or settlement.face != parent.disputed or settlement.outstanding != '0'
                or cls.search([('resolution_of', '=', parent.id), ('id', '!=', settlement.id)])):
            raise UserError("Supplement does not settle the original disputed lines exactly once.")
        return parent

    @classmethod
    def import_receipt(cls, export):
        # The parent locks the settlement and verifies each incoming receipt.
        # Both modules use the same Tryton transaction until the RPC commits.
        reply = super().import_receipt(export)
        settlement = cls(reply['settlement'])
        book = json.loads(Path(os.environ.get('DUEBYTE_LEDGER_BOOK') or os.environ['DUEBYTE_TEST_BOOK']).read_bytes())
        participant = book.get('participant')
        if participant:
            bill = export['receipt']['invoiceAdvice']['bill']['body']
            role = participant['role']
            if role not in ('buyer', 'supplier') or (bill[role], bill[role+'Company']) != (
                    participant['wallet'], participant['name']):
                raise UserError("This payment belongs to a different company book.")
        if settlement.reference.startswith('RESOLVE-') and not settlement.resolution_of:
            parent = cls.resolution_parent(settlement, export)
            cls.write([settlement], {'resolution_of': parent.id})
        if not settlement.posted or settlement.move:
            return reply
        Move = Pool().get('account.move')
        Movement = Pool().get('duebyte.movement')
        rows = Movement.search([('settlement', '=', settlement.id)])
        if len(rows) != 3 or {r.role for r in rows} != {'buyer', 'supplier', 'network-fee'}:
            raise UserError("Incomplete settlement entries.")
        with Transaction().set_context(company=book['company']):
            lines = []
            movement = {r.role: Decimal(r.micro).scaleb(-6) for r in rows}
            # Positive posting amounts are credits.
            if not participant:
                postings = movement
            elif participant['role'] == 'buyer':
                postings = {'wallet': -movement['buyer'], 'payable': -movement['supplier'],
                            'fee': -movement['network-fee']}
            else:
                postings = {'wallet': -movement['supplier'], 'receivable': movement['supplier']}
            if sum(postings.values()) != 0:
                raise UserError("Unbalanced settlement postings.")
            for role, amount in postings.items():
                if amount:
                    lines.append({'account': book['accounts'][role], 'description': role,
                                  'debit': max(-amount, 0), 'credit': max(amount, 0)})
            if os.environ.get('DUEBYTE_LEDGER_BOOK'):
                date = Pool().get('ir.date').today()
                period = Pool().get('account.period').find(book['company'], date=date).id
            else:
                date = datetime.date.fromisoformat(book['date'])
                period = book['period']
            move, = Move.create([{'company': book['company'], 'journal': book['journal'],
                                  'period': period, 'date': date,
                                  'description': settlement.payment_key, 'lines': [('create', lines)]}])
            Move.post([move])
            cls.write([settlement], {'move': move.id})
        return reply
