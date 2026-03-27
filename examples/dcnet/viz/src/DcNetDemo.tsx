import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";
import {
  derivePad,
  computeContribution,
  xorArrays,
  stringToBytes,
  bytesToString,
} from "./crypto";

// ── Layout constants ──────────────────────────────────────

const BG = "#0f0f23";
const NODE_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#bb9af7"];
const PAD_COLOR = "#565f89";
const TEXT_COLOR = "#c0caf5";
const DIM_COLOR = "#565f89";
const ACCENT = "#7aa2f7";
const MSG_LEN = 16; // bytes shown in visualization

const NODE_NAMES = ["Mixer 0", "Mixer 1", "Mixer 2", "Aggregator", "Client"];
const NODE_IDS = [0, 1, 2, 3, 4]; // simplified IDs
const GROUP_IDS = [0, 1, 2, 3]; // first 4 are group members
const MESSAGE = "Hello, anonymous";

// ── Scene timing (in seconds) ─────────────────────────────

const SCENES = {
  title: [0, 5],
  problem: [5, 13],
  nodes_appear: [13, 19],
  pads_explain: [19, 28],
  round_start: [28, 33],
  xor_show: [33, 48],
  cancel: [48, 58],
  reveal: [58, 66],
  outro: [66, 75],
} as const;

function inScene(
  frame: number,
  fps: number,
  scene: readonly [number, number]
): number {
  const startFrame = scene[0] * fps;
  const endFrame = scene[1] * fps;
  if (frame < startFrame || frame >= endFrame) return -1;
  return (frame - startFrame) / (endFrame - startFrame);
}

// ── Components ────────────────────────────────────────────

function ByteGrid({
  bytes,
  x,
  y,
  cellSize = 18,
  cols = 8,
  opacity = 1,
  label,
}: {
  bytes: number[];
  x: number;
  y: number;
  cellSize?: number;
  cols?: number;
  opacity?: number;
  label?: string;
}) {
  return (
    <g opacity={opacity}>
      {label && (
        <text
          x={x}
          y={y - 8}
          fill={DIM_COLOR}
          fontSize={12}
          fontFamily="monospace"
        >
          {label}
        </text>
      )}
      {bytes.map((byte, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const hue = (byte / 255) * 360;
        const lightness = 30 + (byte / 255) * 40;
        return (
          <rect
            key={i}
            x={x + col * cellSize}
            y={y + row * cellSize}
            width={cellSize - 2}
            height={cellSize - 2}
            rx={3}
            fill={`hsl(${hue}, 70%, ${lightness}%)`}
          />
        );
      })}
    </g>
  );
}

function NodeCircle({
  cx,
  cy,
  color,
  label,
  scale = 1,
  opacity = 1,
  glow = false,
}: {
  cx: number;
  cy: number;
  color: string;
  label: string;
  scale?: number;
  opacity?: number;
  glow?: boolean;
}) {
  const r = 32 * scale;
  return (
    <g opacity={opacity}>
      {glow && (
        <circle cx={cx} cy={cy} r={r + 12} fill={color} opacity={0.15} />
      )}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={BG}
        stroke={color}
        strokeWidth={3}
      />
      <text
        x={cx}
        y={cy + 5}
        fill={color}
        fontSize={13}
        fontFamily="monospace"
        textAnchor="middle"
        fontWeight="bold"
      >
        {label}
      </text>
    </g>
  );
}

function Connection({
  x1,
  y1,
  x2,
  y2,
  progress = 1,
  color = PAD_COLOR,
  opacity = 0.4,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress?: number;
  color?: string;
  opacity?: number;
}) {
  const ex = x1 + (x2 - x1) * progress;
  const ey = y1 + (y2 - y1) * progress;
  return (
    <line
      x1={x1}
      y1={y1}
      x2={ex}
      y2={ey}
      stroke={color}
      strokeWidth={1.5}
      opacity={opacity}
    />
  );
}

