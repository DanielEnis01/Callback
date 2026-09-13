export function derivePosition(session) {
  return session.positionLabel?.trim() || session.jobPostingText?.split(/\n/).find((line) => line.trim())?.trim().slice(0, 120) || "Interview practice";
}
