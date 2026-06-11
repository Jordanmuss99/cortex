// benchmark_dg.ts
const INPUT_DIM = 1024;
const EXPANDED_DIM = 4096;

function generateProjectionMatrix(): Float32Array {
  const matrix = new Float32Array(INPUT_DIM * EXPANDED_DIM);
  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = Math.random();
  }
  return matrix;
}

const W = generateProjectionMatrix();
const denseEmbedding = new Array(INPUT_DIM).fill(0).map(() => Math.random());

// Original (Column-Major loop order) as currently implemented in src/hippocampus/dentate-gyrus.ts
function originalEncoding() {
  const z = new Float32Array(EXPANDED_DIM);
  for (let j = 0; j < EXPANDED_DIM; j++) {
    let sum = 0;
    const offset = j;
    // Jumps by 4096 (16KB) every iteration -> cache misses
    for (let i = 0; i < INPUT_DIM; i++) {
      sum += denseEmbedding[i] * W[i * EXPANDED_DIM + offset];
    }
    z[j] = sum;
  }
  return z;
}

// Optimized (Row-Major loop order) reading contiguous memory
function optimizedEncoding() {
  const z = new Float32Array(EXPANDED_DIM);
  for (let i = 0; i < INPUT_DIM; i++) {
    const val = denseEmbedding[i];
    const offset = i * EXPANDED_DIM;
    // Reads contiguous memory W[offset + j] -> cache hits
    for (let j = 0; j < EXPANDED_DIM; j++) {
      z[j] += val * W[offset + j];
    }
  }
  return z;
}

const iter = 1000;

console.log(`Running benchmark with ${iter} iterations...`);

const startOriginal = performance.now();
for (let i = 0; i < iter; i++) {
  originalEncoding();
}
const endOriginal = performance.now();
console.log(`Original DG Encode (Column-Major): ${(endOriginal - startOriginal).toFixed(2)}ms`);

const startOptimized = performance.now();
for (let i = 0; i < iter; i++) {
  optimizedEncoding();
}
const endOptimized = performance.now();
console.log(`Optimized DG Encode (Row-Major): ${(endOptimized - startOptimized).toFixed(2)}ms`);

console.log(`Speedup: ${((endOriginal - startOriginal) / (endOptimized - startOptimized)).toFixed(2)}x faster`);
