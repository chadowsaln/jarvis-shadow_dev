import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-test-'));
process.env.ROAMIES_DATA_DIR = tmpDir;

const {
  memorySave,
  memorySemanticSearch,
  memorySearch,
  cosineSimilarity,
  closeMemoryDb,
} = await import('../memory.mjs');

test('Semantic Memory: cosineSimilarity computes exact cosine angle', () => {
  // Identical vectors -> 1.0
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1.0);
  // Orthogonal vectors -> 0.0
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0.0);
  // Opposite vectors -> -1.0
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1.0);
  // Invalid inputs -> 0
  assert.equal(cosineSimilarity(null, [1, 2]), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test('Semantic Memory: save memories with embeddings and rank by semantic similarity', async () => {
  // Save memories in different semantic directions
  const m1 = memorySave({
    category: 'projects',
    title: 'Computer Vision Research',
    content: 'OpenCV and image processing with Python.',
    embedding: [0.9, 0.1, 0.0],
  });

  const m2 = memorySave({
    category: 'projects',
    title: 'Natural Language Processing',
    content: 'Transformers and LLMs for Arabic text translation.',
    embedding: [0.0, 0.9, 0.2],
  });

  const m3 = memorySave({
    category: 'preferences',
    title: 'Coffee preference',
    content: 'Prefers dark roast espresso without sugar.',
    embedding: [0.0, 0.1, 0.9],
  });

  assert.ok(m1.id);
  assert.ok(m2.id);
  assert.ok(m3.id);

  // Search with query vector closest to Vision ([0.8, 0.2, 0.0])
  const queryVec = [0.8, 0.2, 0.0];
  const results = await memorySemanticSearch({
    embedding: queryVec,
    threshold: 0.5,
  });

  assert.ok(results.length >= 1);
  assert.equal(results[0].id, m1.id, 'Top result should be Computer Vision');
  assert.ok(results[0].score > 0.9, 'Score should be high for aligned vector');

  // Search with mock embedFn
  const embedFn = async (text) => {
    if (text.includes('espresso') || text.includes('coffee')) return [0.0, 0.1, 0.9];
    return [0.0, 0.9, 0.2];
  };

  const coffeeResults = await memorySemanticSearch({
    query: 'drinking espresso',
    embedFn,
    threshold: 0.8,
  });

  assert.ok(coffeeResults.length >= 1);
  assert.equal(coffeeResults[0].id, m3.id);

  // Fallback to text search when no vector/embedFn is provided
  const fallback = await memorySemanticSearch({ query: 'Transformers' });
  assert.ok(fallback.length >= 1);
  assert.equal(fallback[0].id, m2.id);

  closeMemoryDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
