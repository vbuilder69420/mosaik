import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import {
  derivePad,
  computeContribution,
  xorArrays,
  stringToBytes,
  bytesToString,
} from "./crypto";

// ── Theme ─────────────────────────────────────────────────

const BG = "#0d1117";
const PANEL_BG = "#161b22";
const BORDER = "#30363d";
const TEXT = "#e6edf3";
const DIM = "#484f58";
const ACCENT = "#58a6ff";
const GREEN = "#3fb950";
const YELLOW = "#d29922";
const RED = "#f85149";
const PURPLE = "#bc8cff";
const NODE_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f85149"];
const MSG_LEN = 16;
const MESSAGE = "Hello, anonymous";

// ── Precompute all crypto ─────────────────────────────────

const GROUP_IDS = [0, 1, 2, 3];
const msgBytes = stringToBytes(MESSAGE, MSG_LEN);
const contribs = GROUP_IDS.map((id) => {
  const msg = id === 3 ? msgBytes : new Array(MSG_LEN).fill(0);
  return computeContribution(id, GROUP_IDS, 1, msg);
});
const roundOutput = contribs.reduce(
  (a, c) => xorArrays(a, c),
  new Array(MSG_LEN).fill(0)
);

// Pairwise pads
const pairPads: { a: number; b: number; pad: number[] }[] = [];
for (let i = 0; i < 4; i++)
  for (let j = i + 1; j < 4; j++)
    pairPads.push({ a: i, b: j, pad: derivePad(i, j, 1, MSG_LEN) });

// ── Timing ────────────────────────────────────────────────

const S = {
  title:      [0, 4.5],
  intro:      [4.5, 11],
  topology:   [11, 17],
  pads:       [17, 25],
  message:    [25, 30],
  xor:        [30, 42],
  submit:     [42, 50],
  cancel:     [50, 60],
  reveal:     [60, 67],
  outro:      [67, 75],
} as const;

function t(frame: number, fps: number, s: readonly [number, number]) {
  const a = s[0] * fps, b = s[1] * fps;
  if (frame < a || frame >= b) return -1;
  return (frame - a) / (b - a);
}

