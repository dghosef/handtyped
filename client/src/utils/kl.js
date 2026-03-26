// KL divergence D_KL(P || Q) using binned histogram with Laplace smoothing
export function klDivergence(p, q) {
  if (!p.length || !q.length) return 0
  const allVals = [...p, ...q]
  const min = Math.min(...allVals)
  const max = Math.max(...allVals)
  if (min === max) return 0

  const BINS = 10
  const binSize = (max - min) / BINS

  function histogram(arr) {
    const counts = new Array(BINS).fill(0)
    arr.forEach(v => {
      const bin = Math.min(BINS - 1, Math.floor((v - min) / binSize))
      counts[bin]++
    })
    return counts.map(c => (c + 1e-10) / arr.length)
  }

  const ph = histogram(p)
  const qh = histogram(q)

  return ph.reduce((sum, pi, i) => sum + pi * Math.log(pi / qh[i]), 0)
}
