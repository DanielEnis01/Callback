import { Dashboard } from "./Dashboard";

/**
 * The current desktop build is a static demo. It starts in the practice
 * dashboard without requiring Firebase. The Firebase UI and services remain
 * in the project for the later account-integration pass.
 */
export default function App() {
  return <Dashboard onLogout={() => undefined} />;
}
