export async function fetchProof(uuid) {
  const res = await fetch(`/api/proof/${uuid}`)
  if (!res.ok) throw new Error('Proof not found')
  return res.json()
}
