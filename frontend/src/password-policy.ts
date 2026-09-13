export const passwordRequirements = [
  { id: "length", label: "At least 8 characters", test: (value: string) => value.length >= 8 },
  { id: "uppercase", label: "One uppercase letter (A–Z)", test: (value: string) => /[A-Z]/.test(value) },
  { id: "lowercase", label: "One lowercase letter (a–z)", test: (value: string) => /[a-z]/.test(value) },
  { id: "number", label: "One number (0–9)", test: (value: string) => /[0-9]/.test(value) },
];

export const passwordPattern = "(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{8,}";
export const passwordPolicyMessage = "Use at least 8 characters, including an uppercase letter, a lowercase letter, and a number.";

export function isValidPassword(password: string): boolean {
  return passwordRequirements.every((requirement) => requirement.test(password));
}

export function assertValidPassword(password: string): void {
  if (!isValidPassword(password)) {
    throw Object.assign(new Error(passwordPolicyMessage), { code: "app/invalid-password" });
  }
}
