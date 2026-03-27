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
const NAMES = ["Mixer 0", "Mixer 1", "Mixer 2", "Aggregator"];
const SHORT = ["M0", "M1", "M2", "Agg"];

// ── Precompute crypto ─────────────────────────────────────

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
const pairPads: { a: number; b: number; pad: number[] }[] = [];
for (let i = 0; i < 4; i++)
  for (let j = i + 1; j < 4; j++)
    pairPads.push({ a: i, b: j, pad: derivePad(i, j, 1, MSG_LEN) });

// ── Scene timing (seconds) ───────────────────────────────
// Extended to ~90s for more detail

const S = {
  title:      [0, 5],
  intro:      [5, 12],
  discovery:  [12, 22],     // NEW: gossip discovery detail
  raft:       [22, 32],     // NEW: leader election + Raft detail
  pads:       [32, 40],
  message:    [40, 46],
  xor:        [46, 56],
  replicate:  [56, 66],     // FIXED: contributions → leader → replicated to all
  converge:   [66, 76],     // FIXED: each node computes same output independently
  reveal:     [76, 84],
  outro:      [84, 92],
} as const;

function t(frame: number, fps: number, s: readonly [number, number]) {
  const a = s[0] * fps, b = s[1] * fps;
  if (frame < a || frame >= b) return -1;
  return (frame - a) / (b - a);
}

function ease(p: number, from: number, to: number) {
  return interpolate(p, [from, to], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

// ── Layout ────────────────────────────────────────────────

// Node card positions (2x2 grid)
const nodePos = [
  { x: 100, y: 180 },   // M0 top-left (LEADER)
  { x: 100, y: 580 },   // M1 bottom-left
  { x: 1440, y: 180 },  // M2 top-right
  { x: 1440, y: 580 },  // Agg bottom-right
];
const CARD_W = 380;
// Center of each card for SVG lines
const ctr = nodePos.map(p => ({ x: p.x + CARD_W / 2, y: p.y + 60 }));

// ── Reusable components ───────────────────────────────────

function ByteRow({ bytes, size = 16, opacity = 1, highlight = false }: {
  bytes: number[]; size?: number; opacity?: number; highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 2, opacity }}>
      {bytes.map((b, i) => {
        const hue = (b / 255) * 300;
        const lit = b === 0 ? 12 : 25 + (b / 255) * 35;
        return (
          <div key={i} style={{
            width: size, height: size, borderRadius: 3,
            background: b === 0 ? "rgba(255,255,255,0.03)" : `hsl(${hue}, 65%, ${lit}%)`,
            border: highlight ? `1px solid ${GREEN}` : "1px solid rgba(255,255,255,0.05)",
          }} />
        );
      })}
    </div>
  );
}

