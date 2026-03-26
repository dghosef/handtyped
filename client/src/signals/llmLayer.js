export async function llmTieBreak(editProfile, finalText) {
  try {
    const res = await fetch('/api/llm-tiebreak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        edits: {
          typoCorrections: editProfile.typoCorrections,
          lexicalSubs: editProfile.lexicalSubs,
          structuralRewrites: editProfile.structuralRewrites,
          ideationalRevisions: editProfile.ideationalRevisions,
          meaningfulEditRate: editProfile.meaningfulEditRate,
          pauseEditKL: editProfile.pauseEditKL
        },
        finalText: finalText.slice(0, 2000)
      })
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
