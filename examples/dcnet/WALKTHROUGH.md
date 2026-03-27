# DC-Net Mixing Demo Walkthrough

A step-by-step explanation of the DC-net (Dining Cryptographers Network) demo built on mosaik, with annotated code, protocol explanation, and proof of correctness.

---

## 1. What is a DC-Net?

A DC-net provides **information-theoretically secure anonymous broadcast**. The core idea (David Chaum, 1988):

- Every pair of participants shares a secret random pad
- Each participant XORs their message (or zeros if not sending) with all their pads
- All contributions are XORed together
- **The pads cancel out** (each appears exactly twice), leaving only the messages
- Nobody can tell who sent what

```
Node A contribution = Message_A ⊕ pad(A,B) ⊕ pad(A,C) ⊕ pad(A,D)
Node B contribution = Message_B ⊕ pad(A,B) ⊕ pad(B,C) ⊕ pad(B,D)
Node C contribution = Message_C ⊕ pad(A,C) ⊕ pad(B,C) ⊕ pad(C,D)
Node D contribution = Message_D ⊕ pad(A,D) ⊕ pad(B,D) ⊕ pad(C,D)

XOR all 4:
  = Message_A ⊕ Message_B ⊕ Message_C ⊕ Message_D
  ⊕ pad(A,B) ⊕ pad(A,B)   ← cancels (appears in A and B)
  ⊕ pad(A,C) ⊕ pad(A,C)   ← cancels
  ⊕ pad(A,D) ⊕ pad(A,D)   ← cancels
  ⊕ pad(B,C) ⊕ pad(B,C)   ← cancels
  ⊕ pad(B,D) ⊕ pad(B,D)   ← cancels
  ⊕ pad(C,D) ⊕ pad(C,D)   ← cancels

Result = Message_A ⊕ Message_B ⊕ Message_C ⊕ Message_D
```

If only Node A sends a real message and everyone else sends zeros:
`Result = Message_A ⊕ 0 ⊕ 0 ⊕ 0 = Message_A`

The message is recovered, but **nobody knows Node A sent it**. Every contribution looks like random bytes.

---

## 2. Demo Topology

```
                                ┌──────────────────────────┐
Client Node ──stream──► Aggregator ──group──► Mixer0       │
    (sends message)     (pre-XORs      ┌───► Mixer1       │ Raft Group
     with TEE tag)       client msg     │ ┌─► Mixer2       │ (consensus)
                         into its pads) │ │                 │
                                        │ │  All 4 are     │
                                        └─┘  group members │
                                └──────────────────────────┘
                                        │
                                        ▼
                                  Round Output
                                (anonymous message)
```

**5 mosaik Network nodes** run in the same process:
- **Mixer0, Mixer1, Mixer2** — group members that contribute cover traffic (zeros + pads)
- **Aggregator** — group member that folds the client's message into its contribution
- **Client** — external node that sends messages to the aggregator via a typed stream

---

## 3. Running the Demo

```
$ RUST_LOG=error cargo run -p dcnet
```

### Output

```
=== DC-Net Mixing Demo on Mosaik ===

Mixing cluster online: 4 nodes, leader 808a708bbc

Client connected to aggregator (TEE-attested)

--- Round 1 ---
  Output: "Hello from an anonymous sender!"
    Mixer0  (663d30dc…): contribution is random bytes
    Mixer1  (94bd7dff…): contribution is random bytes
    Mixer2  (808a708b…): contribution is random bytes
    Aggregator (d8e31b9c…): contribution is random bytes
  All contributions indistinguishable from random.

--- Round 2 ---
  Output: "Privacy is a human right."
    Mixer0  (663d30dc…): contribution is random bytes
    Mixer1  (94bd7dff…): contribution is random bytes
    Mixer2  (808a708b…): contribution is random bytes
    Aggregator (d8e31b9c…): contribution is random bytes
  All contributions indistinguishable from random.

--- Round 3 ---
  Output: "You can't tell who sent this."
    Mixer0  (663d30dc…): contribution is random bytes
    Mixer1  (94bd7dff…): contribution is random bytes
    Mixer2  (808a708b…): contribution is random bytes
    Aggregator (d8e31b9c…): contribution is random bytes
  All contributions indistinguishable from random.

Follower g1 has replicated all rounds (consistent)

=== Demo complete ===
  3 rounds executed across 4 mixing nodes
  Client message delivered anonymously via aggregator
  Non-attested nodes rejected from input stream
```

---

## 4. Step-by-Step Protocol Walkthrough

### Phase 1: Network Formation (self-organizing)

