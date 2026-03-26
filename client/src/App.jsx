import { Routes, Route } from 'react-router-dom'
import EditorPage from './editor/EditorPage'
import ProofPage from './proof/ProofPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EditorPage />} />
      <Route path="/proof/:uuid" element={<ProofPage />} />
    </Routes>
  )
}