function ease(p: number, from: number, to: number) {
  return interpolate(p, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

// ── Byte visualization ────────────────────────────────────

function ByteRow({ bytes, size = 16, opacity = 1, highlight = false }: {
  bytes: number[]; size?: number; opacity?: number; highlight?: boolean;
}) {
  return (
    <div style={{
      display: "flex", gap: 2, opacity,
      filter: highlight ? "brightness(1.3)" : undefined,
    }}>
      {bytes.map((b, i) => {
        const hue = (b / 255) * 300;
        const lit = b === 0 ? 12 : 25 + (b / 255) * 35;
        return (
          <div key={i} style={{
            width: size, height: size, borderRadius: 3,
            background: b === 0
              ? "rgba(255,255,255,0.03)"
              : `hsl(${hue}, 65%, ${lit}%)`,
            border: highlight ? `1px solid ${GREEN}` : "1px solid rgba(255,255,255,0.05)",
          }} />
        );
      })}
    </div>
  );
}

// ── Node card with log ────────────────────────────────────

function NodeCard({ name, color, logs, bytes, bytesLabel, opacity = 1, glow = false, x, y }: {
  name: string; color: string; logs: string[];
  bytes?: number[]; bytesLabel?: string;
  opacity?: number; glow?: boolean;
  x: number; y: number;
}) {
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: 380,
      opacity, transform: `scale(${opacity > 0 ? 1 : 0.9})`,
      transition: "transform 0.3s",
    }}>
      {/* Node header */}
      <div style={{
        background: PANEL_BG,
        border: `1px solid ${glow ? color : BORDER}`,
        borderRadius: 10,
        padding: "12px 16px",
        boxShadow: glow ? `0 0 20px ${color}33` : "0 2px 8px rgba(0,0,0,0.3)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 12, height: 12, borderRadius: "50%",
            background: color,
            boxShadow: glow ? `0 0 8px ${color}` : undefined,
          }} />
          <span style={{ color, fontFamily: "monospace", fontSize: 15, fontWeight: 700 }}>
            {name}
          </span>
        </div>

        {/* Log lines */}
        <div style={{
          fontFamily: "monospace", fontSize: 12, lineHeight: 1.6,
          color: DIM, minHeight: 60,
        }}>
          {logs.map((line, i) => (
            <div key={i} style={{
              color: line.startsWith("✓") ? GREEN
                : line.startsWith("→") ? YELLOW
                : line.startsWith("⊕") ? PURPLE
                : DIM,
            }}>
              {line}
            </div>
          ))}
        </div>

        {/* Byte display */}
        {bytes && (
          <div style={{ marginTop: 8 }}>
            {bytesLabel && (
              <div style={{ fontSize: 11, color: DIM, marginBottom: 4, fontFamily: "monospace" }}>
                {bytesLabel}
              </div>
            )}
            <ByteRow bytes={bytes} size={18} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Connection line (SVG) ─────────────────────────────────

function ConnLine({ x1, y1, x2, y2, progress = 1, color = BORDER, pulse = false }: {
  x1: number; y1: number; x2: number; y2: number;
  progress?: number; color?: string; pulse?: boolean;
}) {
  const ex = x1 + (x2 - x1) * progress;
  const ey = y1 + (y2 - y1) * progress;
  return (
    <>
      <line x1={x1} y1={y1} x2={ex} y2={ey}
        stroke={color} strokeWidth={1.5} opacity={0.4} />
      {pulse && progress > 0.1 && (
        <circle cx={ex} cy={ey} r={4} fill={color} opacity={0.8}>
        </circle>
      )}
    </>
  );
}

// ── Data packet animation ─────────────────────────────────

function DataPacket({ x1, y1, x2, y2, progress, color, label }: {
  x1: number; y1: number; x2: number; y2: number;
  progress: number; color: string; label?: string;
}) {
  const px = x1 + (x2 - x1) * progress;
  const py = y1 + (y2 - y1) * progress;
  if (progress < 0 || progress > 1) return null;
  return (
    <g>
      <circle cx={px} cy={py} r={8} fill={color} opacity={0.9} />
      <circle cx={px} cy={py} r={14} fill={color} opacity={0.2} />
      {label && (
        <text x={px} y={py - 20} fill={color} fontSize={11}
          fontFamily="monospace" textAnchor="middle" fontWeight="bold">
          {label}
        </text>
      )}
    </g>
  );
}

// ── Central accumulator ───────────────────────────────────

function Accumulator({ bytes, label, opacity, x, y }: {
  bytes: number[]; label: string; opacity: number; x: number; y: number;
}) {
  return (
    <div style={{
      position: "absolute", left: x, top: y, opacity,
      textAlign: "center",
    }}>
      <div style={{
        fontFamily: "monospace", fontSize: 13, color: GREEN,
        marginBottom: 6, fontWeight: 700,
      }}>
        {label}
      </div>
      <div style={{
        background: PANEL_BG, border: `1px solid ${GREEN}44`,
        borderRadius: 8, padding: "8px 12px", display: "inline-block",
        boxShadow: `0 0 15px ${GREEN}11`,
      }}>
        <ByteRow bytes={bytes} size={22} highlight />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────

export const DcNetDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Scene progress values (-1 if not active)
  const titleP    = t(frame, fps, S.title);
  const introP    = t(frame, fps, S.intro);
  const topoP     = t(frame, fps, S.topology);
  const padsP     = t(frame, fps, S.pads);
  const msgP      = t(frame, fps, S.message);
  const xorP      = t(frame, fps, S.xor);
  const submitP   = t(frame, fps, S.submit);
  const cancelP   = t(frame, fps, S.cancel);
  const revealP   = t(frame, fps, S.reveal);
  const outroP    = t(frame, fps, S.outro);

  // Node layout: 2x2 grid
  const nodePositions = [
    { x: 100, y: 160 },   // M0 top-left
    { x: 100, y: 560 },   // M1 bottom-left
    { x: 1440, y: 160 },  // M2 top-right
    { x: 1440, y: 560 },  // Agg bottom-right
  ];
  // Center points for SVG lines
  const nodeCenters = nodePositions.map(p => ({
    x: p.x + 190, y: p.y + 60,
  }));

  const showNodes = topoP >= 0 || padsP >= 0 || msgP >= 0 || xorP >= 0
    || submitP >= 0 || cancelP >= 0 || revealP >= 0;

  // Build log lines per node based on current scene
  function getNodeLogs(i: number): string[] {
    const name = i === 3 ? "Aggregator" : `Mixer ${i}`;
    const logs: string[] = [];

    if (topoP >= 0) {
      if (ease(topoP, 0, 0.3) > 0) logs.push("→ Joining network...");
      if (ease(topoP, 0.2, 0.5) > 0) logs.push("✓ Discovered 3 peers");
      if (ease(topoP, 0.4, 0.7) > 0) logs.push("✓ Raft group formed");
      if (ease(topoP, 0.6, 0.9) > 0) logs.push(i === 0 ? "✓ Elected as leader" : "✓ Following leader M0");
    }
    if (padsP >= 0) {
      logs.length = 0;
      if (ease(padsP, 0, 0.2) > 0) logs.push("→ Deriving pairwise pads...");
      for (const pp of pairPads) {
        if (pp.a === i || pp.b === i) {
          const other = pp.a === i ? pp.b : pp.a;
          const oName = other === 3 ? "Agg" : `M${other}`;
          if (ease(padsP, 0.1 + other * 0.1, 0.3 + other * 0.1) > 0)
            logs.push(`✓ pad(${name[0]}${i === 3 ? "" : i},${oName})`);
        }
      }
    }
    if (msgP >= 0) {
      logs.length = 0;
      if (i === 3) {
        logs.push("→ Waiting for client input...");
        if (ease(msgP, 0.3, 0.5) > 0) logs.push(`✓ Received: "${MESSAGE}"`);
      } else {
        logs.push("→ Round 1 started");
        logs.push("→ Preparing cover traffic (zeros)");
      }
    }
    if (xorP >= 0) {
      logs.length = 0;
      const stagger = i * 0.15;
      if (ease(xorP, stagger, stagger + 0.1) > 0)
        logs.push(i === 3 ? '⊕ message = "Hello, anonymous"' : "⊕ message = [0, 0, 0, ...]");
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        const jName = j === 3 ? "Agg" : `M${j}`;
        if (ease(xorP, stagger + 0.1 + j * 0.05, stagger + 0.2 + j * 0.05) > 0)
          logs.push(`⊕ XOR pad(${i === 3 ? "A" : "M" + i},${jName})`);
      }
      if (ease(xorP, stagger + 0.4, stagger + 0.5) > 0)
        logs.push("✓ Contribution ready");
    }
    if (submitP >= 0) {
      logs.length = 0;
      const stagger = i * 0.15;
      logs.push("→ Submitting to Raft...");
      if (ease(submitP, stagger + 0.2, stagger + 0.4) > 0)
        logs.push("✓ Committed to log");
      if (ease(submitP, 0.7, 0.9) > 0 && i === 0)
        logs.push("✓ All 4 contributions received");
    }
    if (cancelP >= 0) {
      logs.length = 0;
      logs.push("→ XOR accumulating...");
      if (ease(cancelP, 0.3, 0.5) > 0)
        logs.push("⊕ Pads cancelling (X⊕X=0)");
      if (ease(cancelP, 0.6, 0.8) > 0)
        logs.push("✓ Round 1 output ready");
    }
    if (revealP >= 0) {
      logs.length = 0;
      logs.push("✓ Round 1 complete");
      logs.push(`✓ Output: "${MESSAGE}"`);
      if (i !== 0 && ease(revealP, 0.3, 0.5) > 0)
        logs.push("✓ Replicated from leader");
    }
    return logs.slice(-4); // max 4 lines visible
  }

  // Node bytes display
  function getNodeBytes(i: number): { bytes?: number[]; label?: string } {
    if (xorP >= 0 && ease(xorP, i * 0.15 + 0.4, i * 0.15 + 0.5) > 0)
      return { bytes: contribs[i], label: "contribution (random-looking)" };
    if (msgP >= 0 && i === 3 && ease(msgP, 0.3, 0.5) > 0)
      return { bytes: msgBytes, label: `"${MESSAGE}"` };
    if (padsP >= 0) {
      const myPad = pairPads.find(p => p.a === i || p.b === i);
      if (myPad && ease(padsP, 0.3, 0.5) > 0)
        return { bytes: myPad.pad, label: `pad(${myPad.a},${myPad.b})` };
    }
    return {};
  }

  // Accumulator state
  function getAccState(): { bytes: number[]; label: string; step: number } {
    if (cancelP < 0) return { bytes: new Array(MSG_LEN).fill(0), label: "", step: 0 };
    const step = Math.min(3, Math.floor(
      interpolate(cancelP, [0.05, 0.7], [0, 4], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })
    ));
    let acc = new Array(MSG_LEN).fill(0);
    for (let i = 0; i <= step; i++) acc = xorArrays(acc, contribs[i]);
    return {
      bytes: acc,
      label: step < 3 ? `Accumulator (${step + 1}/4 XOR'd)` : "Round output — pads cancelled!",
      step,
    };
  }

  const acc = getAccState();

  return (
    <div style={{
      width: 1920, height: 1080, background: BG,
      position: "relative", overflow: "hidden",
      fontFamily: "'SF Mono', 'Fira Code', monospace",
    }}>
      {/* Subtle grid background */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `linear-gradient(${BORDER}22 1px, transparent 1px), linear-gradient(90deg, ${BORDER}22 1px, transparent 1px)`,
        backgroundSize: "60px 60px",
      }} />

      {/* SVG layer for lines and packets */}
      <svg width={1920} height={1080} style={{ position: "absolute", zIndex: 1 }}>
        {/* Connection lines */}
        {showNodes && pairPads.map(({ a, b }, idx) => {
          const lineP = padsP >= 0 ? ease(padsP, idx * 0.06, idx * 0.06 + 0.2) : (topoP >= 0 ? ease(topoP, 0.5, 0.8) : 1);
          return (
            <ConnLine key={`l-${a}-${b}`}
              x1={nodeCenters[a].x} y1={nodeCenters[a].y}
              x2={nodeCenters[b].x} y2={nodeCenters[b].y}
              progress={lineP} color={BORDER}
            />
          );
        })}

        {/* Data packets during submit */}
        {submitP >= 0 && GROUP_IDS.map(i => {
          const stagger = i * 0.15;
          const p = interpolate(submitP, [stagger, stagger + 0.3], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <DataPacket key={`pkt-${i}`}
              x1={nodeCenters[i].x} y1={nodeCenters[i].y}
              x2={960} y2={480}
              progress={p}
              color={NODE_COLORS[i]}
              label={`C${i}`}
            />
          );
        })}
      </svg>

      {/* ── Title ──────────────────────────────────── */}
      {titleP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
          zIndex: 10,
          opacity: interpolate(titleP, [0, 0.15, 0.8, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 64, fontWeight: 800, color: ACCENT, letterSpacing: -2 }}>
            DC-Net Mixing
          </div>
          <div style={{ fontSize: 26, color: DIM, marginTop: 16 }}>
            Anonymous Broadcast on Mosaik
          </div>
          <div style={{
            marginTop: 40, display: "flex", gap: 30,
            fontSize: 14, color: DIM,
          }}>
            <span>Dining Cryptographers Network</span>
            <span style={{ color: BORDER }}>|</span>
            <span>XOR-based anonymity</span>
            <span style={{ color: BORDER }}>|</span>
            <span>Raft consensus</span>
          </div>
        </div>
      )}

      {/* ── Intro ──────────────────────────────────── */}
      {introP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
          zIndex: 10, padding: 100,
          opacity: interpolate(introP, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 36, fontWeight: 700, color: TEXT, textAlign: "center", marginBottom: 40 }}>
            How do you broadcast a message
            <br />
            <span style={{ color: RED }}>without anyone knowing you sent it?</span>
          </div>
          <div style={{
            fontSize: 20, color: DIM, textAlign: "center",
            lineHeight: 2, maxWidth: 800,
            opacity: ease(introP, 0.2, 0.4),
          }}>
            Each node XORs its message with shared random pads.
            <br />
            All contributions are combined — the pads cancel out.
            <br />
            <span style={{ color: GREEN }}>Only the message remains. Nobody knows who sent it.</span>
          </div>
          <div style={{
            marginTop: 50, opacity: ease(introP, 0.5, 0.7),
          }}>
            <div style={{ fontSize: 14, color: DIM, marginBottom: 8 }}>
              The message "{MESSAGE}" as bytes:
            </div>
            <ByteRow bytes={msgBytes} size={28} />
          </div>
        </div>
      )}

      {/* ── Node cards ─────────────────────────────── */}
      {showNodes && (
        <div style={{ position: "absolute", inset: 0, zIndex: 5 }}>
          {GROUP_IDS.map(i => {
            const name = i === 3 ? "Aggregator" : `Mixer ${i}`;
            const nodeOpacity = topoP >= 0
              ? ease(topoP, i * 0.1, i * 0.1 + 0.25)
              : 1;
            const { bytes, label } = getNodeBytes(i);
            return (
              <NodeCard key={i}
                name={name}
                color={NODE_COLORS[i]}
                logs={getNodeLogs(i)}
                bytes={bytes}
                bytesLabel={label}
                opacity={nodeOpacity}
                glow={xorP >= 0 && ease(xorP, i * 0.15 + 0.35, i * 0.15 + 0.5) > 0.5}
                x={nodePositions[i].x}
                y={nodePositions[i].y}
              />
            );
          })}
        </div>
      )}

      {/* ── Scene headers ──────────────────────────── */}
      {topoP >= 0 && (
        <div style={{
          position: "absolute", top: 40, left: 0, right: 0,
          textAlign: "center", zIndex: 10,
          opacity: interpolate(topoP, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>
            Nodes self-organize into a mixing cluster
          </div>
          <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
            Gossip discovery · Raft consensus · Full-mesh bonds · TEE attestation tags
          </div>
        </div>
      )}

      {padsP >= 0 && (
        <div style={{
          position: "absolute", top: 40, left: 0, right: 0,
          textAlign: "center", zIndex: 10,
          opacity: interpolate(padsP, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>
            Each pair derives a shared random pad
          </div>
          <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
            blake3(group_key ‖ sorted(A,B) ‖ round) → {MSG_LEN} bytes · symmetric: pad(A,B) = pad(B,A)
          </div>
        </div>
      )}

      {msgP >= 0 && (
        <div style={{
          position: "absolute", top: 40, left: 0, right: 0,
          textAlign: "center", zIndex: 10,
          opacity: interpolate(msgP, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: YELLOW }}>
            Round 1: Client sends message to Aggregator
          </div>
          <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
            Client → Stream (TEE-gated) → Aggregator folds message into its contribution
          </div>
        </div>
      )}

      {xorP >= 0 && (
        <div style={{
          position: "absolute", top: 40, left: 0, right: 0,
          textAlign: "center", zIndex: 10,
          opacity: interpolate(xorP, [0, 0.05, 0.9, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: PURPLE }}>
            Each node: contribution = message ⊕ all pairwise pads
          </div>
          <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
            Mixers XOR zeros with pads · Aggregator XORs real message with pads · All outputs look random
          </div>
        </div>
      )}

      {submitP >= 0 && (
        <div style={{
          position: "absolute", top: 40, left: 0, right: 0,
          textAlign: "center", zIndex: 10,
          opacity: interpolate(submitP, [0, 0.1, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>
            Contributions submitted to Raft consensus
          </div>
          <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
            Each node's contribution is replicated to all members via the Raft log
          </div>
        </div>
      )}

      {/* ── Central accumulator ────────────────────── */}
      {cancelP >= 0 && (
        <>
          <div style={{
            position: "absolute", top: 40, left: 0, right: 0,
            textAlign: "center", zIndex: 10,
            opacity: interpolate(cancelP, [0, 0.05, 0.9, 1], [0, 1, 1, 0]),
          }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: GREEN }}>
              XOR all contributions → pads cancel!
            </div>
            <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>
              Each pad(i,j) appears in node i's AND node j's contribution → X ⊕ X = 0
            </div>
          </div>
          <Accumulator
            bytes={acc.bytes}
            label={acc.label}
            opacity={ease(cancelP, 0.05, 0.15)}
            x={720} y={440}
          />
        </>
      )}

      {/* ── Reveal ─────────────────────────────────── */}
      {revealP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center",
          zIndex: 8, paddingTop: 350,
        }}>
          <div style={{
            fontSize: 42, fontWeight: 800, color: GREEN,
            opacity: ease(revealP, 0, 0.2),
          }}>
            Message recovered anonymously
          </div>
          <div style={{
            fontSize: 32, color: TEXT, marginTop: 20,
            opacity: ease(revealP, 0.1, 0.3),
          }}>
            "{MESSAGE}"
          </div>
          <div style={{
            fontSize: 24, color: RED, marginTop: 30,
            opacity: ease(revealP, 0.25, 0.45),
          }}>
            But which node sent it?
          </div>
          <div style={{
            fontSize: 18, color: DIM, marginTop: 16, textAlign: "center",
            opacity: ease(revealP, 0.4, 0.6),
          }}>
            All 4 contributions were indistinguishable from random bytes.
            <br />
            No observer can identify the sender.
          </div>
        </div>
      )}

      {/* ── Outro ──────────────────────────────────── */}
      {outroP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
          zIndex: 10,
          opacity: interpolate(outroP, [0, 0.15, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 48, fontWeight: 800, color: ACCENT }}>
            Built on Mosaik
          </div>
          <div style={{ fontSize: 22, color: DIM, marginTop: 16 }}>
            Self-organizing distributed systems runtime
          </div>
          <div style={{
            display: "flex", gap: 40, marginTop: 40,
            fontSize: 16, color: TEXT,
          }}>
            <span>Discovery</span>
            <span style={{ color: DIM }}>·</span>
            <span>Streams</span>
            <span style={{ color: DIM }}>·</span>
            <span>Raft Groups</span>
            <span style={{ color: DIM }}>·</span>
            <span>Collections</span>
          </div>
          <div style={{
            marginTop: 50, fontSize: 18, color: GREEN,
            opacity: ease(outroP, 0.3, 0.5),
          }}>
            github.com/flashbots/mosaik
          </div>
          <div style={{
            marginTop: 16, fontSize: 14, color: DIM,
            opacity: ease(outroP, 0.4, 0.6),
          }}>
            8/8 tests passing · 3 mixing rounds · TEE attestation gating
          </div>
        </div>
      )}
    </div>
  );
};
