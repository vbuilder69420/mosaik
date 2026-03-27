// Simplified DC-net math for visualization
// Uses a simple seeded PRNG instead of blake3

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function hashPair(a: number, b: number, round: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return ((lo * 7919 + hi * 104729 + round * 15485863) & 0xffffffff) >>> 0;
}

export function derivePad(
  nodeA: number,
  nodeB: number,
  round: number,
  len: number
): number[] {
  const seed = hashPair(nodeA, nodeB, round);
  const rng = seededRandom(seed);
  return Array.from({ length: len }, () => Math.floor(rng() * 256));
}

export function xorArrays(a: number[], b: number[]): number[] {
  return a.map((v, i) => v ^ (b[i] ?? 0));
}

export function computeContribution(
  myId: number,
  allIds: number[],
  round: number,
  message: number[],
): number[] {
  let result = [...message];
  for (const peerId of allIds) {
    if (peerId === myId) continue;
    const pad = derivePad(myId, peerId, round, message.length);
    result = xorArrays(result, pad);
  }
  return result;
}

export function stringToBytes(s: string, len: number): number[] {
  const bytes = Array.from(s).map((c) => c.charCodeAt(0));
  const padded = new Array(len).fill(0);
  for (let i = 0; i < bytes.length && i < len; i++) {
    padded[i] = bytes[i];
  }
  return padded;
}

export function bytesToString(bytes: number[]): string {
  const end = bytes.indexOf(0);
  const slice = end >= 0 ? bytes.slice(0, end) : bytes;
  return slice.map((b) => String.fromCharCode(b)).join("");
}
