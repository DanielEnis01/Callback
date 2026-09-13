import { passwordPolicyMessage } from "./password-policy";

export function authErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "The email or password is incorrect. Please try again.";
    case "auth/email-already-in-use":
      return "Unable to create this account. Try signing in or resetting your password.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "app/invalid-password":
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return passwordPolicyMessage;
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment before trying again.";
    case "auth/network-request-failed":
      return "Unable to connect. Check your internet connection and try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was canceled. Please try again.";
    case "auth/popup-blocked":
      return "Allow pop-ups for this website, then try Google sign-in again.";
    case "auth/account-exists-with-different-credential":
      return "Use your original sign-in method for this email address.";
    case "auth/user-disabled":
      return "This account is unavailable. Please contact support.";
    case "auth/operation-not-allowed":
    case "auth/unauthorized-domain":
    case "auth/invalid-api-key":
    case "auth/configuration-not-found":
      return "This sign-in method is not available yet. Please try again later.";
    default:
      return "Something went wrong. Please try again.";
  }
}
