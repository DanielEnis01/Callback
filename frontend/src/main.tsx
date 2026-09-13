import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// No React.StrictMode here: it deliberately double-invokes effects in dev
// (mount -> cleanup -> mount) to surface impure effects, but
// usePresageSession's effect owns a real native camera/SDK session
// (SmartSpectra) that isn't safe to tear down and immediately recreate —
// the main process treats it as a singleton, so the second mount's
// sdk.start() fails with "session already started" and the first mount's
// stream gets stopped by the discarded cleanup, producing an ended/black
// stream. Dropping StrictMode makes the effect run exactly once, which is
// what a stateful native session like this needs.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