function FadeText({
  x,
  y,
  text,
  opacity,
  size = 20,
  color = TEXT_COLOR,
  anchor = "start" as const,
  weight = "normal" as const,
}: {
  x: number;
  y: number;
  text: string;
  opacity: number;
  size?: number;
  color?: string;
  anchor?: "start" | "middle" | "end";
  weight?: string;
}) {
  return (
    <text
      x={x}
      y={y}
      fill={color}
      fontSize={size}
      fontFamily="monospace"
      textAnchor={anchor}
      fontWeight={weight}
      opacity={Math.max(0, Math.min(1, opacity))}
    >
      {text}
    </text>
  );
}

// ── Node positions (ring layout) ──────────────────────────

function getNodePos(i: number, total: number, cx: number, cy: number, r: number) {
  const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

// ── Main component ────────────────────────────────────────

export const DcNetDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Node positions
  const ringCx = 960;
  const ringCy = 480;
  const ringR = 280;
  const positions = GROUP_IDS.map((i) =>
    getNodePos(i, GROUP_IDS.length, ringCx, ringCy, ringR)
  );

  // Precompute crypto
  const msgBytes = stringToBytes(MESSAGE, MSG_LEN);
  const contributions = GROUP_IDS.map((id) => {
    const msg = id === 3 ? msgBytes : new Array(MSG_LEN).fill(0); // aggregator sends
    return computeContribution(id, GROUP_IDS, 1, msg);
  });
  const roundOutput = contributions.reduce((acc, c) => xorArrays(acc, c), new Array(MSG_LEN).fill(0));
  const recoveredText = bytesToString(roundOutput);

  // Pairwise pads for visualization
  const pads: { a: number; b: number; pad: number[] }[] = [];
  for (let i = 0; i < GROUP_IDS.length; i++) {
    for (let j = i + 1; j < GROUP_IDS.length; j++) {
      pads.push({ a: i, b: j, pad: derivePad(i, j, 1, MSG_LEN) });
    }
  }

  // ── Scene: Title ──────────────────────────────────────
  const titleP = inScene(frame, fps, SCENES.title);

  // ── Scene: Problem ────────────────────────────────────
  const problemP = inScene(frame, fps, SCENES.problem);

  // ── Scene: Nodes Appear ───────────────────────────────
  const nodesP = inScene(frame, fps, SCENES.nodes_appear);

  // ── Scene: Pads Explain ───────────────────────────────
  const padsP = inScene(frame, fps, SCENES.pads_explain);

  // ── Scene: Round Start ────────────────────────────────
  const roundP = inScene(frame, fps, SCENES.round_start);

  // ── Scene: XOR Show ───────────────────────────────────
  const xorP = inScene(frame, fps, SCENES.xor_show);

  // ── Scene: Cancel ─────────────────────────────────────
  const cancelP = inScene(frame, fps, SCENES.cancel);

  // ── Scene: Reveal ─────────────────────────────────────
  const revealP = inScene(frame, fps, SCENES.reveal);

  // ── Scene: Outro ──────────────────────────────────────
  const outroP = inScene(frame, fps, SCENES.outro);

  const showNodes = nodesP >= 0 || padsP >= 0 || roundP >= 0 || xorP >= 0 || cancelP >= 0 || revealP >= 0;
  const showPads = padsP >= 0 || roundP >= 0 || xorP >= 0;

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        background: BG,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <svg width={1920} height={1080} style={{ position: "absolute" }}>
        {/* ── Title Scene ─────────────────────────────── */}
        {titleP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={420}
              text="DC-Net Mixing"
              opacity={interpolate(titleP, [0, 0.2, 0.8, 1], [0, 1, 1, 0])}
              size={72}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={490}
              text="Anonymous Broadcast on Mosaik"
              opacity={interpolate(titleP, [0.1, 0.3, 0.8, 1], [0, 1, 1, 0])}
              size={28}
              color={DIM_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={560}
              text="Dining Cryptographers Network  ·  XOR-based anonymity  ·  Raft consensus"
              opacity={interpolate(titleP, [0.2, 0.4, 0.8, 1], [0, 1, 1, 0])}
              size={18}
              color={DIM_COLOR}
              anchor="middle"
            />
          </g>
        )}

        {/* ── Problem Scene ───────────────────────────── */}
        {problemP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={100}
              text="The Problem"
              opacity={interpolate(problemP, [0, 0.1, 0.9, 1], [0, 1, 1, 0])}
              size={40}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={180}
              text='Alice wants to broadcast "Hello, anonymous" to the network'
              opacity={interpolate(problemP, [0.05, 0.15, 0.9, 1], [0, 1, 1, 0])}
              size={22}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={230}
              text="without anyone knowing she sent it."
              opacity={interpolate(problemP, [0.1, 0.2, 0.9, 1], [0, 1, 1, 0])}
              size={22}
              color={"#f7768e"}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={340}
              text="If she broadcasts directly, the network sees her IP."
              opacity={interpolate(problemP, [0.2, 0.35, 0.9, 1], [0, 1, 1, 0])}
              size={20}
              color={DIM_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={420}
              text="Solution: the Dining Cryptographers Network (DC-Net)"
              opacity={interpolate(problemP, [0.35, 0.5, 0.9, 1], [0, 1, 1, 0])}
              size={26}
              color={"#9ece6a"}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={500}
              text="Every node XORs its message with shared random pads."
              opacity={interpolate(problemP, [0.45, 0.6, 0.9, 1], [0, 1, 1, 0])}
              size={20}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={540}
              text="When all contributions are combined, the pads cancel out."
              opacity={interpolate(problemP, [0.5, 0.65, 0.9, 1], [0, 1, 1, 0])}
              size={20}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={580}
              text="Only the message remains — and nobody knows who sent it."
              opacity={interpolate(problemP, [0.55, 0.7, 0.9, 1], [0, 1, 1, 0])}
              size={20}
              color={"#9ece6a"}
              anchor="middle"
            />

            {/* Show the message bytes */}
            <ByteGrid
              bytes={msgBytes}
              x={760}
              y={660}
              opacity={interpolate(problemP, [0.6, 0.75, 0.9, 1], [0, 1, 1, 0])}
              label={`"${MESSAGE}" as bytes:`}
              cols={16}
              cellSize={24}
            />
          </g>
        )}

        {/* ── Nodes Appear ────────────────────────────── */}
        {showNodes && (
          <g>
            {/* Connections */}
            {showPads &&
              pads.map(({ a, b }, idx) => {
                const lineProgress = padsP >= 0
                  ? interpolate(padsP, [idx * 0.05, idx * 0.05 + 0.3], [0, 1], { extrapolateRight: "clamp" })
                  : 1;
                return (
                  <Connection
                    key={`c-${a}-${b}`}
                    x1={positions[a].x}
                    y1={positions[a].y}
                    x2={positions[b].x}
                    y2={positions[b].y}
                    progress={lineProgress}
                    opacity={0.25}
                  />
                );
              })}

            {/* Nodes */}
            {positions.map((pos, i) => {
              const nodeOpacity = nodesP >= 0
                ? interpolate(nodesP, [i * 0.1, i * 0.1 + 0.3], [0, 1], { extrapolateRight: "clamp" })
                : 1;
              const isAgg = i === 3;
              return (
                <NodeCircle
                  key={i}
                  cx={pos.x}
                  cy={pos.y}
                  color={NODE_COLORS[i]}
                  label={isAgg ? "Agg" : `M${i}`}
                  opacity={Math.min(1, nodeOpacity)}
                  glow={xorP >= 0 && isAgg}
                />
              );
            })}

            {/* Node labels below */}
            {positions.map((pos, i) => (
              <text
                key={`label-${i}`}
                x={pos.x}
                y={pos.y + 52}
                fill={DIM_COLOR}
                fontSize={11}
                fontFamily="monospace"
                textAnchor="middle"
                opacity={nodesP >= 0 ? interpolate(nodesP, [0.3, 0.6], [0, 1], { extrapolateRight: "clamp" }) : 1}
              >
                {NODE_NAMES[i]}
              </text>
            ))}
          </g>
        )}

        {/* Scene labels */}
        {nodesP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={60}
              text="4 nodes form a Raft group on Mosaik"
              opacity={interpolate(nodesP, [0, 0.2, 0.8, 1], [0, 1, 1, 0])}
              size={28}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={100}
              text="Self-organizing: gossip discovery, automatic bonding, leader election"
              opacity={interpolate(nodesP, [0.1, 0.3, 0.8, 1], [0, 1, 1, 0])}
              size={16}
              color={DIM_COLOR}
              anchor="middle"
            />
          </g>
        )}

        {/* ── Pads Explain ────────────────────────────── */}
        {padsP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={60}
              text="Each pair shares a secret random pad"
              opacity={interpolate(padsP, [0, 0.1, 0.9, 1], [0, 1, 1, 0])}
              size={28}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={100}
              text="pad(A,B) = blake3(group_key || sorted(A,B) || round) — symmetric, deterministic"
              opacity={interpolate(padsP, [0.1, 0.25, 0.9, 1], [0, 1, 1, 0])}
              size={15}
              color={DIM_COLOR}
              anchor="middle"
            />

            {/* Show pad byte grids along connections */}
            {pads.slice(0, 3).map(({ a, b, pad: padBytes }, idx) => {
              const gridOpacity = interpolate(
                padsP,
                [0.2 + idx * 0.15, 0.35 + idx * 0.15, 0.85, 1],
                [0, 1, 1, 0],
                { extrapolateRight: "clamp" }
              );
              const mx = (positions[a].x + positions[b].x) / 2 - 60;
              const my = (positions[a].y + positions[b].y) / 2 - 20;
              return (
                <ByteGrid
                  key={`pad-${a}-${b}`}
                  bytes={padBytes}
                  x={mx}
                  y={my}
                  opacity={gridOpacity}
                  cellSize={14}
                  cols={8}
                  label={`pad(${a},${b})`}
                />
              );
            })}

            <FadeText
              x={960}
              y={870}
              text={`6 pairwise pads for 4 nodes  ·  ${MSG_LEN} bytes each`}
              opacity={interpolate(padsP, [0.5, 0.65, 0.9, 1], [0, 1, 1, 0])}
              size={16}
              color={DIM_COLOR}
              anchor="middle"
            />
          </g>
        )}

        {/* ── Round Start ─────────────────────────────── */}
        {roundP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={60}
              text="Round 1: Aggregator carries the client's message"
              opacity={interpolate(roundP, [0, 0.15, 0.85, 1], [0, 1, 1, 0])}
              size={28}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={100}
              text="Mixers send cover traffic (zeros). Aggregator folds in the real message."
              opacity={interpolate(roundP, [0.1, 0.25, 0.85, 1], [0, 1, 1, 0])}
              size={16}
              color={DIM_COLOR}
              anchor="middle"
            />

            {/* Show message at aggregator */}
            <ByteGrid
              bytes={msgBytes}
              x={positions[3].x + 55}
              y={positions[3].y - 25}
              opacity={interpolate(roundP, [0.2, 0.4], [0, 1], { extrapolateRight: "clamp" })}
              cellSize={14}
              cols={8}
              label={`"${MESSAGE}"`}
            />
          </g>
        )}

        {/* ── XOR Show ────────────────────────────────── */}
        {xorP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={35}
              text="Each node XORs message with pads → contribution"
              opacity={interpolate(xorP, [0, 0.05, 0.95, 1], [0, 1, 1, 0])}
              size={24}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={65}
              text="contribution = message ⊕ pad(me,peer₁) ⊕ pad(me,peer₂) ⊕ pad(me,peer₃)"
              opacity={interpolate(xorP, [0.02, 0.1, 0.95, 1], [0, 1, 1, 0])}
              size={15}
              color={DIM_COLOR}
              anchor="middle"
            />

            {/* Show each node's contribution */}
            {contributions.map((contrib, i) => {
              const stagger = i * 0.12;
              const gridOpacity = interpolate(
                xorP,
                [0.05 + stagger, 0.15 + stagger, 0.95, 1],
                [0, 1, 1, 0],
                { extrapolateRight: "clamp" }
              );
              const isAgg = i === 3;
              const offsetX = i < 2 ? -180 : 60;
              const offsetY = i % 2 === 0 ? -80 : 50;
              return (
                <ByteGrid
                  key={`contrib-${i}`}
                  bytes={contrib}
                  x={positions[i].x + offsetX}
                  y={positions[i].y + offsetY}
                  opacity={gridOpacity}
                  cellSize={14}
                  cols={8}
                  label={isAgg ? "Agg (has msg)" : `M${i} (zeros)`}
                />
              );
            })}

            <FadeText
              x={960}
              y={880}
              text="Every contribution looks like random noise — indistinguishable!"
              opacity={interpolate(xorP, [0.5, 0.65, 0.95, 1], [0, 1, 1, 0])}
              size={18}
              color={"#e0af68"}
              anchor="middle"
            />
          </g>
        )}

        {/* ── Cancel Scene ────────────────────────────── */}
        {cancelP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={60}
              text="XOR all contributions → pads cancel!"
              opacity={interpolate(cancelP, [0, 0.1, 0.9, 1], [0, 1, 1, 0])}
              size={32}
              color={"#9ece6a"}
              anchor="middle"
              weight="bold"
            />

            {/* Accumulator visualization */}
            {(() => {
              // Show progressive XOR accumulation
              const step = Math.min(3, Math.floor(interpolate(cancelP, [0.1, 0.7], [0, 4], { extrapolateRight: "clamp" })));
              let acc = new Array(MSG_LEN).fill(0);
              for (let i = 0; i <= step; i++) {
                acc = xorArrays(acc, contributions[i]);
              }
              return (
                <g>
                  {/* Show which contributions have been added */}
                  {[0, 1, 2, 3].map((i) => {
                    const done = i <= step;
                    return (
                      <FadeText
                        key={`step-${i}`}
                        x={480}
                        y={180 + i * 50}
                        text={`${done ? "✓" : "·"} ${i === 3 ? "Agg" : `M${i}`} contribution`}
                        opacity={interpolate(cancelP, [0.05 + i * 0.12, 0.15 + i * 0.12], [0, 1], { extrapolateRight: "clamp" })}
                        size={20}
                        color={done ? "#9ece6a" : DIM_COLOR}
                      />
                    );
                  })}

                  {/* Current accumulator state */}
                  <ByteGrid
                    bytes={acc}
                    x={800}
                    y={180}
                    cellSize={28}
                    cols={8}
                    opacity={1}
                    label={step < 3 ? `After ${step + 1} of 4:` : "All 4 XOR'd:"}
                  />

                  {/* Arrow showing it's becoming the message */}
                  {step >= 3 && (
                    <FadeText
                      x={800}
                      y={290}
                      text={`= "${recoveredText}"`}
                      opacity={interpolate(cancelP, [0.75, 0.85], [0, 1], { extrapolateRight: "clamp" })}
                      size={24}
                      color={"#9ece6a"}
                    />
                  )}
                </g>
              );
            })()}

            <FadeText
              x={960}
              y={500}
              text="Each pad(i,j) appears in node i's AND node j's contribution."
              opacity={interpolate(cancelP, [0.3, 0.45, 0.9, 1], [0, 1, 1, 0])}
              size={18}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={540}
              text="X ⊕ X = 0  →  all pads vanish  →  only the message remains."
              opacity={interpolate(cancelP, [0.4, 0.55, 0.9, 1], [0, 1, 1, 0])}
              size={18}
              color={TEXT_COLOR}
              anchor="middle"
            />

            {/* Original message for comparison */}
            <ByteGrid
              bytes={msgBytes}
              x={800}
              y={620}
              cellSize={28}
              cols={8}
              opacity={interpolate(cancelP, [0.7, 0.85, 0.9, 1], [0, 1, 1, 0])}
              label="Original message (for comparison):"
            />
          </g>
        )}

        {/* ── Reveal Scene ────────────────────────────── */}
        {revealP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={200}
              text="Message recovered anonymously"
              opacity={interpolate(revealP, [0, 0.15, 0.85, 1], [0, 1, 1, 0])}
              size={44}
              color={"#9ece6a"}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={290}
              text={`"${MESSAGE}"`}
              opacity={interpolate(revealP, [0.1, 0.25, 0.85, 1], [0, 1, 1, 0])}
              size={36}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={400}
              text="But which node sent it?"
              opacity={interpolate(revealP, [0.2, 0.35, 0.85, 1], [0, 1, 1, 0])}
              size={28}
              color={"#f7768e"}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={470}
              text="All 4 contributions were indistinguishable from random."
              opacity={interpolate(revealP, [0.3, 0.45, 0.85, 1], [0, 1, 1, 0])}
              size={22}
              color={DIM_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={510}
              text="No observer — not even other group members — can identify the sender."
              opacity={interpolate(revealP, [0.35, 0.5, 0.85, 1], [0, 1, 1, 0])}
              size={22}
              color={DIM_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={580}
              text="This is information-theoretic security."
              opacity={interpolate(revealP, [0.45, 0.6, 0.85, 1], [0, 1, 1, 0])}
              size={22}
              color={"#bb9af7"}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={620}
              text="It holds even against adversaries with unlimited computational power."
              opacity={interpolate(revealP, [0.5, 0.65, 0.85, 1], [0, 1, 1, 0])}
              size={18}
              color={DIM_COLOR}
              anchor="middle"
            />
          </g>
        )}

        {/* ── Outro ───────────────────────────────────── */}
        {outroP >= 0 && (
          <g>
            <FadeText
              x={960}
              y={340}
              text="Built on Mosaik"
              opacity={interpolate(outroP, [0, 0.15, 0.85, 1], [0, 1, 1, 0])}
              size={52}
              color={ACCENT}
              anchor="middle"
              weight="bold"
            />
            <FadeText
              x={960}
              y={420}
              text="Self-organizing distributed systems runtime"
              opacity={interpolate(outroP, [0.1, 0.25, 0.85, 1], [0, 1, 1, 0])}
              size={24}
              color={DIM_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={500}
              text="Discovery · Streams · Raft Groups · Replicated Collections"
              opacity={interpolate(outroP, [0.2, 0.35, 0.85, 1], [0, 1, 1, 0])}
              size={20}
              color={TEXT_COLOR}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={580}
              text="github.com/flashbots/mosaik"
              opacity={interpolate(outroP, [0.3, 0.45, 0.85, 1], [0, 1, 1, 0])}
              size={22}
              color={"#9ece6a"}
              anchor="middle"
            />
            <FadeText
              x={960}
              y={700}
              text="8/8 tests passing · 3 mixing rounds · TEE attestation gating"
              opacity={interpolate(outroP, [0.4, 0.55, 0.85, 1], [0, 1, 1, 0])}
              size={16}
              color={DIM_COLOR}
              anchor="middle"
            />
          </g>
        )}
      </svg>
    </div>
  );
};