function NodeCard({ idx, logs, bytes, bytesLabel, opacity = 1, glow = false, badge }: {
  idx: number; logs: string[];
  bytes?: number[]; bytesLabel?: string;
  opacity?: number; glow?: boolean; badge?: string;
}) {
  const color = NODE_COLORS[idx];
  const { x, y } = nodePos[idx];
  return (
    <div style={{
      position: "absolute", left: x, top: y, width: CARD_W, opacity,
      transform: `scale(${opacity > 0.5 ? 1 : 0.95})`,
    }}>
      <div style={{
        background: PANEL_BG,
        border: `1px solid ${glow ? color : BORDER}`,
        borderRadius: 10, padding: "12px 16px",
        boxShadow: glow ? `0 0 20px ${color}33` : "0 2px 8px rgba(0,0,0,0.3)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 12, height: 12, borderRadius: "50%", background: color,
            boxShadow: glow ? `0 0 8px ${color}` : undefined,
          }} />
          <span style={{ color, fontFamily: "monospace", fontSize: 15, fontWeight: 700 }}>
            {NAMES[idx]}
          </span>
          {badge && (
            <span style={{
              fontSize: 10, color: BG, background: color,
              borderRadius: 4, padding: "2px 6px", fontWeight: 700,
              marginLeft: "auto",
            }}>
              {badge}
            </span>
          )}
        </div>
        {/* Logs */}
        <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, color: DIM, minHeight: 60 }}>
          {logs.map((line, i) => (
            <div key={i} style={{
              color: line.startsWith("✓") ? GREEN
                : line.startsWith("→") ? YELLOW
                : line.startsWith("⊕") ? PURPLE
                : line.startsWith("◆") ? ACCENT
                : DIM,
            }}>{line}</div>
          ))}
        </div>
        {/* Bytes */}
        {bytes && (
          <div style={{ marginTop: 8 }}>
            {bytesLabel && (
              <div style={{ fontSize: 11, color: DIM, marginBottom: 4, fontFamily: "monospace" }}>
                {bytesLabel}
              </div>
            )}
            <ByteRow bytes={bytes} size={18} highlight={glow} />
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ text, sub, opacity }: { text: string; sub: string; opacity: number }) {
  return (
    <div style={{
      position: "absolute", top: 40, left: 0, right: 0,
      textAlign: "center", zIndex: 10, opacity,
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>{text}</div>
      <div style={{ fontSize: 15, color: DIM, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function DataPacket({ x1, y1, x2, y2, progress, color, label }: {
  x1: number; y1: number; x2: number; y2: number;
  progress: number; color: string; label?: string;
}) {
  if (progress <= 0 || progress >= 1.05) return null;
  const p = Math.min(1, progress);
  const px = x1 + (x2 - x1) * p;
  const py = y1 + (y2 - y1) * p;
  return (
    <g>
      <circle cx={px} cy={py} r={6} fill={color} opacity={0.9} />
      <circle cx={px} cy={py} r={12} fill={color} opacity={0.15} />
      {label && (
        <text x={px} y={py - 16} fill={color} fontSize={11}
          fontFamily="monospace" textAnchor="middle" fontWeight="bold">{label}</text>
      )}
    </g>
  );
}

// ── Main ──────────────────────────────────────────────────

export const DcNetDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleP  = t(frame, fps, S.title);
  const introP  = t(frame, fps, S.intro);
  const discP   = t(frame, fps, S.discovery);
  const raftP   = t(frame, fps, S.raft);
  const padsP   = t(frame, fps, S.pads);
  const msgP    = t(frame, fps, S.message);
  const xorP    = t(frame, fps, S.xor);
  const replP   = t(frame, fps, S.replicate);
  const convP   = t(frame, fps, S.converge);
  const revealP = t(frame, fps, S.reveal);
  const outroP  = t(frame, fps, S.outro);

  const showNodes = discP >= 0 || raftP >= 0 || padsP >= 0 || msgP >= 0
    || xorP >= 0 || replP >= 0 || convP >= 0 || revealP >= 0;

  // ── Build per-node logs ─────────────────────────────────

  function getLogs(i: number): string[] {
    const logs: string[] = [];

    if (discP >= 0) {
      const s = i * 0.08;
      if (ease(discP, s, s + 0.1) > 0) logs.push("→ Binding to random port...");
      if (ease(discP, s + 0.08, s + 0.18) > 0) logs.push("→ Gossip: broadcasting presence");
      if (ease(discP, 0.25, 0.35) > 0) logs.push("✓ Catalog sync with peer");
      if (ease(discP, 0.35, 0.45) > 0) logs.push(`✓ Discovered ${i === 0 ? "3" : "3"} peers`);
      if (ease(discP, 0.5, 0.6) > 0 && i === 3) logs.push("✓ TEE tag: dcnet-measurement-v1");
      if (ease(discP, 0.5, 0.6) > 0 && i < 3) logs.push("✓ TEE tag: dcnet-measurement-v1");
      if (ease(discP, 0.65, 0.75) > 0) logs.push("✓ All peers attested");
    }
    if (raftP >= 0) {
      logs.length = 0;
      if (ease(raftP, 0, 0.1) > 0) logs.push("→ Joining Raft group...");
      if (ease(raftP, 0.1, 0.2) > 0) logs.push("◆ Bond established with " + (i === 0 ? "M1" : "M0"));
      if (ease(raftP, 0.15, 0.25) > 0) logs.push("◆ Bond established with " + (i < 2 ? "M2" : "M1"));
      if (ease(raftP, 0.2, 0.3) > 0) logs.push("◆ Bond established with " + (i === 3 ? "M0" : "Agg"));
      if (ease(raftP, 0.35, 0.45) > 0) {
        if (i === 0) {
          logs.push("→ Election: requesting votes (term 1)");
        } else {
          logs.push("→ Vote requested by M0 (term 1)");
        }
      }
      if (ease(raftP, 0.5, 0.6) > 0) {
        if (i === 0) {
          logs.push("✓ Quorum reached [3+/0-] → LEADER");
        } else {
          logs.push("✓ Granted vote → following M0");
        }
      }
      if (ease(raftP, 0.7, 0.8) > 0) logs.push("✓ Group online, ready for commands");
    }
    if (padsP >= 0) {
      logs.length = 0;
      if (ease(padsP, 0, 0.1) > 0) logs.push("→ Deriving pairwise pads...");
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        if (ease(padsP, 0.1 + j * 0.08, 0.2 + j * 0.08) > 0)
          logs.push(`✓ pad(${SHORT[i]},${SHORT[j]}) = blake3(...)`);
      }
      if (ease(padsP, 0.6, 0.7) > 0) logs.push(`✓ ${3} pads ready (${MSG_LEN}B each)`);
    }
    if (msgP >= 0) {
      logs.length = 0;
      logs.push("→ Round 1 started");
      if (i === 3) {
        if (ease(msgP, 0.2, 0.35) > 0) logs.push("→ Listening on stream...");
        if (ease(msgP, 0.4, 0.55) > 0) logs.push(`✓ Received: "${MESSAGE}"`);
        if (ease(msgP, 0.6, 0.75) > 0) logs.push("→ Will fold into contribution");
      } else {
        logs.push("→ No message to send this round");
        if (ease(msgP, 0.3, 0.5) > 0) logs.push("→ Will submit cover traffic (zeros)");
      }
    }
    if (xorP >= 0) {
      logs.length = 0;
      const s = i * 0.12;
      if (ease(xorP, s, s + 0.08) > 0)
        logs.push(i === 3 ? `⊕ msg = "${MESSAGE}"` : "⊕ msg = [0, 0, 0, ...]");
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        if (ease(xorP, s + 0.08 + j * 0.04, s + 0.15 + j * 0.04) > 0)
          logs.push(`⊕ XOR pad(${SHORT[i]},${SHORT[j]})`);
      }
      if (ease(xorP, s + 0.35, s + 0.45) > 0) logs.push("✓ Contribution ready");
    }
    if (replP >= 0) {
      logs.length = 0;
      const s = i * 0.1;
      if (i === 0) {
        // Leader receives all
        if (ease(replP, 0, 0.1) > 0) logs.push("→ Received own contribution");
        if (ease(replP, 0.15, 0.25) > 0) logs.push("→ Received C1 from M1");
        if (ease(replP, 0.3, 0.4) > 0) logs.push("→ Received C2 from M2");
        if (ease(replP, 0.45, 0.55) > 0) logs.push("→ Received C3 from Agg");
        if (ease(replP, 0.6, 0.7) > 0) logs.push("✓ Replicating to followers...");
        if (ease(replP, 0.75, 0.85) > 0) logs.push("✓ Committed at index 5");
      } else {
        if (ease(replP, s, s + 0.1) > 0) logs.push(`→ Forwarding C${i} to leader M0`);
        if (ease(replP, 0.5, 0.6) > 0) logs.push("→ AppendEntries from leader...");
        if (ease(replP, 0.65, 0.75) > 0) logs.push("✓ Replicated 4 contributions");
        if (ease(replP, 0.8, 0.9) > 0) logs.push("✓ Committed at index 5");
      }
    }
    if (convP >= 0) {
      logs.length = 0;
      logs.push("→ Applying committed entries...");
      const step = Math.min(3, Math.floor(ease(convP, 0.05, 0.6) * 4));
      for (let j = 0; j <= step; j++) {
        if (ease(convP, 0.05 + j * 0.12, 0.12 + j * 0.12) > 0)
          logs.push(`⊕ XOR contribution ${j} into acc`);
      }
      if (ease(convP, 0.65, 0.75) > 0) logs.push("✓ Round 1 output ready");
      if (ease(convP, 0.8, 0.9) > 0 && i > 0) logs.push("✓ Same result as leader ✓");
    }
    if (revealP >= 0) {
      logs.length = 0;
      logs.push("✓ Round 1 complete");
      logs.push(`✓ Output: "${MESSAGE}"`);
      if (i > 0) logs.push("✓ Consistent with all replicas");
    }
    return logs.slice(-5);
  }

  // ── Per-node byte display ───────────────────────────────

  function getBytes(i: number): { bytes?: number[]; label?: string } {
    if (convP >= 0) {
      const step = Math.min(3, Math.floor(ease(convP, 0.05, 0.6) * 4));
      let acc = new Array(MSG_LEN).fill(0);
      for (let j = 0; j <= step; j++) acc = xorArrays(acc, contribs[j]);
      if (ease(convP, 0.1, 0.2) > 0)
        return { bytes: acc, label: step < 3 ? `accumulator (${step + 1}/4)` : "output — pads cancelled!" };
    }
    if (xorP >= 0 && ease(xorP, i * 0.12 + 0.35, i * 0.12 + 0.45) > 0)
      return { bytes: contribs[i], label: "contribution (looks random)" };
    if (msgP >= 0 && i === 3 && ease(msgP, 0.4, 0.55) > 0)
      return { bytes: msgBytes, label: `"${MESSAGE}"` };
    if (padsP >= 0) {
      const pp = pairPads.find(p => p.a === i || p.b === i);
      if (pp && ease(padsP, 0.3, 0.4) > 0)
        return { bytes: pp.pad, label: `pad(${SHORT[pp.a]},${SHORT[pp.b]})` };
    }
    return {};
  }

  // ── Badges ──────────────────────────────────────────────

  function getBadge(i: number): string | undefined {
    if (raftP >= 0 && ease(raftP, 0.5, 0.6) > 0) {
      return i === 0 ? "LEADER" : "FOLLOWER";
    }
    if (replP >= 0 || convP >= 0 || revealP >= 0) {
      return i === 0 ? "LEADER" : "FOLLOWER";
    }
    return undefined;
  }

  return (
    <div style={{
      width: 1920, height: 1080, background: BG,
      position: "relative", overflow: "hidden",
      fontFamily: "'SF Mono', 'Fira Code', monospace",
    }}>
      {/* Grid bg */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `linear-gradient(${BORDER}22 1px, transparent 1px), linear-gradient(90deg, ${BORDER}22 1px, transparent 1px)`,
        backgroundSize: "60px 60px",
      }} />

      {/* SVG layer */}
      <svg width={1920} height={1080} style={{ position: "absolute", zIndex: 1 }}>
        {/* Connection lines between nodes */}
        {showNodes && pairPads.map(({ a, b }, idx) => {
          let lineP = 1;
          if (discP >= 0) lineP = ease(discP, 0.3 + idx * 0.05, 0.45 + idx * 0.05);
          else if (raftP >= 0) lineP = 1;
          const ex = ctr[a].x + (ctr[b].x - ctr[a].x) * lineP;
          const ey = ctr[a].y + (ctr[b].y - ctr[a].y) * lineP;
          return (
            <line key={`l-${a}-${b}`}
              x1={ctr[a].x} y1={ctr[a].y} x2={ex} y2={ey}
              stroke={BORDER} strokeWidth={1.5} opacity={0.35}
            />
          );
        })}

        {/* Discovery: gossip broadcast pulses */}
        {discP >= 0 && GROUP_IDS.map(i => {
          const pulseP = ease(discP, 0.1 + i * 0.08, 0.25 + i * 0.08);
          const r = 30 + pulseP * 120;
          return (
            <circle key={`pulse-${i}`}
              cx={ctr[i].x} cy={ctr[i].y} r={r}
              fill="none" stroke={NODE_COLORS[i]}
              strokeWidth={2} opacity={Math.max(0, 0.5 - pulseP * 0.5)}
            />
          );
        })}

        {/* Discovery: catalog sync arrows between pairs */}
        {discP >= 0 && pairPads.slice(0, 4).map(({ a, b }, idx) => {
          const p = interpolate(discP, [0.25 + idx * 0.06, 0.4 + idx * 0.06], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <g key={`sync-${a}-${b}`}>
              <DataPacket x1={ctr[a].x} y1={ctr[a].y} x2={ctr[b].x} y2={ctr[b].y}
                progress={p} color={NODE_COLORS[a]} label="sync" />
              <DataPacket x1={ctr[b].x} y1={ctr[b].y} x2={ctr[a].x} y2={ctr[a].y}
                progress={p} color={NODE_COLORS[b]} />
            </g>
          );
        })}

        {/* Raft: vote request arrows from M0 to others */}
        {raftP >= 0 && [1, 2, 3].map(i => {
          const voteP = interpolate(raftP, [0.3 + i * 0.03, 0.42 + i * 0.03], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <DataPacket key={`vote-${i}`}
              x1={ctr[0].x} y1={ctr[0].y} x2={ctr[i].x} y2={ctr[i].y}
              progress={voteP} color={ACCENT} label="RequestVote" />
          );
        })}

        {/* Raft: vote granted back to M0 */}
        {raftP >= 0 && [1, 2, 3].map(i => {
          const grantP = interpolate(raftP, [0.42 + i * 0.03, 0.54 + i * 0.03], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <DataPacket key={`grant-${i}`}
              x1={ctr[i].x} y1={ctr[i].y} x2={ctr[0].x} y2={ctr[0].y}
              progress={grantP} color={GREEN} label="Granted" />
          );
        })}

        {/* Replicate: contributions travel to leader (M0) first */}
        {replP >= 0 && [1, 2, 3].map(i => {
          const toLeaderP = interpolate(replP, [i * 0.08, i * 0.08 + 0.2], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <DataPacket key={`to-leader-${i}`}
              x1={ctr[i].x} y1={ctr[i].y} x2={ctr[0].x} y2={ctr[0].y}
              progress={toLeaderP} color={NODE_COLORS[i]} label={`C${i}`} />
          );
        })}

        {/* Replicate: leader sends AppendEntries to followers */}
        {replP >= 0 && [1, 2, 3].map(i => {
          const fromLeaderP = interpolate(replP, [0.5 + i * 0.05, 0.5 + i * 0.05 + 0.2], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <DataPacket key={`from-leader-${i}`}
              x1={ctr[0].x} y1={ctr[0].y} x2={ctr[i].x} y2={ctr[i].y}
              progress={fromLeaderP} color={ACCENT} label="AppendEntries" />
          );
        })}
      </svg>

      {/* ── Title ──────────────────────────────────── */}
      {titleP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 10,
          opacity: interpolate(titleP, [0, 0.15, 0.8, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 64, fontWeight: 800, color: ACCENT, letterSpacing: -2 }}>DC-Net Mixing</div>
          <div style={{ fontSize: 26, color: DIM, marginTop: 16 }}>Anonymous Broadcast on Mosaik</div>
          <div style={{ marginTop: 40, display: "flex", gap: 30, fontSize: 14, color: DIM }}>
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
            <br /><span style={{ color: RED }}>without anyone knowing you sent it?</span>
          </div>
          <div style={{ fontSize: 20, color: DIM, textAlign: "center", lineHeight: 2, maxWidth: 800, opacity: ease(introP, 0.2, 0.4) }}>
            Each node XORs its message with shared random pads.
            <br />All contributions are combined — the pads cancel out.
            <br /><span style={{ color: GREEN }}>Only the message remains. Nobody knows who sent it.</span>
          </div>
          <div style={{ marginTop: 50, opacity: ease(introP, 0.5, 0.7) }}>
            <div style={{ fontSize: 14, color: DIM, marginBottom: 8 }}>The message "{MESSAGE}" as bytes:</div>
            <ByteRow bytes={msgBytes} size={28} />
          </div>
        </div>
      )}

      {/* ── Scene headers ──────────────────────────── */}
      {discP >= 0 && (
        <Header
          text="Step 1: Gossip-based peer discovery"
          sub="Each node broadcasts its presence · Pairwise catalog sync · TEE attestation tags verified"
          opacity={interpolate(discP, [0, 0.08, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {raftP >= 0 && (
        <Header
          text="Step 2: Raft consensus — leader election"
          sub="Full-mesh bonds · M0 requests votes · Quorum reached → M0 becomes leader · All commands route through leader"
          opacity={interpolate(raftP, [0, 0.08, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {padsP >= 0 && (
        <Header
          text="Step 3: Derive pairwise random pads"
          sub={`blake3(group_key ‖ sorted(A,B) ‖ round) → ${MSG_LEN} bytes · pad(A,B) = pad(B,A)`}
          opacity={interpolate(padsP, [0, 0.08, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {msgP >= 0 && (
        <Header
          text="Step 4: Client sends message to Aggregator"
          sub="Client → TEE-gated Stream → Aggregator receives plaintext to fold into its contribution"
          opacity={interpolate(msgP, [0, 0.08, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {xorP >= 0 && (
        <Header
          text="Step 5: Each node computes contribution = message ⊕ pads"
          sub="Mixers: zeros ⊕ pads · Aggregator: real message ⊕ pads · All outputs look like random noise"
          opacity={interpolate(xorP, [0, 0.05, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {replP >= 0 && (
        <Header
          text="Step 6: Contributions → Leader → Replicated to all nodes"
          sub="Each node submits via Raft · Leader appends to log · AppendEntries replicates to followers · All commit"
          opacity={interpolate(replP, [0, 0.05, 0.9, 1], [0, 1, 1, 0])}
        />
      )}
      {convP >= 0 && (
        <Header
          text="Step 7: Every node independently XORs all contributions"
          sub="State machine applies committed log entries · Pads cancel (X⊕X=0) · All nodes compute identical output"
          opacity={interpolate(convP, [0, 0.05, 0.9, 1], [0, 1, 1, 0])}
        />
      )}

      {/* ── Node cards ─────────────────────────────── */}
      {showNodes && (
        <div style={{ position: "absolute", inset: 0, zIndex: 5 }}>
          {GROUP_IDS.map(i => {
            let nodeO = 1;
            if (discP >= 0) nodeO = ease(discP, i * 0.06, i * 0.06 + 0.15);
            const { bytes, label } = getBytes(i);
            return (
              <NodeCard key={i} idx={i}
                logs={getLogs(i)}
                bytes={bytes} bytesLabel={label}
                opacity={nodeO}
                badge={getBadge(i)}
                glow={
                  (xorP >= 0 && ease(xorP, i * 0.12 + 0.3, i * 0.12 + 0.45) > 0.5) ||
                  (convP >= 0 && ease(convP, 0.65, 0.75) > 0.5)
                }
              />
            );
          })}
        </div>
      )}

      {/* ── Reveal ─────────────────────────────────── */}
      {revealP >= 0 && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: 300,
          display: "flex", flexDirection: "column", alignItems: "center", zIndex: 8,
        }}>
          <div style={{ fontSize: 42, fontWeight: 800, color: GREEN, opacity: ease(revealP, 0, 0.2) }}>
            Message recovered anonymously
          </div>
          <div style={{ fontSize: 32, color: TEXT, marginTop: 20, opacity: ease(revealP, 0.1, 0.3) }}>
            "{MESSAGE}"
          </div>
          <div style={{ fontSize: 24, color: RED, marginTop: 30, opacity: ease(revealP, 0.25, 0.45) }}>
            But which node sent it?
          </div>
          <div style={{ fontSize: 18, color: DIM, marginTop: 16, textAlign: "center", opacity: ease(revealP, 0.4, 0.6) }}>
            All 4 contributions were indistinguishable from random bytes.
            <br />Every node computed the same output independently via Raft replication.
            <br />No observer can identify the sender.
          </div>
        </div>
      )}

      {/* ── Outro ──────────────────────────────────── */}
      {outroP >= 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 10,
          opacity: interpolate(outroP, [0, 0.15, 0.85, 1], [0, 1, 1, 0]),
        }}>
          <div style={{ fontSize: 48, fontWeight: 800, color: ACCENT }}>Built on Mosaik</div>
          <div style={{ fontSize: 22, color: DIM, marginTop: 16 }}>Self-organizing distributed systems runtime</div>
          <div style={{ display: "flex", gap: 40, marginTop: 40, fontSize: 16, color: TEXT }}>
            <span>Discovery</span><span style={{ color: DIM }}>·</span>
            <span>Streams</span><span style={{ color: DIM }}>·</span>
            <span>Raft Groups</span><span style={{ color: DIM }}>·</span>
            <span>Collections</span>
          </div>
          <div style={{ marginTop: 50, fontSize: 18, color: GREEN, opacity: ease(outroP, 0.3, 0.5) }}>
            github.com/flashbots/mosaik
          </div>
          <div style={{ marginTop: 16, fontSize: 14, color: DIM, opacity: ease(outroP, 0.4, 0.6) }}>
            8/8 tests passing · 3 mixing rounds · TEE attestation gating
          </div>
        </div>
      )}
    </div>
  );
};
