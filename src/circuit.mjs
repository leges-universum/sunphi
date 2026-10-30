import { Bool, Encryption, Field, Group, Poseidon, PrivateKey, Provable, PublicKey,
  Struct, UInt32, UInt64, ZkProgram, setNumberOfWorkers } from 'o1js';

const workerCount = Number(process.env.SUNPHI_PROVER_WORKERS ?? 2);
if (![1,2,4,8].includes(workerCount)) throw new Error('unsupported prover worker count');
setNumberOfWorkers(workerCount);
export const CIRCUIT_NAME = 'sunphi-native-p1-isolated-v1';
export const DOMAIN = Field(190871310001n);
export const LAB_NETWORK = Field(190871310029n);
export const MAX_NOTE = (1n << 48n) - 1n;
export const LAB_REWARD = 100000000n;

export class Note extends Struct({ value: UInt64, salt: Field, owner: PublicKey }) {}
export class Statement extends Struct({
  network: Field, kind: UInt32, epoch: UInt32, expiry: UInt32,
  second: Bool, id0: Field, id1: Field, commitment0: Field, commitment1: Field,
  fee: UInt64, rewardOwner: Field, nonce: Field,
}) {}
export class Outputs extends Struct({
  commitment0: Field, commitment1: Field,
  ephemeral0: Group, ephemeral1: Group,
  cipher0: Provable.Array(Field, 6), cipher1: Provable.Array(Field, 6),
}) {}

export function commitment(note, network = LAB_NETWORK) {
  return Poseidon.hash([DOMAIN, network, note.value.value, note.salt, ...note.owner.toFields()]);
}
export function ownerTag(owner) { return Poseidon.hash([DOMAIN.add(1), ...owner.toFields()]); }
function checkedNote(note) {
  note.value.assertLessThanOrEqual(UInt64.from(MAX_NOTE));
  note.salt.equals(Field(0)).assertFalse('zero blinding');
  note.owner.toGroup().equals(Group.zero).assertFalse('zero owner');
}
function common(s) {
  s.network.assertEquals(LAB_NETWORK);
  s.nonce.equals(Field(0)).assertFalse('zero nonce');
  s.expiry.assertGreaterThanOrEqual(s.epoch);
  s.fee.assertLessThanOrEqual(UInt64.from(MAX_NOTE));
}
function outputs(s, a, b) {
  checkedNote(a); checkedNote(b);
  const ca = commitment(a, s.network), cb = commitment(b, s.network);
  ca.equals(cb).assertFalse('duplicate output');
  // Encrypt inside the constraint system: outputs are bound to amounts, owners,
  // network and salts, not merely to an arbitrary hash of a ciphertext.
  const ea = Encryption.encrypt([s.network, a.value.value, a.salt, ...a.owner.toFields()], a.owner);
  const eb = Encryption.encrypt([s.network, b.value.value, b.salt, ...b.owner.toFields()], b.owner);
  return new Outputs({ commitment0: ca, commitment1: cb,
    ephemeral0: ea.publicKey, ephemeral1: eb.publicKey, cipher0: ea.cipherText, cipher1: eb.cipherText });
}

const Program = ZkProgram({
  name: CIRCUIT_NAME, publicInput: Statement, publicOutput: Outputs,
  methods: {
    transfer: {
      privateInputs: [Note, Note, PrivateKey, PrivateKey, Note, Note],
      async method(s, a, b, ka, kb, outA, outB) {
        common(s); s.kind.assertEquals(UInt32.from(0)); s.rewardOwner.assertEquals(Field(0));
        checkedNote(a); checkedNote(b);
        s.id0.equals(Field(0)).assertFalse();
        a.value.assertGreaterThan(UInt64.from(0));
        a.owner.assertEquals(ka.toPublicKey()); b.owner.assertEquals(kb.toPublicKey());
        commitment(a, s.network).assertEquals(s.commitment0);
        Provable.if(s.second, commitment(b, s.network), Field(0)).assertEquals(s.commitment1);
        s.second.or(b.value.equals(UInt64.from(0))).assertTrue();
        s.second.equals(s.id1.equals(Field(0)).not()).assertTrue();
        s.second.and(s.id0.equals(s.id1)).assertFalse('duplicate input');
        a.value.add(b.value).assertEquals(outA.value.add(outB.value).add(s.fee));
        return { publicOutput: outputs(s, outA, outB) };
      },
    },
    mint: {
      privateInputs: [Note, Note],
      async method(s, a, b) {
        common(s); s.kind.assertEquals(UInt32.from(1));
        s.second.assertFalse(); s.id0.assertEquals(Field(0)); s.id1.assertEquals(Field(0));
        s.commitment0.assertEquals(Field(0)); s.commitment1.assertEquals(Field(0));
        s.fee.assertEquals(UInt64.from(0));
        a.value.assertEquals(UInt64.from(LAB_REWARD)); b.value.assertEquals(UInt64.from(0));
        ownerTag(a.owner).assertEquals(s.rewardOwner); b.owner.assertEquals(a.owner);
        return { publicOutput: outputs(s, a, b) };
      },
    },
  },
});

// No mock-proof switch is exported to the ledger or application.
export async function compileCircuit(cache) { return Program.compile(cache ? { cache } : {}); }
export async function analyzeCircuit() { return Program.analyzeMethods(); }
export async function proveTransfer(s, a, b, ka, kb, oa, ob) {
  return (await Program.transfer(s, a, b, ka, kb, oa, ob)).proof.toJSON();
}
export async function proveMint(s, a, b) { return (await Program.mint(s, a, b)).proof.toJSON(); }

export function newNote(value, owner) {
  const n = BigInt(value);
  if (n < 0n || n > MAX_NOTE) throw new Error('note value outside laboratory range');
  return new Note({ value: UInt64.from(n), salt: Field.random(), owner });
}
export function decryptOutput(output, index, key) {
  const fields = Encryption.decrypt({ publicKey: output[`ephemeral${index}`],
    cipherText: [...output[`cipher${index}`]] }, key);
  fields[0].assertEquals(LAB_NETWORK);
  const owner = PublicKey.fromFields(fields.slice(3));
  owner.assertEquals(key.toPublicKey());
  const note = new Note({ value: UInt64.from(fields[1].toBigInt()), salt: fields[2], owner });
  commitment(note).assertEquals(output[`commitment${index}`]);
  return note;
}