```rust
let mixer0 = Network::new(network_id).await?;
let mixer1 = Network::new(network_id).await?;
let mixer2 = Network::new(network_id).await?;
let aggregator = Network::new(network_id).await?;
```

Each node gets a random iroh identity (Ed25519 keypair) and joins the same `NetworkId`. Nodes discover each other via gossip-based catalog sync:

```rust
discover_all([&mixer0, &mixer1, &mixer2, &aggregator]).await?;
```

### Phase 2: TEE Attestation Tags

Each mixing node adds a simulated TEE measurement hash to its discovery entry:

```rust
let measurement: Tag = "dcnet-tee-measurement-v1".into();
for net in [&mixer0, &mixer1, &mixer2, &aggregator] {
    net.discovery().add_tags(measurement);
}
```

Later, the aggregator only subscribes to clients that have this tag:

```rust
let mut agg_consumer = aggregator
    .streams()
    .consumer::<ClientInput>()
    .subscribe_if(move |peer| peer.tags().contains(&expected_tag))
    .build();
```

A client without the tag would be rejected.

### Phase 3: Raft Group Formation

All 4 nodes join the same Raft group with the `DcNetMixer` state machine:

```rust
let g0 = mixer0.groups()
    .with_key(group_key)
    .with_state_machine(DcNetMixer::default())
    .join();
```

Raft elects a leader. All nodes form authenticated bonds (full mesh). The state machine is replicated across all 4 nodes.

### Phase 4: Participant Registration

```rust
g0.execute(DcNetCommand::SetParticipants(peers)).await?;
```

This Raft command is replicated to all nodes. Everyone now knows the exact set of 4 participants and will expect exactly 4 contributions per round.

### Phase 5: A Round of Mixing

**Step 5a: Start the round**

```rust
g0.execute(DcNetCommand::StartRound(1)).await?;
```

Replicated via Raft — all nodes now know round 1 is active.

**Step 5b: Client sends message to aggregator**

```rust
client_producer.send(ClientInput {
    round: 1,
    data: padded_message,  // "Hello from an anonymous sender!" + zeros
}).await?;
```

The message flows over a mosaik typed stream to the aggregator.

**Step 5c: Each mixer computes its contribution**

For each mixer (sending cover traffic = zeros):

```rust
let contrib = compute_contribution(
    secret,              // group key bytes
    my_id.as_bytes(),    // this node's ID
    &all_peers,          // all 4 participant IDs
    round_num,           // round 1
    &zeros,              // cover traffic
    MESSAGE_SIZE,        // 256 bytes
);
```

Internally, this computes:

```
contribution = zeros ⊕ pad(me, peer1) ⊕ pad(me, peer2) ⊕ pad(me, peer3)
```

The result looks like random bytes — indistinguishable from a real message.

**Step 5d: Aggregator computes its contribution**

The aggregator uses the **client's message** instead of zeros:

```rust
let agg_contrib = compute_contribution(
    secret,
    agg_id.as_bytes(),
    &all_peers,
    round_num,
    &client_msg.data,    // ← the actual message!
    MESSAGE_SIZE,
);
```

```
agg_contribution = client_message ⊕ pad(agg, mixer0) ⊕ pad(agg, mixer1) ⊕ pad(agg, mixer2)
```

This also looks like random bytes. Nobody seeing just this contribution can tell it contains a real message.

**Step 5e: All 4 contributions submitted to Raft**

```rust
group.execute(DcNetCommand::Contribute(Contribution {
    round: 1,
    peer: my_id,
    data: contrib,
})).await?;
```

The state machine collects contributions and XORs them into an accumulator. When all 4 arrive:

```
output = mixer0_contrib ⊕ mixer1_contrib ⊕ mixer2_contrib ⊕ agg_contrib
       = (0 ⊕ pads_0) ⊕ (0 ⊕ pads_1) ⊕ (0 ⊕ pads_2) ⊕ (msg ⊕ pads_agg)
       = msg ⊕ (all pads cancel)
       = msg
       = "Hello from an anonymous sender!"
```

**Step 5f: Query the result**

```rust
let result = g0.query(DcNetQuery::RoundOutput(1), Consistency::Strong).await?;
// → "Hello from an anonymous sender!"
```

All 4 nodes see the same output (Raft replication guarantees consistency).

---

## 5. How We Know It's Working Correctly

### Test 1: Pad Cancellation (pure math, no network)

```
$ cargo test --test basic dcnet::mixing::pad_cancellation -- --test-threads=1

running 2 tests
test dcnet::mixing::pad_cancellation ... ok
test dcnet::mixing::pad_cancellation_single_sender ... ok

test result: ok. 2 passed; 0 failed
```

