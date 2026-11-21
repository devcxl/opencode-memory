const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * 将中英文与代码标识符混合文本切分为适合 BM25 的词元列表：
 * - ASCII 标识符（保留完整小写 token，同时按 camelCase / `_` / `-` / `.` 拆分）
 * - CJK 汉字（保留单字与双字 bigram）
 */
export function tokenizeForBm25(text: string): string[] {
  const tokens: string[] = [];
  if (!text) return tokens;

  const asciiMatches = text.match(/[A-Za-z0-9_.-]+/g);
  if (asciiMatches) {
    for (const raw of asciiMatches) {
      const lower = raw.toLowerCase();
      tokens.push(lower);

      const subParts = raw
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[_\-.\s]+/)
        .map((p) => p.toLowerCase())
        .filter((p) => p.length > 0);

      if (subParts.length > 1) {
        for (const part of subParts) {
          if (part !== lower) {
            tokens.push(part);
          }
        }
      }
    }
  }

  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]);
        if (i + 1 < run.length) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    }
  }

  return tokens;
}

export interface Bm25Document {
  text: string;
  heading?: string;
}

export interface Bm25ScoredResult<T extends Bm25Document> {
  doc: T;
  rawScore: number;
  /** 经反饱和映射后的归一化得分，范围 [0, 1) */
  score: number;
}

/**
 * 对候选文档执行 Okapi BM25 打分（k1=1.5, b=0.75），
 * 并用 score = raw / (1 + raw) 做反饱和归一化。
 */
export function scoreBm25Documents<T extends Bm25Document>(
  query: string,
  docs: T[],
): Array<Bm25ScoredResult<T>> {
  const queryTerms = Array.from(new Set(tokenizeForBm25(query)));
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const k1 = 1.5;
  const b = 0.75;

  const docTermFreqs: Array<Map<string, number>> = [];
  const docLengths: number[] = [];
  const docFreq = new Map<string, number>();

  let totalLength = 0;
  for (const doc of docs) {
    const combined = doc.heading ? `${doc.heading}\n${doc.text}` : doc.text;
    const tokens = tokenizeForBm25(combined);
    const tf = new Map<string, number>();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    docTermFreqs.push(tf);
    docLengths.push(tokens.length);
    totalLength += tokens.length;

    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const avgDocLength = totalLength / docs.length || 1;
  const n = docs.length;
  const results: Array<Bm25ScoredResult<T>> = [];

  for (let i = 0; i < docs.length; i++) {
    const tf = docTermFreqs[i];
    const dl = docLengths[i];
    if (dl === 0) continue;

    let rawScore = 0;
    for (const term of queryTerms) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;

      const df = docFreq.get(term) ?? 0;
      const idf = Math.max(1.0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
      const num = freq * (k1 + 1);
      const den = freq + k1 * (1 - b + (b * dl) / avgDocLength);
      rawScore += idf * (num / den);
    }

    if (rawScore > 0) {
      results.push({
        doc: docs[i],
        rawScore,
        score: rawScore / (1 + rawScore),
      });
    }
  }

  results.sort((a, bResult) => bResult.score - a.score);
  return results;
}

/**
 * 计算分层时间衰减乘子：
 * - MEMORY.md / USER.md / IDENTITY.md 等常驻文件为 evergreen（返回 1.0，永不衰减）
 * - daily/YYYY-MM-DD.md 按半衰期（默认 30 天）指数衰减
 */
export function computeTemporalDecayMultiplier(
  filePath: string,
  timestamp?: string,
  nowMs: number = Date.now(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  const dailyMatch = filePath.match(
    /(?:^|[\\/])daily[\\/](\d{4}-\d{2}-\d{2})\.md$/,
  );
  if (!dailyMatch) {
    return 1.0;
  }

  const dateStr = dailyMatch[1] ?? timestamp?.slice(0, 10);
  if (!dateStr) return 1.0;

  const parsedMs = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(parsedMs)) return 1.0;

  const ageDays = Math.max(0, (nowMs - parsedMs) / MS_PER_DAY);
  return Math.exp(-(Math.LN2 / halfLifeDays) * ageDays);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 轻量 MMR（Maximal Marginal Relevance）多样性重排：
 * 在保持高分相关性的同时抑制高度重复片段扎堆霸榜。
 */
export function applyMmrDeduplication<
  T extends { text: string; score: number },
>(items: T[], maxResults: number, lambda: number = 0.7): T[] {
  if (items.length <= 1 || maxResults <= 1) {
    return items.slice(0, maxResults);
  }

  const sorted = [...items].sort((a, b) => b.score - a.score);
  const maxScore = Math.max(sorted[0].score, 1e-9);
  const tokenSets = sorted.map((item) => new Set(tokenizeForBm25(item.text)));

  const selectedIndices: number[] = [0];
  const remaining = new Set<number>(
    Array.from({ length: sorted.length - 1 }, (_, i) => i + 1),
  );

  while (selectedIndices.length < maxResults && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const candidateIdx of remaining) {
      const relevance = sorted[candidateIdx].score / maxScore;
      let maxSim = 0;
      for (const selIdx of selectedIndices) {
        const sim = jaccardSimilarity(
          tokenSets[candidateIdx],
          tokenSets[selIdx],
        );
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = candidateIdx;
      }
    }

    if (bestIdx === -1) break;
    selectedIndices.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selectedIndices.map((idx) => sorted[idx]);
}
