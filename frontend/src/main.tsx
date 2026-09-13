import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// StrictMode is deliberately off: it double-invokes every effect once in
// dev (mount -> cleanup -> mount again) to catch missing/incomplete
// cleanup. usePresageSession.ts's and useCalibrationSession.ts's cleanup
// calls sdk.stop() without awaiting it, so the remount's sdk.start() fires
// before the native SmartSpectra session (one per process, see
// node_modules/@smartspectra/node-sdk's own comments) has actually torn
// down -- the native engine then rejects the second start with "session
// already started (run_file or start_custom called)" and the camera never
// comes up. Real fix would be to serialize start/stop in those hooks; for
// now this SDK just doesn't tolerate StrictMode's remount.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
)