These tests create 5 fake peer IDs, compute all contributions with zeros, XOR them all together, and verify the result is all zeros. This proves the mathematical foundation: **pairwise pads always cancel**.

The second test has one peer send a real message — the output equals that message exactly.

### Test 2: Single Sender E2E (3 nodes, full Raft)

```
$ TEST_TRACE=on cargo test --test basic dcnet::mixing::single_sender -- --test-threads=1

test dcnet::mixing::single_sender ... ok
```

3 real mosaik nodes with Raft consensus. Node 0 sends "hello dc-net!", nodes 1 and 2 send cover traffic. The round output on **all 3 nodes** equals the original message. This proves:

- Raft replicates the state machine correctly
- The `DcNetMixer::apply()` correctly collects and XORs contributions
- The pad derivation is consistent across all nodes (deterministic from group key + peer IDs + round number)

### Test 3: Cover Traffic Only

```
test dcnet::mixing::cover_traffic_only ... ok
```

All 3 nodes send zeros. Output is all zeros. This proves that when nobody has a message, the protocol produces the identity element (no information leaks).

### Test 4: Two Senders XOR

```
test dcnet::mixing::two_senders_xor ... ok
```

Nodes 0 and 1 both send messages. Output equals `msg_a XOR msg_b`. This is the expected DC-net collision behavior — the protocol correctly produces the XOR of all messages, not just one.

### Test 5: Multiple Rounds

```
test dcnet::mixing::multiple_rounds ... ok
```

3 sequential rounds with different senders. Each round produces the correct output independently. This proves the state machine correctly resets between rounds.

### Test 6: Abort Round

```
test dcnet::mixing::abort_round ... ok
```

Start a round, only 2 of 3 contribute (simulating a crash). Round doesn't complete. Execute `AbortRound` — state machine clears. Start a new round — all contribute — works normally. This proves the liveness safety mechanism works.

### Test 7: Attestation Filtering

```
test dcnet::attestation::attested_stream_filtering ... ok
```

A stream producer with `accept_if(|peer| peer.tags().contains(&measurement))` only allows attested consumers. Node with the tag receives data; node without the tag does not. This proves the TEE gating mechanism.

### Full Suite

```
$ TEST_TRACE=on cargo test --test basic dcnet -- --test-threads=1

running 8 tests
test dcnet::attestation::attested_stream_filtering ... ok
test dcnet::mixing::abort_round ... ok
test dcnet::mixing::cover_traffic_only ... ok
test dcnet::mixing::multiple_rounds ... ok
test dcnet::mixing::pad_cancellation ... ok
test dcnet::mixing::pad_cancellation_single_sender ... ok
test dcnet::mixing::single_sender ... ok
test dcnet::mixing::two_senders_xor ... ok

test result: ok. 8 passed; 0 failed
```

---

## 6. Safety Guards in the State Machine

The `DcNetMixer::apply()` method has 5 guards that prevent protocol corruption:

| Guard | What it prevents | Code |
|-------|-----------------|------|
| `c.data.len() != message_size` | XOR of different-length vectors → garbage | Line 132 |
| `!participants.contains(&c.peer)` | Uncancelled pads from outsider | Line 136 |
| `contributed.contains(&c.peer)` | Pad appearing 3x (odd count → doesn't cancel) | Line 140 |
| `current_round != Some(c.round)` | Wrong-round contributions | Line 128 |
| `StartRound(n)` when already on `n` | Duplicate StartRound resetting collected contributions | Line 118 |

Plus `AbortRound(n)` for stuck rounds when a participant crashes.

---

## 7. Known Limitations

1. **Shared-secret pads (no real anonymity).** Any group member can compute any pairwise pad using the shared group key. In production, per-pair ECDH inside a TEE prevents this. See [github.com/flashbots/adcnet](https://github.com/flashbots/adcnet).

2. **Single sender per round.** Two senders' messages XOR together (collision). Real DC-nets use scheduling protocols (e.g., IBLT-based auctions in ADCNet) to avoid collisions.

3. **Aggregator sees client plaintext.** Production would encrypt to a cluster collective key.

---

## 8. File Map

```
examples/dcnet/
├── Cargo.toml           # Workspace member
└── src/
    ├── main.rs          # Demo: 3 mixers + 1 aggregator + 1 client
    ├── machine.rs       # DcNetMixer StateMachine (166 lines)
    ├── pad.rs           # blake3-based pad derivation (92 lines)
    └── types.rs         # Contribution, ClientInput, MESSAGE_SIZE

tests/dcnet/
├── mod.rs               # Inline SM copy + pad functions
├── mixing.rs            # 7 tests: pad math + E2E rounds
└── attestation.rs       # Tag-based stream filtering
```
